// MOCK — development and tests only.
//
// Compiled only when DEBUG_MOCK_RESTRICTIONS is defined (Config/Debug.xcconfig). Release defines no such
// condition, so this type does not exist in a Release build and nothing there can reference it
// (`make build-release` also checks the binary for its symbol). Screen Time does not work in the iOS
// Simulator, so Debug builds use this in-memory simulation and the app shows a persistent
// "DEVELOPMENT MODE — restrictions are simulated" banner whenever it is active.
#if DEBUG_MOCK_RESTRICTIONS
import Foundation
import WorkModeCore

final class MockRestrictionProvider: RestrictionProvider, SelectionCountsProviding, SelectionConfiguring {
    enum AuthorizationOutcome: Equatable {
        case approve
        case deny
        /// `requestAuthorization()` throws (e.g. the user cancelled the system sheet).
        case fail
    }

    enum ActiveRestriction: Equatable {
        case none
        case work(RestrictionPlan)
        case onBreak(RestrictionPlan, BreakBehaviour)
    }

    struct AppliedBreak: Equatable {
        let plan: RestrictionPlan
        let behaviour: BreakBehaviour
    }

    struct SimulatedFailure: Error, LocalizedError {
        var errorDescription: String? { "Simulated Screen Time authorisation failure." }
    }

    static let defaultSelection = SelectionCounts(categories: 3, applications: 4, webDomains: 1)

    private enum Keys {
        static let authorization = "mock.restrictions.authorization"
        static let selection = "mock.restrictions.selection"
    }

    private let lock = NSRecursiveLock()
    private let store: KeyValueStore
    private let now: () -> Date

    private var _authorizationOutcome: AuthorizationOutcome
    private var _authorizationStatus: RestrictionAuthorizationStatus
    private var _selection: SelectionCounts?
    private var _appliedWorkPlans: [RestrictionPlan] = []
    private var _appliedBreaks: [AppliedBreak] = []
    private var _scheduledActivities: [ActivityPlan] = []
    private var _clearCount = 0
    private var _cancelCount = 0
    private var _activeRestriction: ActiveRestriction = .none
    private var _lastChange: Date?
    private var _log: [String] = []

    /// - Parameter store: persists the simulated authorisation and selection across launches (pass an
    ///   in-memory store in tests).
    init(store: KeyValueStore, authorizationOutcome: AuthorizationOutcome = .approve, now: @escaping () -> Date = Date.init) {
        self.store = store
        self.now = now
        _authorizationOutcome = authorizationOutcome
        _authorizationStatus = store.string(forKey: Keys.authorization).flatMap(RestrictionAuthorizationStatus.init(rawValue:)) ?? .notDetermined
        _selection = store.decodable(SelectionCounts.self, forKey: Keys.selection)
    }

    // MARK: Inspection (tests, debug UI)

    var authorizationOutcome: AuthorizationOutcome {
        get { locked { _authorizationOutcome } }
        set { locked { _authorizationOutcome = newValue } }
    }

    var appliedWorkPlans: [RestrictionPlan] { locked { _appliedWorkPlans } }
    var appliedBreaks: [AppliedBreak] { locked { _appliedBreaks } }
    var scheduledActivities: [ActivityPlan] { locked { _scheduledActivities } }
    var clearCount: Int { locked { _clearCount } }
    var cancelCount: Int { locked { _cancelCount } }
    var activeRestriction: ActiveRestriction { locked { _activeRestriction } }
    var log: [String] { locked { _log } }

    // MARK: RestrictionProvider

    var authorizationStatus: RestrictionAuthorizationStatus { locked { _authorizationStatus } }

    func requestAuthorization() async throws {
        let outcome = authorizationOutcome
        switch outcome {
        case .approve:
            setAuthorization(.approved)
        case .deny:
            setAuthorization(.denied)
        case .fail:
            record("requestAuthorization failed (simulated)")
            throw SimulatedFailure()
        }
    }

    func hasSelection() -> Bool {
        locked { (_selection?.total ?? 0) > 0 }
    }

    func applyWorkRestrictions(plan: RestrictionPlan) throws {
        try locked {
            try requireReady()
            _appliedWorkPlans.append(plan)
            _activeRestriction = .work(plan)
            _lastChange = now()
            appendLog("apply work shields for shift \(plan.shiftId): \(plan.categories.map(\.rawValue).joined(separator: ","))")
        }
    }

