import Combine
import SwiftUI
import UIKit
import ClockOffCore

/// Root state of the app: which flow is showing, the cached state the tabs read, and the live Work Mode state
/// (`WorkModeController`). Owns the sync triggers (launch, foreground, pull-to-refresh, connectivity) and
/// routes breaks, setup repair, leave and sign-out.
@MainActor
final class AppModel: ObservableObject {
    enum Route: Equatable {
        case launching
        case onboarding
        case main
    }

    static let reasonSync = "SYNC"
    static let reasonRepair = "REPAIR"
    static let reasonWipe = "WIPE"

    @Published private(set) var route: Route = .launching
    @Published private(set) var cachedState = CachedState()
    @Published private(set) var isSyncing = false
    @Published private(set) var lastSyncError: APIError?
    @Published private(set) var isOnline = true
    /// Shown once on the Welcome screen after the server ended this device's session.
    @Published var sessionEndedMessage: String?
    @Published private(set) var onboarding: OnboardingViewModel?
    /// The setup-repair flow (permission or app selection regressed), presented as a sheet.
    @Published var repair: OnboardingViewModel?
    /// One-off notice after a sync (an offline break the server refused).
    @Published var notice: String?

    let container: DependencyContainer
    /// The live Work Mode state; `start()` once the phone is set up, `stop()` on leave/sign-out.
    let controller: WorkModeController
    private let now: () -> Date
    private var started = false
    private var cancellables: Set<AnyCancellable> = []
    private var permissionAttentionNotified = false

