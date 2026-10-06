import Foundation

/// Activity event a transition implies (`ActivityEventType` on the server). `overrideExpired` is server-only
/// (`DEVICE_REPORTABLE_EVENT_TYPES` excludes it), so `deviceEventType` is nil for it.
public enum TransitionEventType: String, Codable, CaseIterable, Sendable {
    case permissionNeedsAttention = "PERMISSION_NEEDS_ATTENTION"
    case breakExpired = "BREAK_EXPIRED"
    case breakEnded = "BREAK_ENDED"
    case workModeEnded = "WORK_MODE_ENDED"
    case overrideExpired = "OVERRIDE_EXPIRED"
    case workModeStarted = "WORK_MODE_STARTED"
    case breakStarted = "BREAK_STARTED"

    /// The event a device may report through `POST /events`; nil for server-only events.
    public var deviceEventType: ActivityEventType? {
        switch self {
        case .permissionNeedsAttention: return .permissionNeedsAttention
        case .breakExpired: return .breakExpired
        case .breakEnded: return .breakEnded
        case .workModeEnded: return .workModeEnded
        case .workModeStarted: return .workModeStarted
        case .breakStarted: return .breakStarted
        case .overrideExpired: return nil
        }
    }
}

/// One observed change between two evaluations (`Transition` in the TS machine). A transition without
/// `eventType` records a state/restriction change that produces no activity event (WORKING → SHIFT_ENDING).
public struct WorkModeTransition: Equatable, Sendable {
    public var from: WorkModeState
    public var to: WorkModeState
    /// `next.computedAt`, the instant of observation.
    public var at: Date
    public var eventType: TransitionEventType?
    public var shiftId: String?
    public var breakSessionId: String?
    public var overrideId: String?

    public init(from: WorkModeState, to: WorkModeState, at: Date, eventType: TransitionEventType? = nil, shiftId: String? = nil, breakSessionId: String? = nil, overrideId: String? = nil) {
        self.from = from
        self.to = to
        self.at = at
        self.eventType = eventType
        self.shiftId = shiftId
        self.breakSessionId = breakSessionId
        self.overrideId = overrideId
    }
}

/// What was believed before: the full previous evaluation (preferred) or a bare persisted state.
public enum WorkModePrevious: Equatable, Sendable {
    case state(WorkModeState)
    case snapshot(ExpectedState)
}

/// Result of `WorkModeEngine.replayTransitions` (`ReplayResult`).
public struct WorkModeReplay: Equatable, Sendable {
    /// The state at `since`, then at each real change ≤ `now`; the last entry is evaluated at `now`.
    public var states: [ExpectedState]
    public var transitions: [WorkModeTransition]
}

extension WorkModeEngine {
    /// Port of `isWorkModeActiveState`: states in which Work Mode is in force.
    public static func isActiveState(_ state: WorkModeState) -> Bool {
        switch state {
        case .working, .onBreak, .shiftEnding:
            return true
        case .offShift, .shiftStartingSoon, .managerOverride, .permissionError, .syncError, .unknown:
            return false
        }
    }

    /// Port of `diffStates(prev, next)` (`packages/shared/src/workMode/diffStates.ts`): one transition per
    /// activity event the change implies, in causal order:
    ///  1. PERMISSION_NEEDS_ATTENTION  entered PERMISSION_ERROR
    ///  2. BREAK_EXPIRED / BREAK_ENDED the previous break is gone (EXPIRED when it ran to its plannedEndsAt)
    ///  3. WORK_MODE_ENDED             left an active state, or moved to a different working interval
    ///  4. OVERRIDE_EXPIRED            the previous override is gone and its expiresAt has passed
    ///  5. WORK_MODE_STARTED           entered an active state, or moved to a different working interval
    ///  6. BREAK_STARTED               a different break session is now running
    /// Otherwise one event-less transition when something changed, or `[]`.
    public static func diffStates(from previous: WorkModePrevious, to next: ExpectedState) -> [WorkModeTransition] {
        let prevSnap: ExpectedState?
        let from: WorkModeState
        switch previous {
        case .state(let state):
            prevSnap = nil
            from = state
        case .snapshot(let snapshot):
            prevSnap = snapshot
            from = snapshot.state
        }
        let to = next.state
        let at = next.computedAt

        let prevActive = isActiveState(from)
        let nextActive = isActiveState(to)

        let prevBreak = prevSnap?.activeBreak
        let nextBreak = next.activeBreak
        let prevOverride = prevSnap?.activeOverride
        let nextOverride = next.activeOverride

        // Same working interval? Only decidable with a full previous snapshot.
        var intervalChanged = false
        if let prevSnap, let prevInterval = prevSnap.workingInterval, let nextInterval = next.workingInterval {
            intervalChanged = !sameWorkingInterval(prevInterval, nextInterval)
        }

        let endedShiftId = prevSnap.flatMap { shiftInProgressBefore($0, at: at)?.id }

        var transitions: [WorkModeTransition] = []
        func emit(_ eventType: TransitionEventType, shiftId: String? = nil, breakSessionId: String? = nil, overrideId: String? = nil) {
            transitions.append(WorkModeTransition(from: from, to: to, at: at, eventType: eventType, shiftId: shiftId, breakSessionId: breakSessionId, overrideId: overrideId))
        }

        // 1. Permission problem surfaced.
        if to == .permissionError && from != .permissionError {
            emit(.permissionNeedsAttention, shiftId: next.activeShift?.id ?? next.upcomingShift?.id)
        }

        // 2. Break ended / expired.
        let breakEnded: Bool
        if prevSnap != nil {
            breakEnded = prevBreak != nil && prevBreak?.id != nextBreak?.id
        } else {
            breakEnded = from == .onBreak && nextBreak == nil
        }
        if breakEnded {
            emit(breakEndEventType(prevBreak, at: at), shiftId: prevBreak?.shiftId ?? prevSnap?.activeShift?.id, breakSessionId: prevBreak?.id)
        }

        // 3. Work mode ended.
        if (prevActive && !nextActive) || (prevActive && nextActive && intervalChanged) {
            emit(.workModeEnded, shiftId: endedShiftId, overrideId: to == .managerOverride ? nextOverride?.id : nil)
        }

        // 4. Override expired (not revoked, not merely out of window).
        if let prevOverride, prevOverride.id != nextOverride?.id, prevOverride.expiresAt <= at {
            emit(.overrideExpired, shiftId: endedShiftId, overrideId: prevOverride.id)
        }

        // 5. Work mode started.
        if (!prevActive && nextActive) || (prevActive && nextActive && intervalChanged) {
            emit(.workModeStarted, shiftId: next.activeShift?.id)
        }

        // 6. Break started.
        let breakStarted: Bool
        if prevSnap != nil {
            breakStarted = nextBreak != nil && nextBreak?.id != prevBreak?.id
        } else {
            breakStarted = to == .onBreak && from != .onBreak
        }
        if breakStarted {
            emit(.breakStarted, shiftId: nextBreak?.shiftId ?? next.activeShift?.id, breakSessionId: nextBreak?.id)
        }

        if !transitions.isEmpty { return transitions }

        let changed = from != to
            || intervalChanged
            || (prevSnap.map { restrictionSignature($0) != restrictionSignature(next) } ?? false)
        return changed ? [WorkModeTransition(from: from, to: to, at: at)] : []
    }

