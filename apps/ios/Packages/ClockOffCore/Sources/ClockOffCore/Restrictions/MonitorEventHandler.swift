import Foundation

/// The DeviceActivityMonitor extension's logic, kept in Core so it runs in the simulator with in-memory stores.
/// iOS wakes the extension at the boundaries of the activities the app registered (`ActivityNaming`), even
/// with the app killed or after a reboot. Every callback:
///
/// - `intervalWillStartWarning(shift-*)` → `SharedFlags.shiftStartingSoon` + engine state SHIFT_STARTING_SOON.
/// - `intervalDidStart(shift-*)`         → apply the work shields from the plan (break behaviour if a break is
///                                          running, nothing under a lifting manager override), record WORKING
///                                          and queue WORK_MODE_STARTED.
/// - `intervalDidEnd(shift-*)`           → clear both stores (unless the cached schedule says another interval is
///                                          already running), end a running break (SHIFT_ENDED), record OFF_SHIFT
///                                          and queue WORK_MODE_ENDED.
/// - `intervalDidStart(break-*)`         → no-op: the app applied the relaxation when the break started.
/// - `intervalDidEnd(break-*)`           → if the break record is still active: restore the work shields, mark it
///                                          EXPIRED and queue BREAK_EXPIRED.
///
/// A callback whose activity has no plans.json entry is stale (the app re-planned since) and is ignored.
/// Events go through the outbox with a `reason`; the app and the extension both record what they applied in
/// `CachedState.engineState`, so whichever sees a transition first emits it.
public final class MonitorEventHandler {
    public static let reasonIntervalStarted = "INTERVAL_STARTED"
    public static let reasonIntervalEnded = "INTERVAL_ENDED"
    public static let reasonShiftEnded = "SHIFT_ENDED"

    /// What a callback did (for logs and tests).
    public struct Outcome: Equatable, Sendable {
        public var kind: String
        public var activityName: String
        public var applied: ShieldApplication?
        public var engineState: WorkModeState?
        public var queuedEvents: [ActivityEventType]
        public var note: String

        public init(kind: String, activityName: String, applied: ShieldApplication? = nil, engineState: WorkModeState? = nil, queuedEvents: [ActivityEventType] = [], note: String) {
            self.kind = kind
            self.activityName = activityName
            self.applied = applied
            self.engineState = engineState
            self.queuedEvents = queuedEvents
            self.note = note
        }
    }

    private let cache: StateCache
    private let plans: PlansStore
    private let outbox: EventOutbox
    private let ledger: BreakLedger
    private let applier: ShieldApplier
    private let flags: SharedFlags?
    private let timeZone: TimeZone
    private let permissionApproved: () -> Bool
    private let now: () -> Date

    public init(
        cache: StateCache,
        plans: PlansStore,
        applier: ShieldApplier,
        flags: SharedFlags? = nil,
        timeZone: TimeZone = .current,
        permissionApproved: @escaping () -> Bool = { true },
        now: @escaping () -> Date = Date.init
    ) {
        self.cache = cache
        self.plans = plans
        outbox = EventOutbox(cache: cache)
        ledger = BreakLedger(cache: cache)
        self.applier = applier
        self.flags = flags
        self.timeZone = timeZone
        self.permissionApproved = permissionApproved
        self.now = now
    }

    // MARK: Callbacks

    @discardableResult
    public func intervalWillStartWarning(activityName name: String) -> Outcome {
        let kind = "intervalWillStartWarning"
        guard case .shift(let shiftId, _)? = ActivityNaming.parse(name), plans.entry(forActivityNamed: name) != nil else {
            return finish(Outcome(kind: kind, activityName: name, note: "ignored: not a planned shift activity"))
        }
        let instant = now()
        flags?.shiftStartingSoon = SharedFlags.ShiftStartingSoon(activityName: name, shiftId: shiftId, at: instant)
        var recorded: WorkModeState?
        try? cache.update { state in
            // Never downgrade a running Work Mode (an adjacent interval may still be in force).
            if !WorkModeEngine.isActiveState(state.engineState?.state ?? .unknown) {
                state.engineState = RestrictionEngineState(state: .shiftStartingSoon, source: .monitorExtension, updatedAt: instant)
                recorded = .shiftStartingSoon
            }
        }
        return finish(Outcome(kind: kind, activityName: name, engineState: recorded, note: "flagged starting soon"))
    }

