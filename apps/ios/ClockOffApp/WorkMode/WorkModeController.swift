import Foundation
import UIKit
import ClockOffCore

/// Owns the live Work Mode state on the phone (§6.2 on device). It never guesses: every decision starts from
/// the cached schedule (`WorkModeEngine`), what the provider reports is really applied, and the stores.
///
/// - `reconcile()` recomputes the expected state and corrects the shields when they disagree:
///   (a) expected WORK and nothing applied → apply ("UNKNOWN_CORRECTED" when the provider could not say);
///   (b) expected NONE and shields up → clear; (c) expected BREAK_RELAXED → apply the break behaviour.
///   Engine state and WORK_MODE_* events are written only when something actually changed, with the reason.
///   It also closes a break whose time is up while the app is alive (the monitor extension does it otherwise).
/// - `startBreak` / `endBreakEarly` talk to the server through `BreakStarting`; when the network is down the
///   break starts from the cached policy (`BreakRules.canStartBreak`) and a `QueuedBreakRecord` waits in the App
///   Group for the sync layer to replay with the same `clientBreakId`.
/// - It wakes itself at the next engine boundary while the app runs (DeviceActivity covers the rest), re-plans
///   on significant time / time-zone changes, and reconciles on launch, foreground and authorisation changes.
///
/// Create one per app (`AppModel`), call `start()` once, and render `state`.
@MainActor
final class WorkModeController: ObservableObject {
    static let reasonLaunch = "LAUNCH"
    static let reasonForeground = "FOREGROUND"
    static let reasonTimer = "SCHEDULED_TRANSITION"
    static let reasonTimeChange = "TIME_CHANGE"
    static let reasonPermissionChanged = "PERMISSION_CHANGED"
    static let reasonSelectionChanged = "SELECTION_CHANGED"
    static let reasonBreakStarted = "BREAK_STARTED"
    static let reasonBreakEnded = "BREAK_ENDED"

    /// What one `reconcile()` did (for tests, logs and diagnostics).
    struct ReconcileOutcome: Equatable {
        var expected: ExpectedState?
        var decision: ReconcileDecision?
        var appliedState: WorkModeState?
        var queuedEvents: [ActivityEventType] = []
        var closedBreak: Bool = false
        var note: String
    }

    @Published private(set) var state: UIWorkState = .unknown
    @Published private(set) var expectedState: ExpectedState?
    @Published private(set) var lastOutcome: ReconcileOutcome?
    /// True when a RELAX_CATEGORIES break had to keep every shield because no "keep blocked on breaks" selection
    /// exists yet (`SharedFlags.selectionIncomplete`). Offer `SelectionConfiguring.configureSelection(kind: .breakKept)`.
    @Published private(set) var needsBreakSelection = false
    /// Set when the employee tapped "Open ClockOff" on a shield; the UI shows the status screen and clears it.
    @Published var statusRequestedFromShield = false
    @Published private(set) var isBreakRequestInFlight = false
    /// `MockRestrictionProvider` is in use: restrictions are simulated (Debug builds in the simulator).
    let isDevelopmentMode: Bool

    private let cache: StateCache
    private let plans: PlansStore
    private let outbox: EventOutbox
    private let ledger: BreakLedger
    private let provider: AppRestrictionProvider
    private let breakAPI: BreakStarting?
    private let flags: SharedFlags?
    private let planner: ActivityPlanner
    private let timeZone: () -> TimeZone
    private let now: () -> Date
    private let notificationCenter: NotificationCenter
    private var observers: [NSObjectProtocol] = []
    private var wakeTask: Task<Void, Never>?
    private var started = false
    private var enforcementFailed = false

