import Foundation
import WorkModeCore

/// Drives onboarding screens 1–8. Screens 1–4 (welcome, name, join, confirm) are complete; 5–8 call the
/// real provider/API seams and are visually minimal until the Screen Time stage finishes them.
@MainActor
final class OnboardingViewModel: ObservableObject {
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

    struct Dependencies {
        let api: MobileAPI
        let cache: StateCache
        let outbox: EventOutbox
        let provider: AppRestrictionProvider
        let selectionConfigurator: SelectionConfiguring?
        let deviceInfo: DeviceInfoProviding
        let syncCoordinator: SyncCoordinator
    }

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

    private let deps: Dependencies
    private let onFinished: () -> Void
    private let now: () -> Date

    init(dependencies: Dependencies, initialStep: Step = .welcome, now: @escaping () -> Date = Date.init, onFinished: @escaping () -> Void) {
        deps = dependencies
        step = initialStep
        self.now = now
        self.onFinished = onFinished
        if let cached = dependencies.cache.load() {
            firstName = cached.employee?.firstName ?? ""
            lastName = cached.employee?.lastName ?? ""
        }
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
    var authorizationStatus: RestrictionAuthorizationStatus { deps.provider.authorizationStatus }
    var hasSelection: Bool { deps.provider.hasSelection() }
    var selectionCounts: SelectionCounts { deps.provider.selectionCounts() }
    var canConfigureSelection: Bool { deps.selectionConfigurator != nil }
    var selectionActionTitle: String { deps.selectionConfigurator?.actionTitle ?? "Choose apps" }
    var canGoBack: Bool {
        switch step {
        case .name, .joinWorkplace, .confirmIdentity, .authorise, .chooseApps, .confirmPolicy:
            return !isWorking
        case .welcome, .screenTimeExplained:
            return false
        }
    }

    // MARK: Navigation

    func getStarted() {
        clearError()
        step = .name
    }

    func submitName() {
        guard canSubmitName else {
            errorMessage = "Enter your first and last name as your employer knows them."
            return
        }
        clearError()
        step = .joinWorkplace
    }

    func back() {
        guard canGoBack else { return }
        clearError()
        switch step {
        case .name: step = .welcome
        case .joinWorkplace: step = .name
        case .confirmIdentity: step = .joinWorkplace
        case .authorise: step = .screenTimeExplained
        case .chooseApps: step = .authorise
        case .confirmPolicy: step = .chooseApps
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
            step = .name
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
                step = .confirmIdentity
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
            step = .joinWorkplace
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
            step = .screenTimeExplained
        } catch {
            if (error as? APIError)?.code == .ambiguousMatch {
                hasEmployeeCode = true
                step = .joinWorkplace
            }
            errorMessage = JoinErrorMessages.message(for: error)
        }
    }

    /// "That's not me" on screen 4.
    func rejectIdentity() {
        lookupResult = nil
        clearError()
        step = .joinWorkplace
    }

    // MARK: Screens 5–6 — Screen Time

    func continueFromScreenTimeExplained() {
        clearError()
        step = .authorise
    }

    func authorise() async {
        clearError()
        if deps.provider.authorizationStatus != .approved {
            isWorking = true
            defer { isWorking = false }
            do {
                try await deps.provider.requestAuthorization()
            } catch {
                errorMessage = "Screen Time access wasn't allowed. Work Mode can't block apps during shifts without it — tap the button to try again."
                return
            }
        }
        guard deps.provider.authorizationStatus == .approved else {
            errorMessage = "Screen Time access wasn't allowed. If you turned it off, allow Work Mode in Settings › Screen Time, then try again."
            return
        }
        recordOnce(DeviceEvent(type: .permissionGranted, occurredAt: now(), metadata: DeviceEventMetadata(permissionState: .approved)))
        _ = try? deps.cache.update { $0.lastPermissionState = .approved }
        step = .chooseApps
    }

    // MARK: Screen 7 — choose apps

    func chooseApps() {
        clearError()
        if !deps.provider.hasSelection() {
            guard let configurator = deps.selectionConfigurator else {
                errorMessage = "Choosing apps isn't available in this build yet."
                return
            }
            do {
                _ = try configurator.configureSelection()
            } catch {
                errorMessage = "Your app choices couldn't be saved. Please try again."
                return
            }
        }
        guard deps.provider.hasSelection() else {
            errorMessage = "Choose at least one app or category to block."
            return
        }
        recordOnce(DeviceEvent(type: .selectionConfigured, occurredAt: now(), metadata: DeviceEventMetadata(selectionCounts: deps.provider.selectionCounts())))
        step = .confirmPolicy
    }

    // MARK: Screen 8 — confirm policy, complete setup

    /// Fetches the workplace policy through a full sync (also caches the schedule and plans activities).
    func loadPolicy() async {
        isWorking = true
        defer { isWorking = false }
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
            step = .authorise
            errorMessage = "Allow Screen Time access to finish setup."
            return
        }
        guard deps.provider.hasSelection() else {
            step = .chooseApps
            errorMessage = "Choose the apps to block to finish setup."
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
            onFinished()
        } catch {
            errorMessage = "Couldn't finish setup. \(JoinErrorMessages.message(for: error))"
        }
    }

    // MARK: Private

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