    @discardableResult
    public func intervalDidStart(activityName name: String) -> Outcome {
        let kind = "intervalDidStart"
        guard let parsed = ActivityNaming.parse(name) else {
            return finish(Outcome(kind: kind, activityName: name, note: "ignored: not ours"))
        }
        guard let entry = plans.entry(forActivityNamed: name) else {
            return finish(Outcome(kind: kind, activityName: name, note: "ignored: stale activity (no plan entry)"))
        }
        switch parsed {
        case .break:
            // The app applied the relaxation when the break started; nothing to do at the interval start.
            return finish(Outcome(kind: kind, activityName: name, note: "break interval started: no-op"))
        case .shift:
            return finish(startShift(entry: entry, activityName: name, kind: kind))
        }
    }

    @discardableResult
    public func intervalDidEnd(activityName name: String) -> Outcome {
        let kind = "intervalDidEnd"
        guard let parsed = ActivityNaming.parse(name) else {
            return finish(Outcome(kind: kind, activityName: name, note: "ignored: not ours"))
        }
        let entry = plans.entry(forActivityNamed: name)
        switch parsed {
        case .shift:
            guard let entry else { return finish(Outcome(kind: kind, activityName: name, note: "ignored: stale activity (no plan entry)")) }
            return finish(endShift(entry: entry, activityName: name, kind: kind))
        case .break(let clientBreakId):
            return finish(endBreak(clientBreakId: entry?.clientBreakId ?? clientBreakId, activityName: name, kind: kind))
        }
    }

    // MARK: Shifts

    private func startShift(entry: PlanEntry, activityName: String, kind: String) -> Outcome {
        let instant = now()
        let state = cache.load() ?? CachedState()
        let expected = evaluate(state, at: instant)
        flags?.shiftStartingSoon = nil

        var applied: ShieldApplication?
        var recorded: WorkModeState
        var note: String
        switch expected.state {
        case .managerOverride:
            applied = applier.clearAll()
            recorded = .managerOverride
            note = "lifting override active: shields stay down"
        case .permissionError:
            applied = applier.clearAll()
            recorded = .permissionError
            note = "Screen Time permission missing: nothing enforced"
        case .onBreak:
            // A break is already running at the interval start: apply its behaviour, not the full set.
            if case .applyBreak(_, let behaviour) = RestrictionReconciler.action(for: expected, policy: state.policy, breakPolicy: state.breakPolicy) {
                (applied, recorded, note) = applyOrReport({ try applier.applyBreak(behaviour) }, success: .onBreak, note: "break running at interval start")
            } else {
                (applied, recorded, note) = applyOrReport({ try applier.applyWork() }, success: .working, note: "applied work shields")
            }
        case .working, .shiftEnding, .offShift, .shiftStartingSoon, .syncError, .unknown:
            // Trust the plan the app registered (the engine may lag the DeviceActivity clock by a few seconds).
            let success: WorkModeState = expected.state == .shiftEnding ? .shiftEnding : .working
            (applied, recorded, note) = applyOrReport({ try applier.applyWork() }, success: success, note: "applied work shields for shift \(entry.shiftId)")
        }
        let events = record(recorded, at: instant, previous: state.engineState?.state, expected: expected, reason: MonitorEventHandler.reasonIntervalStarted)
        return Outcome(kind: kind, activityName: activityName, applied: applied, engineState: recorded, queuedEvents: events, note: note)
    }