    init(
        cache: StateCache,
        plans: PlansStore,
        provider: AppRestrictionProvider,
        breakAPI: BreakStarting?,
        flags: SharedFlags?,
        isDevelopmentMode: Bool,
        planner: ActivityPlanner = ActivityPlanner(),
        timeZone: @escaping () -> TimeZone = { .current },
        now: @escaping () -> Date = Date.init,
        notificationCenter: NotificationCenter = .default
    ) {
        self.cache = cache
        self.plans = plans
        outbox = EventOutbox(cache: cache)
        ledger = BreakLedger(cache: cache)
        self.provider = provider
        self.breakAPI = breakAPI
        self.flags = flags
        self.isDevelopmentMode = isDevelopmentMode
        self.planner = planner
        self.timeZone = timeZone
        self.now = now
        self.notificationCenter = notificationCenter
    }

    /// The production wiring over the app's dependency graph.
    convenience init(container: DependencyContainer) {
        self.init(
            cache: container.cache,
            plans: container.plans,
            provider: container.restrictionProvider,
            breakAPI: MobileAPIBreakClient(api: container.api),
            flags: SharedFlags.appGroup(),
            isDevelopmentMode: container.isUsingMockRestrictions,
            timeZone: { [deviceInfo = container.deviceInfo] in deviceInfo.timeZone }
        )
    }

    deinit {
        wakeTask?.cancel()
        for observer in observers { notificationCenter.removeObserver(observer) }
    }

    // MARK: Lifecycle

    /// Subscribes to time, time-zone, foreground and Screen Time authorisation changes, then reconciles.
    func start() {
        guard !started else { return }
        started = true
        observe(UIApplication.significantTimeChangeNotification) { [weak self] _ in self?.handleTimeChange() }
        observe(.NSSystemTimeZoneDidChange) { [weak self] _ in self?.handleTimeChange() }
        observe(UIApplication.didBecomeActiveNotification) { [weak self] _ in self?.handleDidBecomeActive() }
        observe(.clockOffAuthorizationStatusDidChange) { [weak self] notification in
            self?.handleAuthorizationChange(RestrictionAuthorizationNotification.status(from: notification))
        }
        observe(.clockOffSelectionDidChange) { [weak self] _ in _ = self?.reconcile(reason: WorkModeController.reasonSelectionChanged) }
        reconcile(reason: WorkModeController.reasonLaunch)
    }

    func stop() {
        wakeTask?.cancel()
        wakeTask = nil
        for observer in observers { notificationCenter.removeObserver(observer) }
        observers.removeAll()
        started = false
    }

    private func observe(_ name: Notification.Name, _ handler: @escaping (Notification) -> Void) {
        observers.append(notificationCenter.addObserver(forName: name, object: nil, queue: .main) { notification in
            // The observer queue is main, but the closure is not statically isolated: hop explicitly.
            Task { @MainActor in handler(notification) }
        })
    }

    /// Foreground: pick up a shield "Open ClockOff" tap and re-check the shields.
    func handleDidBecomeActive() {
        if flags?.consumeOpenStatusRequest() == true { statusRequestedFromShield = true }
        reconcile(reason: WorkModeController.reasonForeground)
    }

    /// Significant time change / time-zone change: the DateComponents schedules may now be wrong, so re-plan
    /// every activity (plans.json first) and reconcile the shields.
    func handleTimeChange() {
        do {
            try replanActivities()
        } catch {
            ClockOffLog.restrictions.error("re-planning after a time change failed: \(String(describing: error), privacy: .public)")
        }
        reconcile(reason: WorkModeController.reasonTimeChange)
    }

    /// Screen Time authorisation changed while the app runs. A revocation after approval is reported once as
    /// PERMISSION_NEEDS_ATTENTION (the sync layer sees `lastPermissionState` already updated and does not repeat it).
    func handleAuthorizationChange(_ status: RestrictionAuthorizationStatus?) {
        let instant = now()
        if let status, status != .approved, let cached = cache.load(), cached.lastPermissionState == .approved {
            let permission = status.permissionState(previous: cached.lastPermissionState)
            let event = DeviceEvent(type: .permissionNeedsAttention, occurredAt: instant,
                                    metadata: DeviceEventMetadata(reason: "PERMISSION_\(permission.rawValue)", permissionState: permission))
            _ = try? cache.update { $0.lastPermissionState = permission }
            _ = try? outbox.append(event)
        }
        reconcile(reason: WorkModeController.reasonPermissionChanged)
    }

