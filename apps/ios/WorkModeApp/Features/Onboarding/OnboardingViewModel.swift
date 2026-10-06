import Combine
import Foundation
import WorkModeCore

/// Drives onboarding screens 1–8 (`mode == .setup`) and the "Setup Repair" flow (`mode == .repair`, screens 6–7
/// only) when Screen Time access or the app selection regressed after setup.
@MainActor
final class OnboardingViewModel: ObservableObject, Identifiable {
    enum Step: Int, CaseIterable, Comparable {
        case welcome
        case name
        case joinWorkplace
        case confirmIdentity
        case screenTimeExplained
        case authorise
        case chooseApps
        case confirmPolicy

        static func < (lhs: Step, rhs: Step) -> Bool { lhs.rawValue < rhs.rawValue }
    }

    enum Mode: Equatable {
        /// First-time setup: ends with SETUP_COMPLETED and the Home tab.
        case setup
        /// Re-runs authorisation and/or app selection; ends with a `/device/state` check-in.
        case repair
    }

    /// What the last Screen Time authorisation attempt produced (screen 6).
    enum AuthorisationOutcome: Equatable {
        case notRequested
        case approved
        /// The employee declined (or access was turned off in Settings): offer "Open Settings" and "Try again".
        case denied
        /// The request failed or was dismissed without an answer: offer "Try again".
        case failed
    }

    struct Dependencies {
        let api: MobileAPI
        let cache: StateCache
        let outbox: EventOutbox
        let provider: AppRestrictionProvider
        let selectionConfigurator: SelectionConfiguring?
        let selectionStatus: SelectionStatusProviding
        let deviceInfo: DeviceInfoProviding
        let syncCoordinator: SyncCoordinator
        var notifications: LocalNotificationScheduling? = nil
        /// Persists the furthest step (setup mode only) so a relaunch resumes there.
        var progress: OnboardingProgressStore? = nil
        /// True with `MockRestrictionProvider`: the pickers are replaced by "Simulate selection" buttons.
        var isSimulated = false
    }

    let id = UUID()
    let mode: Mode

    @Published private(set) var step: Step
    @Published var firstName = ""
    @Published var lastName = ""
    /// Always holds the auto-formatted value (see `updateCompanyCode`).
    @Published private(set) var companyCode = ""
    @Published var hasEmployeeCode = false
    @Published var employeeCode = ""
    @Published private(set) var lookupResult: JoinLookupResponse?
    @Published private(set) var isWorking = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var policy: PolicySummary?
    @Published private(set) var breakPolicy: BreakPolicy?
    @Published private(set) var policyLoadFailed = false
    @Published private(set) var isLoadingPolicy = false
    @Published private(set) var authorisation: AuthorisationOutcome = .notRequested
    @Published private(set) var hasSelection = false
    @Published private(set) var hasBreakKeptSelection = false
    /// Set when Continue was tapped on screen 7 with something missing ("Selection incomplete").
    @Published private(set) var selectionIncompleteShown = false

    private let deps: Dependencies
    private let onFinished: () -> Void
    private let now: () -> Date
    private var observers: [NSObjectProtocol] = []