    private func endShift(entry: PlanEntry, activityName: String, kind: String) -> Outcome {
        let instant = now()
        var state = cache.load() ?? CachedState()
        var expected = evaluate(state, at: instant)
        flags?.shiftStartingSoon = nil

        // The cached schedule may already hold a newer interval covering now (a shift added or extended since
        // this activity was registered): keep enforcing instead of lifting the shields.
        if WorkModeEngine.isActiveState(expected.state), let interval = expected.workingInterval, interval.endsAt > instant.addingTimeInterval(60) {
            var applied: ShieldApplication?
            var recorded: WorkModeState
            var note: String
            switch RestrictionReconciler.action(for: expected, policy: state.policy, breakPolicy: state.breakPolicy) {
            case .applyBreak(_, let behaviour):
                (applied, recorded, note) = applyOrReport({ try applier.applyBreak(behaviour) }, success: .onBreak, note: "another interval is running: kept break behaviour")
            case .applyWork, .clear, .leaveUnchanged:
                (applied, recorded, note) = applyOrReport({ try applier.applyWork() }, success: expected.state, note: "another interval is running: kept work shields")
            }
            let events = record(recorded, at: instant, previous: state.engineState?.state, expected: expected, reason: MonitorEventHandler.reasonIntervalEnded)
            return Outcome(kind: kind, activityName: activityName, applied: applied, engineState: recorded, queuedEvents: events, note: note)
        }

        let applied = applier.clearAll()
        var queued: [ActivityEventType] = []

        // Shift end always ends an active break.
        if let session = state.activeBreakSession, session.status == .active, session.endedAt == nil {
            let shiftEnd = entry.plannedEnd ?? instant
            let endedAt = min(instant, session.plannedEndsAt, max(shiftEnd, session.startedAt))
            // A break that ran to its planned end exactly at the shift end counts as expired (same tie rule as `breaks/`).
            let reason: BreakEndReason = session.plannedEndsAt <= shiftEnd && endedAt >= session.plannedEndsAt ? .expired : .shiftEnded
            if let closure = ledger.endActiveBreak(endedAt: endedAt, reason: reason, eventType: BreakLedger.eventType(for: reason),
                                                   eventReason: MonitorEventHandler.reasonShiftEnded) {
                state = closure.state
                queued.append(closure.event.type)
                expected = evaluate(state, at: instant)
            }
        }
        for breakEntry in plans.read()?.breakEntries ?? [] { try? plans.remove(activityNamed: breakEntry.activity.name, at: instant) }

        let recorded: WorkModeState = WorkModeEngine.isActiveState(expected.state) ? .offShift : expected.state
        let events = record(recorded, at: instant, previous: state.engineState?.state, expected: expected, reason: MonitorEventHandler.reasonIntervalEnded)
        return Outcome(kind: kind, activityName: activityName, applied: applied, engineState: recorded, queuedEvents: queued + events, note: "shift interval ended: shields cleared")
    }

    // MARK: Breaks