    // MARK: Reconcile

    @discardableResult
    func reconcile(reason: String = ReconcileDecision.reasonReconcile) -> ReconcileOutcome {
        let instant = now()
        guard var cached = cache.load(), cached.isJoined else {
            expectedState = nil
            state = .unknown
            let outcome = ReconcileOutcome(note: "not joined")
            lastOutcome = outcome
            return outcome
        }
        let permission = provider.authorizationStatus.permissionState(previous: cached.lastPermissionState)
        var expected = evaluate(cached, permission: permission, at: instant)
        var outcome = ReconcileOutcome(expected: expected, note: "no change")

        // 1. A break whose time is up (planned end, or its shift's end) is closed here when the app is alive.
        if let closure = ledger.closeExpiredBreak(in: cached, shifts: cached.shifts, now: instant, eventReason: reason) {
            cached = closure.state
            outcome.closedBreak = true
            outcome.queuedEvents.append(closure.event.type)
            cancelBreakActivity(for: closure.session, at: instant)
            expected = evaluate(cached, permission: permission, at: instant)
            outcome.expected = expected
        }

        // 2. Compare what the engine expects with what is really applied.
        let providerState = provider.currentEngineState()
        let hasSelection = provider.hasSelection()
        let decision = ReconcileDecision.decide(expected: expected, providerState: providerState, policy: cached.policy, breakPolicy: cached.breakPolicy, hasSelection: hasSelection)
        outcome.decision = decision
        var applied = decision.appliedState
        enforcementFailed = false

        if decision.isChange {
            do {
                try perform(decision.action)
            } catch RestrictionProviderError.noSelection {
                applied = .permissionError
                flags?.selectionIncomplete = true
            } catch RestrictionProviderError.notAuthorized {
                applied = .permissionError
            } catch {
                ClockOffLog.restrictions.error("reconcile: applying \(String(describing: decision.action), privacy: .public) failed: \(String(describing: error), privacy: .public)")
                applied = .unknown
                enforcementFailed = true
            }
            let events = record(applied: applied, expected: expected, permission: permission, at: instant, reason: decision.reason)
            outcome.queuedEvents.append(contentsOf: events)
            outcome.note = decision.reason == ReconcileDecision.reasonUnknownCorrected
                ? "UNKNOWN → corrected: \(providerState.state.rawValue) → \(applied.rawValue)"
                : "\(providerState.state.rawValue) → \(applied.rawValue) (\(decision.action))"
            ClockOffLog.restrictions.info("reconcile (\(reason, privacy: .public)): \(outcome.note, privacy: .public)")
        } else {
            _ = try? cache.update { $0.lastReconcileAt = instant }
        }
        outcome.appliedState = applied

        // 3. Publish.
        expectedState = expected
        needsBreakSelection = (flags?.selectionIncomplete ?? false)
            && (cached.policy.map { RestrictionPlan.make(shiftId: "", policy: $0, breakPolicy: cached.breakPolicy).requiresBreakSubsetSelection } ?? false)
        state = UIWorkStateBuilder.make(
            expected: expected,
            cache: cache.load() ?? cached,
            permission: permission,
            hasSelection: hasSelection,
            enforcementFailed: enforcementFailed,
            allowance: allowance(for: expected, cache: cached, at: instant),
            now: instant
        )
        lastOutcome = outcome
        scheduleWake(for: expected)
        return outcome
    }