    init(container: DependencyContainer, controller: WorkModeController? = nil, now: @escaping () -> Date = Date.init) {
        self.container = container
        self.controller = controller ?? WorkModeController(container: container)
        self.now = now
        self.controller.objectWillChange
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &cancellables)
        self.controller.$state
            .removeDuplicates()
            .dropFirst()
            .sink { [weak self] state in self?.workStateDidChange(state) }
            .store(in: &cancellables)
    }

    // MARK: Derived

    var isUsingMockRestrictions: Bool { container.isUsingMockRestrictions }
    var permissionState: PermissionState {
        container.restrictionProvider.authorizationStatus.permissionState(previous: cachedState.lastPermissionState)
    }
    var hasSelection: Bool { container.restrictionProvider.hasSelection() }
    var selectionCounts: SelectionCounts { container.restrictionProvider.selectionCounts() }
    var hasBreakKeptSelection: Bool { container.selectionStatus.hasSelection(.breakKept) }
    var breakKeptSelectionCounts: SelectionCounts { container.selectionStatus.counts(.breakKept) }
    /// True when the resolved policies relax only some categories on breaks (a second selection is needed).
    var policyNeedsBreakKeptSelection: Bool {
        guard let policy = cachedState.policy else { return false }
        return RestrictionPlan.make(shiftId: "", policy: policy, breakPolicy: cachedState.breakPolicy).requiresBreakSubsetSelection
    }
    /// The employee must pick apps unless the policy says the selection is optional.
    var selectionRequired: Bool { cachedState.policy?.restrictionConfig.requireEmployeeAppSelection ?? true }
    /// Permission or selection regressed since setup: offer "Setup Repair" on Home and in Settings.
    var setupNeedsRepair: Bool {
        !permissionState.isApproved || (selectionRequired && !hasSelection)
    }
    var workState: UIWorkState { controller.state }
    var homeCard: HomeCardModel {
        HomeCardModel.make(state: controller.state, cache: cachedState, now: now(), timeZone: container.deviceInfo.timeZone)
    }
    /// "Last synced 2h ago · changes will apply when online" after an hour without a successful sync.
    var staleBanner: String? { SyncStaleness.banner(lastSyncAt: cachedState.lastSyncAt, now: now()) }
    /// "Work Mode should be active — tap to repair" when the last reconcile could not prove the shields.
    var repairPrompt: HomeRepairPrompt? { HomeRepairPrompt.make(outcome: controller.lastOutcome) }
    var needsBreakSelection: Bool { controller.needsBreakSelection }

    // MARK: Lifecycle

    /// Chooses the first screen from the cache and Keychain, then (for a set-up phone) starts the controller and syncs.
    func start() {
        guard !started else { return }
        started = true
        if let api = container.api as? APIClient {
            api.onAuthenticationLost = { [weak self] in
                Task { @MainActor in self?.handleSessionEnded() }
            }
        }
        loadRoute()
        if route == .main { startMain(reason: .launch) }
    }

    /// Reads the cache and Keychain and picks the first screen. No network, no side effects.
    func loadRoute() {
        reloadCache()
        routeFromState()
    }

    /// Mounts the live state (`WorkModeController.start()` reconciles from the cache at once), registers for
    /// silent pushes and background refresh, watches connectivity, then syncs.
    private func startMain(reason: SyncReason) {
        controller.start()
        isOnline = container.connectivity.isOnline
        container.connectivity.start { [weak self] online in
            Task { @MainActor in self?.connectivityChanged(online) }
        }
        if !AppRuntime.isRunningUnitTests {
            // System services the hosted unit tests must not touch (APNs, BGTaskScheduler).
            UIApplication.shared.registerForRemoteNotifications()
            BackgroundRefresh.schedule()
        }
        Task { await refresh(reason: reason) }
    }

    func scenePhaseChanged(_ phase: ScenePhase) {
        guard started else { return }
        switch phase {
        case .active:
            // The controller re-checks the shields itself on didBecomeActive; this refreshes the schedule.
            if route == .main { Task { await refresh(reason: .foreground) } }
        case .background:
            if route == .main, !AppRuntime.isRunningUnitTests { BackgroundRefresh.schedule() }
        case .inactive:
            break
        @unknown default:
            break
        }
    }

    private func connectivityChanged(_ online: Bool) {
        isOnline = online
        guard online, route == .main else { return }
        Task { await refresh(reason: .connectivity) }
    }

    /// Runs `SyncCoordinator.sync()`, then lets the controller re-check the shields against the fresh cache.
    func refresh(reason: SyncReason) async {
        isSyncing = true
        let outcome = await container.syncCoordinator.sync(reason: reason)
        isSyncing = false
        lastSyncError = outcome.error
        reloadCache()
        if route == .main { controller.reconcile(reason: AppModel.reasonSync) }
        if let dropped = outcome.breakReplay.dropped.first {
            notice = "Your break taken offline wasn't accepted by your workplace: \(dropped.message)"
        }
        if let error = outcome.error, error.isAuthenticationFailure, error.code != .notSignedIn {
            handleSessionEnded()
        }
    }

    // MARK: Breaks and repair

    /// Home › Start Break. Throws `BreakRefusal` (cached policy) or `APIError` (server refusal).
    @discardableResult
    func startBreak(requestedDurationMinutes: Int? = nil) async throws -> BreakSession {
        let session = try await controller.startBreak(requestedDurationMinutes: requestedDurationMinutes)
        reloadCache()
        await container.syncCoordinator.replanNotifications()
        return session
    }

    /// Home › End Break Early.
    func endBreakEarly() async throws {
        try await controller.endBreakEarly()
        reloadCache()
        await container.syncCoordinator.replanNotifications()
    }

    /// "Work Mode should be active — tap to repair": re-run the reconcile now.
    func repairEnforcement() {
        controller.reconcile(reason: AppModel.reasonRepair)
        reloadCache()
    }

    /// Presents the "keep blocked on breaks" picker (RELAX_CATEGORIES policies). False when unavailable.
    @discardableResult
    func chooseBreakKeptApps() -> Bool {
        guard let configurator = container.selectionConfigurator else { return false }
        do {
            _ = try configurator.configureSelection(kind: .breakKept)
            return true
        } catch {
            ClockOffLog.app.error("break selection failed: \(String(describing: error), privacy: .public)")
            return false
        }
    }

    /// Home › Open Setup / Settings › Repair: re-runs screens 6–7 for what regressed.
    func openSetupRepair() {
        let step = OnboardingResume.repairStep(authorised: permissionState.isApproved, hasSelection: hasSelection)
        repair = makeOnboarding(mode: .repair, startAt: step) { [weak self] in self?.repairFinished() }
    }

    func dismissRepair() {
        repair = nil
    }

    private func repairFinished() {
        repair = nil
        reloadCache()
        controller.reconcile(reason: AppModel.reasonRepair)
        Task { await refresh(reason: .repair) }
    }

    // MARK: Onboarding

    func onboardingFinished() {
        reloadCache()
        onboarding = nil
        container.onboardingProgress.clear()
        route = .main
        startMain(reason: .setup)
    }

    private func makeOnboarding(mode: OnboardingViewModel.Mode, startAt step: OnboardingViewModel.Step, onFinished: @escaping () -> Void) -> OnboardingViewModel {
        OnboardingViewModel(
            dependencies: OnboardingViewModel.Dependencies(
                api: container.api,
                cache: container.cache,
                outbox: container.outbox,
                provider: container.restrictionProvider,
                selectionConfigurator: container.selectionConfigurator,
                selectionStatus: container.selectionStatus,
                deviceInfo: container.deviceInfo,
                syncCoordinator: container.syncCoordinator,
                notifications: container.notifications,
                progress: mode == .setup ? container.onboardingProgress : nil,
                isSimulated: container.isUsingMockRestrictions
            ),
            mode: mode,
            initialStep: step,
            now: now,
            onFinished: onFinished
        )
    }

    // MARK: Leave / sign out

    /// Settings → Leave Workplace: lifts every restriction on this phone (clearRestrictions,
    /// cancelAllActivities), forgets the schedule (cache + plans.json + selections + notifications), then
    /// unlinks the device on the server (POST /leave-workplace) and deletes the tokens. Local cleanup happens
    /// even when the request fails (the employee asked to leave); the error is rethrown so the UI can say the
    /// server was not told.
    func leaveWorkplace() async throws {
        // Lift everything on the phone first, so leaving takes effect even if the server is unreachable.
        controller.stop()
        try? container.restrictionProvider.clearRestrictions()
        container.restrictionProvider.cancelAllActivities()
        try? container.plans.clear()
        try? container.cache.wipe()
        var serverError: Error?
        do {
            try await container.api.leaveWorkplace()
        } catch {
            serverError = error
        }
        // Again after the request, in case a sync that was already running re-populated anything.
        await wipeLocalState()
        if let serverError, (serverError as? APIError)?.isAuthenticationFailure != true {
            throw serverError
        }
    }

    /// Settings → Sign Out: revokes this device's tokens, lifts restrictions and returns to Welcome.
    func signOut() async {
        try? await container.api.logout()
        await wipeLocalState()
    }

    /// The server rejected this device (deactivated, unlinked, or token reuse): stop enforcing and rejoin.
    func handleSessionEnded() {
        guard route != .onboarding else { return }
        Task {
            await wipeLocalState()
            sessionEndedMessage = "This phone is no longer connected to your workplace. Join again with your company code, or contact your manager."
        }
    }

    private func wipeLocalState() async {
        controller.stop()
        container.connectivity.stop()
        try? container.restrictionProvider.clearRestrictions()
        container.restrictionProvider.cancelAllActivities()
        try? container.plans.clear()
        try? container.cache.wipe()
        try? container.tokenStore.deleteTokens()
        try? SelectionStore(fileStore: container.fileStore).removeAll()
        container.sharedFlags?.clearAll()
        container.syncMetadata.clear()
        container.onboardingProgress.clear()
        await container.notifications.cancelAll()
        #if DEBUG_MOCK_RESTRICTIONS
        (container.restrictionProvider as? MockRestrictionProvider)?.reset()
        #endif
        lastSyncError = nil
        repair = nil
        notice = nil
        reloadCache()
        routeFromState()
        // Not joined any more: the controller publishes `.unknown` (and arms no timer).
        controller.reconcile(reason: AppModel.reasonWipe)
    }

    // MARK: Private

    private func reloadCache() {
        cachedState = container.cache.load() ?? CachedState()
    }

    private func routeFromState() {
        let joined = container.api.hasCredentials() && cachedState.isJoined
        let step = OnboardingResume.step(
            joined: joined,
            setupCompleted: cachedState.setupCompletedAt != nil,
            persisted: container.onboardingProgress.step,
            authorised: permissionState.isApproved,
            hasSelection: hasSelection
        )
        if let step {
            onboarding = makeOnboarding(mode: .setup, startAt: step) { [weak self] in self?.onboardingFinished() }
            route = .onboarding
        } else {
            onboarding = nil
            route = .main
        }
    }

    /// The controller changed state (a boundary passed, a break started or ended, permission changed): refresh
    /// the cache the tabs read, re-plan the local notifications and, once per regression, tell the employee
    /// that Screen Time access needs attention.
    private func workStateDidChange(_ state: UIWorkState) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.reloadCache()
            await self.container.syncCoordinator.replanNotifications()
            if case .actionRequired(.screenTimeNotAllowed(let permission)) = state, permission == .denied || permission == .revoked {
                guard !self.permissionAttentionNotified else { return }
                self.permissionAttentionNotified = true
                let notice = NotificationPlanner.permissionAttention()
                await self.container.notifications.postNow(id: NotificationPlanner.permissionAttentionIdentifier, title: notice.title, body: notice.body)
            } else {
                self.permissionAttentionNotified = false
            }
        }
    }
}