    /// Port of `replayTransitions(input, since, previous?)`: walks `nextTransitionAt` from `since` to `now`
    /// over the same rows and returns every state plus every transition at its exact instant. A change exactly
    /// at `since` is not included; one exactly at `now` is. With `previous`, differences between what was
    /// persisted at `since` and the state recomputed from today's rows are emitted first, stamped at `since`.
    public func replayTransitions(
        since: Date,
        now: Date,
        shifts: [Shift],
        breakSessions: [BreakSession],
        overrides: [ActiveOverride],
        permissionState: PermissionState,
        previous: WorkModePrevious? = nil,
        maxSteps: Int = 10_000
    ) -> WorkModeReplay {
        precondition(since <= now, "workMode: replay since is after now")
        func evaluate(_ at: Date) -> ExpectedState {
            computeExpectedState(now: at, shifts: shifts, breakSessions: breakSessions, overrides: overrides, permissionState: permissionState)
        }
        var current = evaluate(since)
        var states = [current]
        var transitions = previous.map { WorkModeEngine.diffStates(from: $0, to: current) } ?? []
        var step = 0
        while let at = current.nextTransitionAt, at <= now {
            precondition(step < maxSteps, "workMode: replay exceeded \(maxSteps) steps")
            step += 1
            let next = evaluate(at)
            transitions.append(contentsOf: WorkModeEngine.diffStates(from: .snapshot(current), to: next))
            states.append(next)
            current = next
        }
        // Close on `now` itself so callers can persist the final state; same signature, so no transitions.
        if current.computedAt != now {
            let final = evaluate(now)
            transitions.append(contentsOf: WorkModeEngine.diffStates(from: .snapshot(current), to: final))
            states.append(final)
        }
        return WorkModeReplay(states: states, transitions: transitions)
    }

    // MARK: Private helpers (`diffStates.ts`)

    /// Same stretch of work: the intervals overlap or touch (closed comparison, mirroring `mergeShiftIntervals`).
    private static func sameWorkingInterval(_ a: WorkingInterval, _ b: WorkingInterval) -> Bool {
        a.startsAt <= b.endsAt && b.startsAt <= a.endsAt
    }

    /// The shift in progress immediately before `at`, judged from `prev`'s working interval (its `activeShift`
    /// alone can be stale inside a merged interval of back-to-back shifts).
    private static func shiftInProgressBefore(_ prev: ExpectedState, at: Date) -> ShiftRef? {
        guard let activeShift = prev.activeShift, let interval = prev.workingInterval else { return prev.activeShift }
        let probe = min(at, interval.endsAt).addingTimeInterval(-0.001)
        // Never look before what `prev` itself observed (e.g. two evaluations at the same instant).
        if probe <= prev.computedAt { return activeShift }
        return coveringShift(in: interval, at: probe) ?? activeShift
    }

    /// EXPIRED only when the break ran to its planned end (a tie with its shift's end counts), else ENDED.
    private static func breakEndEventType(_ prevBreak: BreakRef?, at: Date) -> TransitionEventType {
        guard let prevBreak else { return .breakEnded }
        let ranFullLength = prevBreak.endsAt == prevBreak.plannedEndsAt
        return ranFullLength && prevBreak.plannedEndsAt <= at ? .breakExpired : .breakEnded
    }
}