    /// Re-plans every DeviceActivity schedule from the cache: plans.json is written BEFORE monitoring starts so
    /// a callback always finds its entry. Returns the plans written (nil when nothing can be scheduled).
    @discardableResult
    func replanActivities() throws -> PlansFile? {
        let instant = now()
        guard let cached = cache.load(), cached.isJoined, provider.authorizationStatus == .approved else { return nil }
        let entries = planner.plan(
            now: instant,
            shifts: cached.shifts,
            activeBreak: cached.activeBreakSession,
            policy: cached.policy,
            breakPolicy: cached.breakPolicy,
            timeZone: timeZone(),
            options: .forPolicy(cached.policy)
        )
        let file = PlansFile(generatedAt: instant, organisationName: cached.organisation?.name, entries: entries)
        try plans.write(file)
        provider.cancelAllActivities()
        try provider.scheduleActivities(file.activities)
        return file
    }

    // MARK: Breaks

    /// The allowance for the shift in progress (or the next one), from the cached break policy.
    var breakAllowance: BreakAllowance? {
        guard let cached = cache.load() else { return nil }
        let instant = now()
        return allowance(for: expectedState ?? evaluate(cached, permission: .approved, at: instant), cache: cached, at: instant)
    }

    /// Starts a break for the shift in progress. Checks the cached policy first (instant feedback), then asks the
    /// server; if the network is down the break starts offline and is queued for replay. Applies the relaxation,
    /// registers the DeviceActivity that ends it with the app closed, and arms a timer for the exact end.
    @discardableResult
    func startBreak(requestedDurationMinutes: Int? = nil) async throws -> BreakSession {
        let instant = now()
        guard let cached = cache.load(), cached.isJoined else { throw APIError.notSignedIn() }
        guard let rules = cached.breakPolicy?.rules else {
            throw BreakRefusal(code: .breaksDisabled, message: "Your workplace has not set up breaks in ClockOff.", details: .breaksDisabled(reason: .breaksDisabled))
        }
        let permission = provider.authorizationStatus.permissionState(previous: cached.lastPermissionState)
        let expected = evaluate(cached, permission: permission, at: instant)
        guard let shift = expected.activeShift else {
            let upcoming = expected.upcomingShift
            let reason: NotOnShiftReason = upcoming != nil && expected.state == .shiftStartingSoon ? .shiftNotStarted : .shiftEnded
            throw BreakRefusal(code: .notOnShift, message: reason == .shiftNotStarted ? "Your shift has not started yet." : "You're not on shift right now.",
                               details: .notOnShift(reason: reason, shiftStartsAt: upcoming?.startsAt ?? instant, shiftEndsAt: upcoming?.endsAt ?? instant))
        }
        let approval = try BreakRules.throwIfCannotStartBreak(policy: rules, shift: shift, existingSessions: cached.breakSessions, now: instant,
                                                              requestedDurationMinutes: requestedDurationMinutes, trigger: .employee)

        isBreakRequestInFlight = true
        defer { isBreakRequestInFlight = false }
        let clientBreakId = UUID().uuidString.lowercased()
        var session: BreakSession
        var isLocal = false
        if let breakAPI {
            do {
                session = try await breakAPI.startBreak(clientBreakId: clientBreakId, shiftId: shift.id, requestedAt: instant, requestedDurationMinutes: requestedDurationMinutes)
                try ledger.recordServerBreak(session)
            } catch let error as APIError where error.isTransient || error.code == .credentialsUnavailable {
                ClockOffLog.restrictions.info("break start offline (\(error.code.rawValue, privacy: .public)): using the cached policy")
                session = try ledger.startLocalBreak(approval: approval, shiftId: shift.id, clientBreakId: clientBreakId, requestedAt: instant, requestedDurationMinutes: requestedDurationMinutes)
                isLocal = true
            }
        } else {
            session = try ledger.startLocalBreak(approval: approval, shiftId: shift.id, clientBreakId: clientBreakId, requestedAt: instant, requestedDurationMinutes: requestedDurationMinutes)
            isLocal = true
        }

        // Relaxation now, the DeviceActivity for the end (plans.json first), the event, then the UI.
        let updated = cache.load() ?? cached
        let onBreak = evaluate(updated, permission: permission, at: instant)
        var applied: WorkModeState = onBreak.state
        do {
            try perform(RestrictionReconciler.action(for: onBreak, policy: updated.policy, breakPolicy: updated.breakPolicy))
        } catch RestrictionProviderError.noSelection {
            applied = .permissionError
            flags?.selectionIncomplete = true
        } catch {
            ClockOffLog.restrictions.error("applying the break relaxation failed: \(String(describing: error), privacy: .public)")
            applied = .unknown
        }
        scheduleBreakActivity(for: session, policy: updated.policy, breakPolicy: updated.breakPolicy, at: instant)
        _ = record(applied: applied, expected: onBreak, permission: permission, at: instant, reason: WorkModeController.reasonBreakStarted)
        _ = try? outbox.append(DeviceEvent(
            type: .breakStarted,
            occurredAt: session.startedAt,
            metadata: WorkModeEvents.breakMetadata(for: session, isLocal: isLocal, reason: isLocal ? BreakLedger.reasonOfflineStart : nil, engineState: applied)
        ))
        reconcile(reason: WorkModeController.reasonBreakStarted)
        return session
    }