    private func endBreak(clientBreakId: String, activityName: String, kind: String) -> Outcome {
        let instant = now()
        guard let state = cache.load(), let session = state.activeBreakSession,
              session.clientBreakId.lowercased() == clientBreakId.lowercased() || session.id.lowercased() == clientBreakId.lowercased(),
              session.status == .active, session.endedAt == nil else {
            try? plans.remove(activityNamed: activityName, at: instant)
            return Outcome(kind: kind, activityName: activityName, note: "break already ended: no-op")
        }
        // The activity may be longer than the break (15-minute floor); it never ends before the planned end,
        // but a skewed clock must not cut a break short.
        guard session.plannedEndsAt <= instant.addingTimeInterval(60) else {
            return Outcome(kind: kind, activityName: activityName, note: "break interval ended before plannedEndsAt: ignored")
        }
        guard let closure = ledger.endActiveBreak(matching: clientBreakId, endedAt: session.plannedEndsAt, reason: .expired, eventType: .breakExpired,
                                                  eventReason: MonitorEventHandler.reasonIntervalEnded) else {
            return Outcome(kind: kind, activityName: activityName, note: "break record could not be updated")
        }
        let updated = closure.state
        try? plans.remove(activityNamed: activityName, at: instant)

        // Back to the shift's restriction (or off shift if the shift ended meanwhile).
        let expected = evaluate(updated, at: instant)
        var applied: ShieldApplication?
        var recorded: WorkModeState
        var note: String
        switch RestrictionReconciler.action(for: expected, policy: updated.policy, breakPolicy: updated.breakPolicy) {
        case .applyWork:
            (applied, recorded, note) = applyOrReport({ try applier.applyWork() }, success: expected.state, note: "break expired: work shields restored")
        case .applyBreak(_, let behaviour):
            (applied, recorded, note) = applyOrReport({ try applier.applyBreak(behaviour) }, success: expected.state, note: "break expired: another break applies")
        case .clear:
            applied = applier.clearAll()
            recorded = expected.state
            note = "break expired after the shift ended: shields cleared"
        case .leaveUnchanged:
            applied = nil
            recorded = expected.state
            note = "break expired: nothing to enforce"
        }
        let events = record(recorded, at: instant, previous: updated.engineState?.state, expected: expected, reason: MonitorEventHandler.reasonIntervalEnded)
        return Outcome(kind: kind, activityName: activityName, applied: applied, engineState: recorded, queuedEvents: [.breakExpired] + events, note: note)
    }

    // MARK: Helpers

    private func evaluate(_ state: CachedState, at instant: Date) -> ExpectedState {
        let permission: PermissionState = permissionApproved() ? .approved : (state.lastPermissionState == .approved ? .revoked : .denied)
        let engine = WorkModeEngine(options: .forPolicy(state.policy), timezone: timeZone.identifier, employeeId: state.employee?.id)
        return engine.computeExpectedState(
            now: instant,
            shifts: state.shifts,
            breakSessions: state.breakSessions,
            overrides: state.activeOverrides,
            permissionState: permission
        )
    }

    /// Runs `apply`; without a selection nothing can be enforced, which is recorded as PERMISSION_ERROR.
    private func applyOrReport(_ apply: () throws -> ShieldApplication, success: WorkModeState, note: String) -> (ShieldApplication?, WorkModeState, String) {
        do {
            return (try apply(), success, note)
        } catch RestrictionProviderError.noSelection {
            flags?.selectionIncomplete = true
            return (nil, .permissionError, "no selection to shield with")
        } catch {
            ClockOffLog.extensions.error("applying shields failed: \(String(describing: error), privacy: .public)")
            return (nil, .unknown, "applying shields failed")
        }
    }

    /// Persists the applied engine state and queues the implied WORK_MODE_* events. Returns the queued types.
    private func record(_ applied: WorkModeState, at instant: Date, previous: WorkModeState?, expected: ExpectedState, reason: String) -> [ActivityEventType] {
        var snapshot = expected
        snapshot.state = applied
        let events = WorkModeEvents.transitionEvents(from: previous, to: snapshot, at: instant, reason: reason)
        do {
            try cache.update { state in
                state.engineState = RestrictionEngineState(state: applied, source: .monitorExtension, updatedAt: instant)
            }
            if !events.isEmpty { try outbox.append(contentsOf: events) }
        } catch {
            ClockOffLog.extensions.error("recording engine state failed: \(String(describing: error), privacy: .public)")
        }
        return events.map(\.type)
    }

    private func finish(_ outcome: Outcome) -> Outcome {
        flags?.lastMonitorCallback = SharedFlags.MonitorCallback(kind: outcome.kind, activityName: outcome.activityName, at: now(), outcome: outcome.note)
        ClockOffLog.extensions.info("\(outcome.kind, privacy: .public) \(outcome.activityName, privacy: .public): \(outcome.note, privacy: .public)")
        return outcome
    }
}
