import Combine
import DeviceActivity
import FamilyControls
import Foundation
import ManagedSettings
import ClockOffCore
import ClockOffScreenTime

/// Screen Time implementation of `RestrictionProvider` (FamilyControls / ManagedSettings / DeviceActivity).
/// See docs/SCREEN_TIME_IMPLEMENTATION.md.
///
/// - Authorisation: `AuthorizationCenter.shared.requestAuthorization(for: .individual)`; `$authorizationStatus`
///   is observed so a revocation in Settings › Screen Time is noticed while the app runs. On a revocation the
///   shields are cleared, PERMISSION_ERROR is recorded in the App Group cache and
///   `Notification.Name.clockOffAuthorizationStatusDidChange` is posted (plus `onAuthorizationStatusChange`).
/// - Selection: the employee's `FamilyActivitySelection`s live in the App Group (`SelectionStore`, `work` and
///   `breakKept`); only their counts are ever read for reporting (§12).
/// - Shields: two named stores — `.work` holds the full set during a shift, `.breakRelaxed` the "kept" subset
///   during a RELAX_CATEGORIES break. `ShieldApplier` (Core) decides; this type only wires the real stores.
/// - Scheduling: one non-repeating `DeviceActivitySchedule` per working interval (`shift-<id>-v<version>`) with
///   `warningTime` = the pre-shift warning, plus one per running break (`break-<clientBreakId>`, 15-minute floor).
/// - `currentEngineState()` never claims shields that are not in the stores: it reads them back.
///
/// Thread-safe: `SyncCoordinator` (an actor) and the main-actor `WorkModeController` both call it.
final class AppleScreenTimeRestrictionProvider: RestrictionProvider, SelectionCountsProviding, BreakScheduling, RestrictionAuthorizationObserving {
    private let center = AuthorizationCenter.shared
    private let activityCenter = DeviceActivityCenter()
    private let applier: ShieldApplier
    private let selections: SelectionStore
    private let cache: StateCache
    private let now: () -> Date
    private let lock = NSLock()
    private var lastStatus: RestrictionAuthorizationStatus
    private var statusObserver: AnyCancellable?
    private var statusChangeHandler: ((RestrictionAuthorizationStatus) -> Void)?

    /// - Parameters:
    ///   - fileStore: the App Group container (`AppGroupFileStore.live()`), shared with the extensions.
    ///   - flags: the App Group `UserDefaults` flags (`selectionIncomplete`, …); nil when the suite is unavailable.
    init(fileStore: AppGroupFileStore, flags: SharedFlags?, now: @escaping () -> Date = Date.init) {
        selections = SelectionStore(fileStore: fileStore)
        applier = ShieldApplier(stores: ScreenTimeShieldStores(), selections: selections, flags: flags)
        cache = StateCache(fileStore: fileStore)
        self.now = now
        lastStatus = RestrictionAuthorizationStatus(center.authorizationStatus)
        statusObserver = center.$authorizationStatus
            .map(RestrictionAuthorizationStatus.init)
            .removeDuplicates()
            .sink { [weak self] status in self?.authorizationChanged(to: status) }
    }

    // MARK: Authorisation

    var authorizationStatus: RestrictionAuthorizationStatus {
        RestrictionAuthorizationStatus(center.authorizationStatus)
    }

    func requestAuthorization() async throws {
        try await center.requestAuthorization(for: .individual)
        authorizationChanged(to: authorizationStatus)
    }

    var onAuthorizationStatusChange: ((RestrictionAuthorizationStatus) -> Void)? {
        get { lock.withLock { statusChangeHandler } }
        set { lock.withLock { statusChangeHandler = newValue } }
    }

    private func authorizationChanged(to status: RestrictionAuthorizationStatus) {
        let previous: RestrictionAuthorizationStatus = lock.withLock {
            let previous = lastStatus
            lastStatus = status
            return previous
        }
        guard previous != status else { return }
        ClockOffLog.restrictions.info("Screen Time authorisation \(previous.rawValue, privacy: .public) → \(status.rawValue, privacy: .public)")
        if status != .approved {
            // iOS removes an unauthorised app's ManagedSettings; make sure nothing on our side claims otherwise
            // and the next report says PERMISSION_ERROR until the employee re-allows access.
            applier.clearAll()
            let instant = now()
            try? cache.update { state in
                state.engineState = RestrictionEngineState(state: .permissionError, source: .provider, updatedAt: instant)
            }
        }
        onAuthorizationStatusChange?(status)
        NotificationCenter.default.post(
            name: .clockOffAuthorizationStatusDidChange,
            object: nil,
            userInfo: [RestrictionAuthorizationNotification.statusKey: status.rawValue]
        )
    }

    // MARK: Selection (counts only leave the device)

    func hasSelection() -> Bool {
        selections.hasSelection(.work)
    }

    func selectionCounts() -> SelectionCounts {
        selections.summary(.work).counts
    }

    // MARK: Shields

    func applyWorkRestrictions(plan: RestrictionPlan) throws {
        try requireAuthorization()
        try applier.applyWork()
        ClockOffLog.restrictions.info("work shields applied for shift \(plan.shiftId, privacy: .public)")
    }