    init(
        dependencies: Dependencies,
        mode: Mode = .setup,
        initialStep: Step = .welcome,
        now: @escaping () -> Date = Date.init,
        onFinished: @escaping () -> Void
    ) {
        deps = dependencies
        self.mode = mode
        step = initialStep
        self.now = now
        self.onFinished = onFinished
        if let cached = dependencies.cache.load() {
            firstName = cached.employee?.firstName ?? ""
            lastName = cached.employee?.lastName ?? ""
            policy = cached.policy
            breakPolicy = cached.breakPolicy
        }
        if dependencies.provider.authorizationStatus == .approved { authorisation = .approved }
        refreshSelectionState()
        // Apple's picker saves asynchronously (a sheet); the mock saves at once. Either way the save is announced.
        observers.append(NotificationCenter.default.addObserver(forName: .workModeSelectionDidChange, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.refreshSelectionState() }
        })
    }

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    // MARK: Derived

    var trimmedFirstName: String { firstName.trimmingCharacters(in: .whitespacesAndNewlines) }
    var trimmedLastName: String { lastName.trimmingCharacters(in: .whitespacesAndNewlines) }
    var canSubmitName: Bool { !trimmedFirstName.isEmpty && !trimmedLastName.isEmpty }
    var normalisedCompanyCode: String { CompanyCode.normalise(companyCode) }
    var normalisedEmployeeCode: String { EmployeeCode.normalise(employeeCode) }
    var canLookUp: Bool {
        !isWorking && CompanyCode.isValid(normalisedCompanyCode) && (!hasEmployeeCode || EmployeeCode.isValid(normalisedEmployeeCode))
    }
    var preview: EmployeePreview? { lookupResult?.employeePreview }
    var workplaceName: String? { lookupResult?.organisation.name ?? deps.cache.load()?.organisation?.name }
    var employeeName: String? { deps.cache.load()?.employee?.fullName }
    var authorizationStatus: RestrictionAuthorizationStatus { deps.provider.authorizationStatus }
    var isAuthorised: Bool { deps.provider.authorizationStatus == .approved }
    var selectionCounts: SelectionCounts { deps.provider.selectionCounts() }
    var breakKeptSelectionCounts: SelectionCounts { deps.selectionStatus.counts(.breakKept) }
    var canConfigureSelection: Bool { deps.selectionConfigurator != nil }
    var isSimulated: Bool { deps.isSimulated }
    var selectionActionTitle: String {
        if isSimulated { return "Simulate selection" }
        return hasSelection ? "Change apps" : (deps.selectionConfigurator?.actionTitle ?? "Choose apps")
    }
    var breakSelectionActionTitle: String {
        if isSimulated { return "Simulate break selection" }
        return hasBreakKeptSelection ? "Change apps kept blocked" : "Choose apps that stay blocked"
    }
    /// The employee must pick apps unless the policy says the selection is optional.
    var selectionRequired: Bool { policy?.restrictionConfig.requireEmployeeAppSelection ?? true }
    /// RELAX_CATEGORIES breaks need a second selection: the subset that stays blocked during breaks.
    var needsBreakKeptSelection: Bool {
        guard let policy else { return false }
        return RestrictionPlan.make(shiftId: "", policy: policy, breakPolicy: breakPolicy).requiresBreakSubsetSelection
    }
    var policyCategoryLabels: [String] { policy.map { RestrictionCategory.canonical($0.restrictionConfig.categories).map(\.label) } ?? [] }
    var relaxedCategoryLabels: [String] { breakPolicy.map { RestrictionCategory.canonical($0.rules.relaxedCategories).map(\.label) } ?? [] }
    /// What is still missing on screen 7 (nil when the selection is complete).
    var selectionProblem: String? {
        if selectionRequired, !hasSelection { return "Choose at least one app or category to block during shifts." }
        if needsBreakKeptSelection, !hasBreakKeptSelection { return "Choose the apps that stay blocked during breaks." }
        return nil
    }
    var canContinueFromChooseApps: Bool { selectionProblem == nil }
    /// "2 × 15 minutes" for screen 8; nil when breaks are not available.
    var breakAllowanceSummary: String? {
        guard let rules = breakPolicy?.rules, rules.breaksEnabled, rules.maxBreakDurationMinutes > 0 else { return nil }
        return "\(rules.maxBreaksPerShift) × \(rules.maxBreakDurationMinutes) minutes"
    }
    var canGoBack: Bool {
        switch step {
        case .name, .joinWorkplace, .confirmIdentity:
            return !isWorking
        case .authorise:
            return !isWorking && mode == .setup
        case .chooseApps:
            return !isWorking && (mode == .setup || !isAuthorised)
        case .confirmPolicy:
            return !isWorking
        case .welcome, .screenTimeExplained:
            return false
        }
    }

    // MARK: Navigation

    func getStarted() {
        clearError()
        go(to: .name)
    }

    func submitName() {
        guard canSubmitName else {
            errorMessage = "Enter your first and last name as your employer knows them."
            return
        }
        clearError()
        go(to: .joinWorkplace)
    }

    func back() {
        guard canGoBack else { return }
        clearError()
        switch step {
        case .name: go(to: .welcome)
        case .joinWorkplace: go(to: .name)
        case .confirmIdentity: go(to: .joinWorkplace)
        case .authorise: go(to: .screenTimeExplained)
        case .chooseApps: go(to: .authorise)
        case .confirmPolicy: go(to: .chooseApps)
        case .welcome, .screenTimeExplained: break
        }
    }

    /// Formats as the user types (`XXXX-0000`).
    func updateCompanyCode(_ input: String) {
        let formatted = CompanyCode.formatAsTyped(input)
        if formatted != companyCode { companyCode = formatted }
    }

    // MARK: Screen 3 — POST /join/lookup

    func lookUp() async {
        guard canSubmitName else {
            go(to: .name)
            errorMessage = "Enter your first and last name first."
            return
        }
        guard CompanyCode.isValid(normalisedCompanyCode) else {
            errorMessage = "Enter the company code in the format \(CompanyCode.placeholder)."
            return
        }
        if hasEmployeeCode && !EmployeeCode.isValid(normalisedEmployeeCode) {
            errorMessage = "Enter the employee code your manager gave you."
            return
        }
        clearError()
        isWorking = true
        defer { isWorking = false }
        do {
            let result = try await deps.api.joinLookup(JoinLookupRequest(
                companyCode: normalisedCompanyCode,
                firstName: trimmedFirstName,
                lastName: trimmedLastName,
                inviteCode: hasEmployeeCode ? normalisedEmployeeCode : nil
            ))
            switch result.match {
            case .single:
                guard result.employeePreview != nil else {
                    errorMessage = JoinErrorMessages.generic
                    return
                }
                lookupResult = result
                go(to: .confirmIdentity)
            case .noMatch:
                lookupResult = nil
                errorMessage = JoinErrorMessages.employeeNotFound
            case .ambiguous:
                lookupResult = nil
                hasEmployeeCode = true
                errorMessage = JoinErrorMessages.ambiguousMatch
            }
        } catch {
            if (error as? APIError)?.code == .ambiguousMatch { hasEmployeeCode = true }
            errorMessage = JoinErrorMessages.message(for: error)
        }
    }

    // MARK: Screen 4 — POST /join/confirm

    func confirmIdentity() async {
        guard let preview = lookupResult?.employeePreview else {
            go(to: .joinWorkplace)
            return
        }
        clearError()
        isWorking = true
        defer { isWorking = false }
        do {
            let response = try await deps.api.joinConfirm(JoinConfirmRequest(
                companyCode: normalisedCompanyCode,
                employeeId: preview.id,
                firstName: trimmedFirstName,
                lastName: trimmedLastName,
                inviteCode: hasEmployeeCode ? normalisedEmployeeCode : nil,
                device: MobileDeviceInfo(appVersion: deps.deviceInfo.appVersion, osVersion: deps.deviceInfo.osVersion, model: deps.deviceInfo.model)
            ))
            // Tokens are already in the Keychain (APIClient.joinConfirm); cache who/where we joined.
            try deps.cache.update { state in
                state.organisation = response.organisation
                state.employee = response.employee
                state.deviceId = response.deviceId
                state.setupCompletedAt = nil
            }
            go(to: .screenTimeExplained)
        } catch {
            if (error as? APIError)?.code == .ambiguousMatch {
                hasEmployeeCode = true
                go(to: .joinWorkplace)
            }
            errorMessage = JoinErrorMessages.message(for: error)
        }
    }

    /// "That's not me" on screen 4.
    func rejectIdentity() {
        lookupResult = nil
        clearError()
        go(to: .joinWorkplace)
    }

    // MARK: Screens 5–6 — Screen Time

    func continueFromScreenTimeExplained() {
        clearError()
        go(to: .authorise)
    }

    /// Screen 6. Asks iOS once (already-approved skips the prompt), records the outcome, reports it to the server
    /// (`/device/state`) and queues PERMISSION_GRANTED or PERMISSION_NEEDS_ATTENTION.
    func authorise() async {
        clearError()
        if deps.provider.authorizationStatus != .approved {
            isWorking = true
            defer { isWorking = false }
            do {
                try await deps.provider.requestAuthorization()
            } catch {
                authorisation = .failed
                errorMessage = "Screen Time access couldn't be requested. Work Mode can't block apps during shifts without it — tap Try again."
                return
            }
        }
        let status = deps.provider.authorizationStatus
        let permission = status.permissionState(previous: deps.cache.load()?.lastPermissionState)
        _ = try? deps.cache.update { $0.lastPermissionState = permission }
        switch status {
        case .approved:
            authorisation = .approved
            recordOnce(DeviceEvent(type: .permissionGranted, occurredAt: now(), metadata: DeviceEventMetadata(permissionState: .approved)))
            await reportPermissionState(permission)
            if let notifications = deps.notifications {
                // Ask for notification permission right after Screen Time, never earlier.
                Task { _ = await notifications.requestPermission() }
            }
            if mode == .repair, !deps.provider.hasSelection() || needsBreakKeptSelection && !hasBreakKeptSelection {
                go(to: .chooseApps)
            } else if mode == .repair {
                await completeRepair()
            } else {
                go(to: .chooseApps)
            }
        case .denied:
            authorisation = .denied
            recordOnce(DeviceEvent(type: .permissionNeedsAttention, occurredAt: now(),
                                   metadata: DeviceEventMetadata(reason: "PERMISSION_\(permission.rawValue)", permissionState: permission)))
            await reportPermissionState(permission)
            errorMessage = "Screen Time access wasn't allowed. Turn it on in Settings › Screen Time › Apps with Screen Time access, then come back and tap Try again."
        case .notDetermined:
            authorisation = .failed
            errorMessage = "Screen Time access wasn't decided. Tap the button to try again."
        }
    }

    // MARK: Screen 7 — choose apps

    /// Opens Apple's picker for the work selection (or simulates one). The save is announced by
    /// `.workModeSelectionDidChange`; `hasSelection` follows it.
    func chooseApps() {
        clearError()
        selectionIncompleteShown = false
        guard let configurator = deps.selectionConfigurator else {
            errorMessage = "Choosing apps isn't available in this build yet."
            return
        }
        do {
            _ = try configurator.configureSelection(kind: .work)
        } catch {
            errorMessage = "Your app choices couldn't be saved. Please try again."
        }
        refreshSelectionState()
    }

    /// Opens the second picker: the subset of the work selection that stays blocked during RELAX_CATEGORIES breaks.
    func chooseBreakKeptApps() {
        clearError()
        selectionIncompleteShown = false
        guard let configurator = deps.selectionConfigurator else {
            errorMessage = "Choosing apps isn't available in this build yet."
            return
        }
        do {
            _ = try configurator.configureSelection(kind: .breakKept)
        } catch {
            errorMessage = "Your app choices couldn't be saved. Please try again."
        }
        refreshSelectionState()
    }

    /// Continue from screen 7: validates the selection against the policy, queues SELECTION_CONFIGURED once, then
    /// moves to the policy confirmation (setup) or finishes (repair).
    func continueFromChooseApps() async {
        clearError()
        refreshSelectionState()
        if let problem = selectionProblem {
            selectionIncompleteShown = true
            errorMessage = problem
            return
        }
        selectionIncompleteShown = false
        if hasSelection {
            recordOnce(DeviceEvent(type: .selectionConfigured, occurredAt: now(), metadata: DeviceEventMetadata(selectionCounts: deps.provider.selectionCounts())))
        }
        switch mode {
        case .setup:
            go(to: .confirmPolicy)
        case .repair:
            await completeRepair()
        }
    }

    // MARK: Screen 8 — confirm policy, complete setup

    /// Fetches the workplace policy through a full sync (also caches the schedule and plans activities). With
    /// `force == false` a policy already in the cache is kept (screen 5 pre-loads it for screen 7's guidance).
    func loadPolicy(force: Bool = true) async {
        if !force, policy != nil { return }
        isLoadingPolicy = true
        isWorking = true
        defer {
            isLoadingPolicy = false
            isWorking = false
        }
        let outcome = await deps.syncCoordinator.sync(reason: .setup)
        let cached = deps.cache.load()
        policy = cached?.policy
        breakPolicy = cached?.breakPolicy
        policyLoadFailed = outcome.error != nil && cached?.lastSyncAt == nil
        if policyLoadFailed, let error = outcome.error {
            errorMessage = JoinErrorMessages.message(for: error)
        }
    }

    /// Queues SETUP_COMPLETED, posts `/device/state` and flushes `/events`. Setup completes only when the
    /// server has the check-in and the event, so the manager's dashboard shows the phone as connected.
    func completeSetup() async {
        clearError()
        guard deps.provider.authorizationStatus == .approved else {
            go(to: .authorise)
            errorMessage = "Allow Screen Time access to finish setup."
            return
        }
        refreshSelectionState()
        guard selectionProblem == nil else {
            go(to: .chooseApps)
            selectionIncompleteShown = true
            errorMessage = selectionProblem
            return
        }
        isWorking = true
        defer { isWorking = false }
        let instant = now()
        // Retrying after a failure must not queue a second SETUP_COMPLETED under a new clientEventId.
        recordOnce(DeviceEvent(type: .setupCompleted, occurredAt: instant, metadata: DeviceEventMetadata(
            permissionState: .approved,
            selectionCounts: deps.provider.selectionCounts()
        )))
        do {
            let cached = deps.cache.load() ?? CachedState()
            let engineState = cached.engineState?.state ?? .offShift
            let report = DeviceStateReportBuilder.make(provider: deps.provider, cache: cached, engineState: engineState, deviceInfo: deps.deviceInfo, now: instant)
            let response = try await deps.api.reportDeviceState(report)
            try await deps.outbox.flush(isPermanentFailure: APIError.isPermanentRejection) { [api = deps.api] batch in
                _ = try await api.postEvents(batch)
            }
            try deps.cache.update { state in
                state.setupCompletedAt = instant
                state.lastDeviceStateReportAt = instant
                state.clockSkewSeconds = response.clockSkewSeconds
                state.lastPermissionState = .approved
            }
            deps.progress?.clear()
            onFinished()
        } catch {
            errorMessage = "Couldn't finish setup. \(JoinErrorMessages.message(for: error))"
        }
    }

    /// Repair mode: report the restored permission/selection and hand back to the app.
    private func completeRepair() async {
        isWorking = true
        defer { isWorking = false }
        let instant = now()
        let cached = deps.cache.load() ?? CachedState()
        let report = DeviceStateReportBuilder.make(provider: deps.provider, cache: cached, engineState: cached.engineState?.state ?? .offShift,
                                                   deviceInfo: deps.deviceInfo, now: instant)
        do {
            let response = try await deps.api.reportDeviceState(report)
            try? deps.cache.update { state in
                state.lastDeviceStateReportAt = instant
                state.clockSkewSeconds = response.clockSkewSeconds
            }
            try? await deps.outbox.flush(isPermanentFailure: APIError.isPermanentRejection) { [api = deps.api] batch in
                _ = try await api.postEvents(batch)
            }
        } catch {
            // The next sync reports it; the local repair is done regardless.
            WorkModeLog.app.info("repair check-in deferred: \(String(describing: error), privacy: .public)")
        }
        onFinished()
    }

    // MARK: Private

    private func go(to next: Step) {
        step = next
        if mode == .setup { deps.progress?.step = next }
    }

    private func refreshSelectionState() {
        hasSelection = deps.provider.hasSelection()
        hasBreakKeptSelection = deps.selectionStatus.hasSelection(.breakKept)
    }

    /// Best-effort `/device/state` with the permission just decided (the sync re-reports it anyway).
    private func reportPermissionState(_ permission: PermissionState) async {
        let instant = now()
        let cached = deps.cache.load() ?? CachedState()
        let engineState: WorkModeState = permission.isApproved ? (cached.engineState?.state ?? .offShift) : .permissionError
        let report = DeviceStateReportBuilder.make(provider: deps.provider, cache: cached, engineState: engineState, deviceInfo: deps.deviceInfo, now: instant)
        do {
            let response = try await deps.api.reportDeviceState(report)
            try? deps.cache.update { state in
                state.lastDeviceStateReportAt = instant
                state.clockSkewSeconds = response.clockSkewSeconds
            }
        } catch {
            WorkModeLog.app.info("permission check-in deferred: \(String(describing: error), privacy: .public)")
        }
    }

    /// Queues a one-off onboarding event unless one of the same type is still waiting to be uploaded (the
    /// employee went back and forward, or retried a step that failed).
    private func recordOnce(_ event: DeviceEvent) {
        guard !deps.outbox.hasPending(event.type) else { return }
        do {
            try deps.outbox.append(event)
        } catch {
            WorkModeLog.app.error("could not queue \(event.type.rawValue, privacy: .public): \(String(describing: error), privacy: .public)")
        }
    }

    private func clearError() {
        errorMessage = nil
    }
}
