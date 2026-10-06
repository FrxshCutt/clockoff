import SwiftUI
import UIKit
import WorkModeCore

/// Root state of the app: which flow is showing and the latest cached/derived state for the main tabs.
@MainActor
final class AppModel: ObservableObject {
    enum Route: Equatable {
        case launching
        case onboarding
        case main
    }

    @Published private(set) var route: Route = .launching
    @Published private(set) var cachedState = CachedState()
    @Published private(set) var expectedState: ExpectedState?
    @Published private(set) var isSyncing = false
    @Published private(set) var lastSyncError: APIError?
    /// Shown once on the Welcome screen after the server ended this device's session.
    @Published var sessionEndedMessage: String?
    @Published private(set) var onboarding: OnboardingViewModel?

    let container: DependencyContainer
    private let now: () -> Date
    private var started = false

    init(container: DependencyContainer, now: @escaping () -> Date = Date.init) {
        self.container = container
        self.now = now
    }

    var isUsingMockRestrictions: Bool { container.isUsingMockRestrictions }
    var permissionState: PermissionState {
        container.restrictionProvider.authorizationStatus.permissionState(previous: cachedState.lastPermissionState)
    }
    var hasSelection: Bool { container.restrictionProvider.hasSelection() }
    var selectionCounts: SelectionCounts { container.restrictionProvider.selectionCounts() }

    var homeCard: HomeCard {
        HomeCard.make(
            expected: expectedState,
            cache: cachedState,
            permission: permissionState,
            hasSelection: hasSelection,
            now: now(),
            timeZone: container.deviceInfo.timeZone
        )
    }

    // MARK: Lifecycle

    /// Chooses the first screen from the cache and Keychain, then syncs.
    func start() {
        guard !started else { return }
        started = true
        if let api = container.api as? APIClient {
            api.onAuthenticationLost = { [weak self] in
                Task { @MainActor in self?.handleSessionEnded() }
            }
        }
        loadRoute()
        if route == .main {
            UIApplication.shared.registerForRemoteNotifications()
            BackgroundRefresh.schedule()
            Task { await refresh(reason: .launch) }
        }
    }

    /// Reads the cache and Keychain, picks the first screen and, for a set-up phone, shows what the saved
    /// schedule says straight away (the launch sync then refreshes it). No network, no side effects.
    func loadRoute() {
        reloadCache()
        routeFromState()
        if route == .main { evaluateCachedSchedule() }
    }

    func scenePhaseChanged(_ phase: ScenePhase) {
        guard started else { return }
        switch phase {
        case .active:
            if route == .main {
                evaluateCachedSchedule()
                Task { await refresh(reason: .foreground) }
            }
        case .background:
            if route == .main { BackgroundRefresh.schedule() }
        case .inactive:
            break
        @unknown default:
            break
        }
    }

    /// Runs `SyncCoordinator.sync()` and publishes the result (pull-to-refresh, launch, foreground).
    func refresh(reason: SyncReason) async {
        isSyncing = true
        let outcome = await container.syncCoordinator.sync(reason: reason)
        isSyncing = false
        lastSyncError = outcome.error
        expectedState = outcome.expectedState
        reloadCache()
        if let error = outcome.error, error.isAuthenticationFailure, error.code != .notSignedIn {
            handleSessionEnded()
        }
    }

    /// Called about every 30 seconds while Home is visible. When the saved schedule says the state has
    /// changed (a shift or break started or ended while the app is open), enforce it now from the cache —
    /// DeviceActivity covers the app being closed; this covers it being open, and the simulator's mock.
    func tick() async {
        guard route == .main, !isSyncing else { return }
        let previous = expectedState
        evaluateCachedSchedule()
        guard let current = expectedState, previous.map({ AppModel.hasChanged(from: $0, to: current) }) ?? true else { return }
        let outcome = await container.syncCoordinator.enforceFromCache()
        expectedState = outcome.expectedState
        reloadCache()
    }

    /// True when the parts of the expected state that change what is enforced or shown differ.
    static func hasChanged(from old: ExpectedState, to new: ExpectedState) -> Bool {
        old.state != new.state
            || old.effectiveRestriction != new.effectiveRestriction
            || old.activeBreak?.id != new.activeBreak?.id
            || old.activeOverride?.id != new.activeOverride?.id
            || old.activeShift?.id != new.activeShift?.id
    }

    /// Recomputes the expected state from the cache with the on-device engine (pure, no side effects).
    private func evaluateCachedSchedule() {
        let engine = WorkModeEngine(options: .forPolicy(cachedState.policy), timezone: container.deviceInfo.timeZone.identifier)
        expectedState = engine.computeExpectedState(
            now: now(),
            shifts: cachedState.shifts,
            breakSessions: cachedState.breakSessions,
            overrides: cachedState.activeOverrides,
            permissionState: permissionState
        )
    }

    // MARK: Onboarding

    func onboardingFinished() {
        reloadCache()
        onboarding = nil
        route = .main
        UIApplication.shared.registerForRemoteNotifications()
        BackgroundRefresh.schedule()
        Task { await refresh(reason: .setup) }
    }

    private func makeOnboarding(startAt step: OnboardingViewModel.Step) -> OnboardingViewModel {
        OnboardingViewModel(
            dependencies: OnboardingViewModel.Dependencies(
                api: container.api,
                cache: container.cache,
                outbox: container.outbox,
                provider: container.restrictionProvider,
                selectionConfigurator: container.selectionConfigurator,
                deviceInfo: container.deviceInfo,
                syncCoordinator: container.syncCoordinator
            ),
            initialStep: step,
            onFinished: { [weak self] in self?.onboardingFinished() }
        )
    }

    // MARK: Leave / sign out

    /// Settings → Leave Workplace: lifts every restriction on this phone (clearRestrictions,
    /// cancelAllActivities), forgets the schedule (cache + plans.json), then unlinks the device on the server
    /// (POST /leave-workplace) and deletes the tokens. Local cleanup happens even when the request fails (the
    /// employee asked to leave); the error is rethrown so the UI can say the server was not told.
    func leaveWorkplace() async throws {
        // Lift everything on the phone first, so leaving takes effect even if the server is unreachable.
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
        try? container.restrictionProvider.clearRestrictions()
        container.restrictionProvider.cancelAllActivities()
        try? container.plans.clear()
        try? container.cache.wipe()
        try? container.tokenStore.deleteTokens()
        #if DEBUG_MOCK_RESTRICTIONS
        (container.restrictionProvider as? MockRestrictionProvider)?.reset()
        #endif
        expectedState = nil
        lastSyncError = nil
        reloadCache()
        routeFromState()
    }

    // MARK: Private

    private func reloadCache() {
        cachedState = container.cache.load() ?? CachedState()
    }

    private func routeFromState() {
        let joined = container.api.hasCredentials() && cachedState.isJoined
        if joined && cachedState.setupCompletedAt != nil {
            onboarding = nil
            route = .main
        } else {
            let step: OnboardingViewModel.Step = joined ? .screenTimeExplained : .welcome
            onboarding = makeOnboarding(startAt: step)
            route = .onboarding
        }
    }
}