    /// Ends the running break now. The server is told when it knows the break; otherwise (offline, or a break
    /// that never reached it) the end is queued with the start. Work shields come back through `reconcile()`.
    func endBreakEarly() async throws {
        let instant = now()
        guard let cached = cache.load(), let session = cached.activeBreakSession, session.status == .active, session.endedAt == nil,
              session.plannedEndsAt > instant else {
            throw APIError(code: .breakNotActive, message: "No break is running.", status: 0)
        }
        isBreakRequestInFlight = true
        defer { isBreakRequestInFlight = false }
        let endedAt = max(session.startedAt, min(instant, session.plannedEndsAt))
        var queueEnd = cached.isLocalBreak(session)
        if let breakAPI, !queueEnd {
            do {
                try await breakAPI.endBreak(id: session.id, endedAt: endedAt, reason: .employeeEnded)
            } catch let error as APIError where error.isTransient || error.code == .credentialsUnavailable {
                ClockOffLog.restrictions.info("break end offline (\(error.code.rawValue, privacy: .public)): queued for replay")
                queueEnd = true
            }
        }
        if let closure = ledger.endActiveBreak(matching: session.clientBreakId, endedAt: endedAt, reason: .employeeEnded, eventType: .breakEnded,
                                               eventReason: BreakLedger.reasonEmployeeEnded, queueEndForServer: queueEnd) {
            cancelBreakActivity(for: closure.session, at: instant)
        }
        reconcile(reason: WorkModeController.reasonBreakEnded)
    }

    /// Settings › Screen Time, for "Action Required".
    var settingsURL: URL? { URL(string: UIApplication.openSettingsURLString) }

    // MARK: Private

    private func evaluate(_ cached: CachedState, permission: PermissionState, at instant: Date) -> ExpectedState {
        let engine = WorkModeEngine(options: .forPolicy(cached.policy), timezone: timeZone().identifier, employeeId: cached.employee?.id)
        return engine.computeExpectedState(now: instant, shifts: cached.shifts, breakSessions: cached.breakSessions,
                                           overrides: cached.activeOverrides, permissionState: permission)
    }

    private func allowance(for expected: ExpectedState, cache cached: CachedState, at instant: Date) -> BreakAllowance? {
        guard let rules = cached.breakPolicy?.rules, let shift = expected.activeShift ?? expected.upcomingShift else { return cached.breakAllowance }
        return BreakRules.computeBreakAllowance(policy: rules, shift: shift, sessions: cached.breakSessions, now: instant)
    }

    private func perform(_ action: RestrictionAction) throws {
        switch action {
        case .applyWork(let plan):
            try provider.applyWorkRestrictions(plan: plan)
        case .applyBreak(let plan, let behaviour):
            try provider.applyBreakRestrictions(plan: plan, behaviour: behaviour)
        case .clear:
            try provider.clearRestrictions()
        case .leaveUnchanged:
            break
        }
    }