    func applyBreakRestrictions(plan: RestrictionPlan, behaviour: BreakBehaviour) throws {
        try requireAuthorization()
        let applied = try applier.applyBreak(behaviour)
        ClockOffLog.restrictions.info("break relaxation applied for shift \(plan.shiftId, privacy: .public): \(String(describing: applied), privacy: .public)")
    }

    func clearRestrictions() throws {
        applier.clearAll()
        ClockOffLog.restrictions.info("shields cleared")
    }

    // MARK: DeviceActivity

    func scheduleActivities(_ plans: [ActivityPlan]) throws {
        try requireAuthorization()
        guard plans.count <= ActivityPlanner.maxActivities else {
            throw RestrictionProviderError.schedulingFailed("\(plans.count) activities exceed Apple's limit of \(ActivityPlanner.maxActivities)")
        }
        stopMonitoringOurs()
        let instant = now()
        var failures: [String] = []
        var registered = 0
        for plan in plans {
            // Already over (the plan was built a moment ago, or the device clock jumped): nothing to monitor.
            if let end = plan.plannedEnd ?? plan.intervalEnd, end <= instant { continue }
            do {
                try activityCenter.startMonitoring(DeviceActivityName(plan.name), during: Self.schedule(for: plan))
                registered += 1
            } catch {
                failures.append("\(plan.name): \(error)")
            }
        }
        ClockOffLog.restrictions.info("DeviceActivity: \(registered) activities registered, \(failures.count) failed")
        if !failures.isEmpty {
            throw RestrictionProviderError.schedulingFailed(failures.joined(separator: "; "))
        }
    }

    @discardableResult
    func scheduleBreak(clientBreakId: String, shiftId: String, startedAt: Date, plannedEndsAt: Date) throws -> ActivityPlan {
        try requireAuthorization()
        let plan = BreakActivitySchedule.make(clientBreakId: clientBreakId, shiftId: shiftId, startedAt: startedAt, plannedEndsAt: plannedEndsAt, timeZone: .current)
        let name = DeviceActivityName(plan.name)
        activityCenter.stopMonitoring([name])
        do {
            try activityCenter.startMonitoring(name, during: Self.schedule(for: plan))
        } catch {
            throw RestrictionProviderError.schedulingFailed("\(plan.name): \(error)")
        }
        return plan
    }

    func cancelBreakActivity(clientBreakId: String) {
        activityCenter.stopMonitoring([DeviceActivityName(ActivityNaming.breakActivity(clientBreakId: clientBreakId))])
    }

    func cancelAllActivities() {
        stopMonitoringOurs()
    }

    private func stopMonitoringOurs() {
        let ours = activityCenter.activities.filter { ActivityNaming.isOurs($0.rawValue) }
        if !ours.isEmpty { activityCenter.stopMonitoring(ours) }
    }

    /// Calendar components to the minute (DeviceActivity works on minutes), in the plan's own calendar/zone.
    static func schedule(for plan: ActivityPlan) -> DeviceActivitySchedule {
        DeviceActivitySchedule(
            intervalStart: minuteComponents(plan.startComponents),
            intervalEnd: minuteComponents(plan.endComponents),
            repeats: false,
            warningTime: plan.warningMinutes > 0 ? DateComponents(minute: plan.warningMinutes) : nil
        )
    }

    static func minuteComponents(_ components: DateComponents) -> DateComponents {
        var trimmed = DateComponents()
        trimmed.calendar = components.calendar
        trimmed.timeZone = components.timeZone
        trimmed.year = components.year
        trimmed.month = components.month
        trimmed.day = components.day
        trimmed.hour = components.hour
        trimmed.minute = components.minute
        return trimmed
    }

    // MARK: State

    /// Derived from (a) what the stores actually hold, (b) what the extension or app last recorded in the App
    /// Group and (c) the cached break. Never claims an active state when both stores are empty, unless the
    /// recorded state legitimately has no shields (a RELAX_ALL break).
    func currentEngineState() -> RestrictionEngineState {
        guard authorizationStatus == .approved else {
            return RestrictionEngineState(state: .permissionError, source: .provider, updatedAt: now())
        }
        let snapshot = applier.snapshot()
        let state = cache.load()
        let recorded = state?.engineState

        if snapshot.breakShielding, !snapshot.workShielding {
            return RestrictionEngineState(state: .onBreak, source: .provider, updatedAt: recorded?.updatedAt)
        }
        if snapshot.anyShielding {
            if let recorded, WorkModeEngine.isActiveState(recorded.state) { return recorded }
            return RestrictionEngineState(state: .working, source: .provider, updatedAt: recorded?.updatedAt)
        }
        // Stores are empty.
        guard let recorded else { return .unknown }
        if WorkModeEngine.isActiveState(recorded.state) {
            // A RELAX_ALL break (or one lifting every category) legitimately has no shields.
            if recorded.state == .onBreak, let session = state?.activeBreakSession, session.status == .active,
               !BreakRules.breakRestrictionForSession(session).restrictionsShouldBeActive {
                return recorded
            }
            return RestrictionEngineState(state: .unknown, source: .provider, updatedAt: recorded.updatedAt)
        }
        return recorded
    }

    // MARK: Private

    private func requireAuthorization() throws {
        guard authorizationStatus == .approved else { throw RestrictionProviderError.notAuthorized }
    }
}

private extension NSLock {
    func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}