    func applyBreakRestrictions(plan: RestrictionPlan, behaviour: BreakBehaviour) throws {
        try locked {
            try requireReady()
            _appliedBreaks.append(AppliedBreak(plan: plan, behaviour: behaviour))
            _activeRestriction = .onBreak(plan, behaviour)
            _lastChange = now()
            appendLog("apply break for shift \(plan.shiftId): \(behaviour)")
        }
    }

    func clearRestrictions() throws {
        locked {
            _clearCount += 1
            _activeRestriction = .none
            _lastChange = now()
            appendLog("clear shields")
        }
    }

    func scheduleActivities(_ plans: [ActivityPlan]) throws {
        try locked {
            guard _authorizationStatus == .approved else { throw RestrictionProviderError.notAuthorized }
            guard plans.count <= ActivityPlanner.maxActivities else {
                throw RestrictionProviderError.schedulingFailed("\(plans.count) activities exceed the limit of \(ActivityPlanner.maxActivities)")
            }
            let minimum = TimeInterval(ActivityPlanner.minimumIntervalMinutes * 60)
            for plan in plans {
                guard let start = plan.startComponents.resolvedDate(), let end = plan.endComponents.resolvedDate(),
                      end.timeIntervalSince(start) >= minimum else {
                    throw RestrictionProviderError.schedulingFailed("\(plan.name) is shorter than \(ActivityPlanner.minimumIntervalMinutes) minutes")
                }
            }
            // Same semantics as DeviceActivityCenter: the given set replaces what was monitored.
            _scheduledActivities = plans
            appendLog("schedule \(plans.count) activities: \(plans.map(\.name).joined(separator: ","))")
        }
    }

    func cancelAllActivities() {
        locked {
            _cancelCount += 1
            _scheduledActivities = []
            appendLog("cancel all activities")
        }
    }

    func currentEngineState() -> RestrictionEngineState {
        locked {
            guard _authorizationStatus == .approved else {
                return RestrictionEngineState(state: .permissionError, source: .provider, updatedAt: _lastChange)
            }
            switch _activeRestriction {
            case .none:
                return RestrictionEngineState(state: .offShift, source: .provider, updatedAt: _lastChange)
            case .work:
                return RestrictionEngineState(state: .working, source: .provider, updatedAt: _lastChange)
            case .onBreak:
                return RestrictionEngineState(state: .onBreak, source: .provider, updatedAt: _lastChange)
            }
        }
    }

    // MARK: SelectionCountsProviding / SelectionConfiguring

    func selectionCounts() -> SelectionCounts {
        locked { _selection ?? .zero }
    }

    var actionTitle: String { "Simulate choosing apps" }

    func configureSelection() throws -> SelectionCounts {
        simulateSelection(MockRestrictionProvider.defaultSelection)
        return selectionCounts()
    }

    // MARK: Simulation controls

    func simulateSelection(_ counts: SelectionCounts) {
        locked {
            _selection = counts
            try? store.setEncodable(counts, forKey: Keys.selection)
            appendLog("selection configured: \(counts.categories) categories, \(counts.applications) apps, \(counts.webDomains) websites")
        }
    }

    func clearSelection() {
        locked {
            _selection = nil
            store.removeValue(forKey: Keys.selection)
            appendLog("selection cleared")
        }
    }

    /// Simulates the employee turning Screen Time access off in Settings.
    func simulateRevocation() {
        setAuthorization(.denied)
    }

    /// Forgets the simulated authorisation and selection (used when leaving a workplace).
    func reset() {
        locked {
            _authorizationStatus = .notDetermined
            _selection = nil
            _activeRestriction = .none
            _scheduledActivities = []
            store.removeValue(forKey: Keys.authorization)
            store.removeValue(forKey: Keys.selection)
            appendLog("reset")
        }
    }

    // MARK: Private

    private func setAuthorization(_ status: RestrictionAuthorizationStatus) {
        locked {
            _authorizationStatus = status
            store.set(status.rawValue, forKey: Keys.authorization)
            appendLog("authorization → \(status.rawValue)")
        }
    }

    private func requireReady() throws {
        guard _authorizationStatus == .approved else { throw RestrictionProviderError.notAuthorized }
        guard (_selection?.total ?? 0) > 0 else { throw RestrictionProviderError.noSelection }
    }

    private func record(_ message: String) {
        locked { appendLog(message) }
    }

    private func appendLog(_ message: String) {
        _log.append(message)
        WorkModeLog.restrictions.debug("[MOCK] \(message, privacy: .public)")
    }

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }
}
#endif