    /// Persists the applied engine state and the implied WORK_MODE_* events in one coordinated write, so a sync
    /// running at the same time sees the new state and does not repeat the events. Returns the queued types.
    private func record(applied: WorkModeState, expected: ExpectedState, permission: PermissionState, at instant: Date, reason: String) -> [ActivityEventType] {
        var snapshot = expected
        snapshot.state = applied
        snapshot.permissionState = permission
        var queued: [ActivityEventType] = []
        do {
            try cache.update { state in
                let events = WorkModeEvents.transitionEvents(from: state.engineState?.state, to: snapshot, at: instant, reason: reason)
                state.engineState = RestrictionEngineState(state: applied, source: .appEngine, updatedAt: instant)
                state.lastReconcileAt = instant
                let known = Set(state.outbox.map { $0.clientEventId.lowercased() })
                for event in events where !known.contains(event.clientEventId.lowercased()) {
                    state.outbox.append(event)
                    queued.append(event.type)
                }
                if state.outbox.count > EventOutbox.maxEvents { state.outbox.removeFirst(state.outbox.count - EventOutbox.maxEvents) }
            }
        } catch {
            ClockOffLog.restrictions.error("recording engine state failed: \(String(describing: error), privacy: .public)")
        }
        return queued
    }

    /// plans.json entry first, then the DeviceActivity (Apple's 15-minute floor; the true end is in the entry).
    private func scheduleBreakActivity(for session: BreakSession, policy: PolicySummary?, breakPolicy: BreakPolicy?, at instant: Date) {
        guard let scheduler = provider as? BreakScheduling, let policy else { return }
        let clientBreakId = session.clientBreakId.isEmpty ? session.id : session.clientBreakId
        let plan = RestrictionPlan.make(shiftId: session.shiftId, policy: policy, breakPolicy: breakPolicy)
        let behaviour = BreakBehaviour.from(restrictionBehaviour: session.restrictionBehaviour, relaxedCategories: session.relaxedCategories, planCategories: plan.categories)
        let activity = BreakActivitySchedule.make(clientBreakId: clientBreakId, shiftId: session.shiftId, startedAt: session.startedAt,
                                                  plannedEndsAt: session.plannedEndsAt, timeZone: timeZone())
        do {
            try plans.upsert(PlanEntry(shiftId: session.shiftId, plan: plan, activity: activity, breakBehaviour: behaviour, clientBreakId: clientBreakId), at: instant)
            try scheduler.scheduleBreak(clientBreakId: clientBreakId, shiftId: session.shiftId, startedAt: session.startedAt, plannedEndsAt: session.plannedEndsAt)
        } catch {
            // The app's own timer and the next sync still end the break; the extension would only have been a backstop.
            ClockOffLog.restrictions.error("scheduling the break activity failed: \(String(describing: error), privacy: .public)")
        }
    }

    private func cancelBreakActivity(for session: BreakSession, at instant: Date) {
        let clientBreakId = session.clientBreakId.isEmpty ? session.id : session.clientBreakId
        (provider as? BreakScheduling)?.cancelBreakActivity(clientBreakId: clientBreakId)
        try? plans.remove(activityNamed: ActivityNaming.breakActivity(clientBreakId: clientBreakId), at: instant)
    }

    /// Arms a timer for the next instant the output changes (or the running break's end) while the app is alive.
    private func scheduleWake(for expected: ExpectedState?) {
        wakeTask?.cancel()
        wakeTask = nil
        guard let expected else { return }
        var candidates: [Date] = []
        if let next = expected.nextTransitionAt { candidates.append(next) }
        if let activeBreak = expected.activeBreak { candidates.append(activeBreak.endsAt) }
        guard let at = candidates.min() else { return }
        let delay = min(max(0, at.timeIntervalSince(now())) + 0.1, 24 * 60 * 60)
        wakeTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.reconcile(reason: WorkModeController.reasonTimer)
        }
    }
}
