import Foundation

// Swift port of `packages/shared/src/breaks/breakRules.ts` (§6.3, docs/BREAK_RULES.md). Pure functions over
// absolute UTC instants: no clocks, no I/O, no timezones. The device evaluates them against its cached break
// policy for the optimistic UI and for breaks started offline; the server's answer is always authoritative.
//
// Check precedence in `canStartBreak` (first failing check wins):
//   1. BREAKS_DISABLED              policy.breaksEnabled false, or no usable break duration
//   2. EMPLOYEE_BREAKS_NOT_ALLOWED  trigger EMPLOYEE while employeeTriggeredAllowed is false
//      BREAKS_DISABLED              trigger SCHEDULED while scheduledBreaksAllowed is false
//   3. VALIDATION_ERROR             requestedDurationMinutes present but < 1 (Swift `Date`s are always valid)
//   4. BREAK_TOO_LONG               requestedDurationMinutes > maxBreakDurationMinutes
//   5. NOT_ON_SHIFT                 now < shift.startsAt / now ≥ shift.endsAt / < 1 minute of shift left
//   6. BREAK_ALREADY_ACTIVE         a session of this shift is still running at `now` (or a later break is recorded)
//   7. BREAK_LIMIT_REACHED          maxBreaksPerShift used up, or < 1 minute of maxTotalBreakMinutes left
//   8. BREAK_TOO_SOON               minMinutesAfterShiftStart / minGapBetweenBreaksMinutes (skipped for MANAGER)
// MANAGER bypasses 2 and 8 only.

/// Who (or what) is asking for the break (`BreakTrigger`).
public enum BreakTrigger: String, Codable, CaseIterable, Sendable {
    case employee = "EMPLOYEE"
    case scheduled = "SCHEDULED"
    case manager = "MANAGER"
}

public enum BreaksDisabledReason: String, Codable, Sendable {
    case breaksDisabled = "BREAKS_DISABLED"
    case scheduledBreaksNotAllowed = "SCHEDULED_BREAKS_NOT_ALLOWED"
    case noBreakDuration = "NO_BREAK_DURATION"
}

public enum NotOnShiftReason: String, Codable, Sendable {
    case shiftNotStarted = "SHIFT_NOT_STARTED"
    case shiftEnded = "SHIFT_ENDED"
    case shiftEnding = "SHIFT_ENDING"
}

public enum BreakLimitReason: String, Codable, Sendable {
    case maxBreaksPerShift = "MAX_BREAKS_PER_SHIFT"
    case maxTotalBreakMinutes = "MAX_TOTAL_BREAK_MINUTES"
}

public enum BreakTooSoonReason: String, Codable, Sendable {
    case minMinutesAfterShiftStart = "MIN_MINUTES_AFTER_SHIFT_START"
    case minGapBetweenBreaks = "MIN_GAP_BETWEEN_BREAKS"
}

public enum BreakAlreadyActiveReason: String, Codable, Sendable {
    case breakInProgress = "BREAK_IN_PROGRESS"
    case laterBreakRecorded = "LATER_BREAK_RECORDED"
}

/// `details` of a refusal, one case per refusal code (`BreakRefusal` in TS).
public enum BreakRefusalDetails: Equatable, Sendable {
    case breaksDisabled(reason: BreaksDisabledReason)
    case employeeBreaksNotAllowed
    case validation(field: String, value: String)
    case tooLong(requestedDurationMinutes: Int, maxBreakDurationMinutes: Int)
    case notOnShift(reason: NotOnShiftReason, shiftStartsAt: Date, shiftEndsAt: Date)
    case alreadyActive(reason: BreakAlreadyActiveReason, sessionId: String, startedAt: Date, plannedEndsAt: Date)
    case limitReached(reason: BreakLimitReason, breaksTaken: Int, maxBreaksPerShift: Int, minutesUsed: Int, maxTotalBreakMinutes: Int)
    case tooSoon(reason: BreakTooSoonReason, eligibleAt: Date, waitMinutes: Int)

    /// The `reason` code, when the refusal has one (for event metadata).
    public var reasonCode: String? {
        switch self {
        case .breaksDisabled(let reason): return reason.rawValue
        case .employeeBreaksNotAllowed: return nil
        case .validation: return nil
        case .tooLong: return nil
        case .notOnShift(let reason, _, _): return reason.rawValue
        case .alreadyActive(let reason, _, _, _): return reason.rawValue
        case .limitReached(let reason, _, _, _, _): return reason.rawValue
        case .tooSoon(let reason, _, _): return reason.rawValue
        }
    }
}

/// Why a break may not start. `code` is always an API error code, so a local refusal reads like a server one.
public struct BreakRefusal: Error, Equatable, Sendable, LocalizedError {
    public var code: APIErrorCode
    public var message: String
    public var details: BreakRefusalDetails

    public init(code: APIErrorCode, message: String, details: BreakRefusalDetails) {
        self.code = code
        self.message = message
        self.details = details
    }

    public var errorDescription: String? { message }

    /// The same refusal as an `APIError` (status 0: decided on the device).
    public var apiError: APIError {
        APIError(code: code, message: message, status: 0)
    }
}

/// Allowance left once the approved break has run in full.
public struct BreakRemaining: Equatable, Sendable {
    public var breaks: Int
    public var minutes: Int

    public init(breaks: Int, minutes: Int) {
        self.breaks = breaks
        self.minutes = minutes
    }
}

/// `BreakStartApproval`.
public struct BreakStartApproval: Equatable, Sendable {
    /// Equal to `now`.
    public var startsAt: Date
    /// Absolute UTC instant; never later than `shift.endsAt`.
    public var plannedEndsAt: Date
    /// Whole minutes this break counts against the allowance: `ceil((plannedEndsAt − startsAt) / 1 min)`.
    public var durationMinutes: Int
    public var remaining: BreakRemaining
    /// Snapshot to persist on the session so a policy change mid-break does not alter it.
    public var behaviour: BreakBehaviourSnapshot

    public init(startsAt: Date, plannedEndsAt: Date, durationMinutes: Int, remaining: BreakRemaining, behaviour: BreakBehaviourSnapshot) {
        self.startsAt = startsAt
        self.plannedEndsAt = plannedEndsAt
        self.durationMinutes = durationMinutes
        self.remaining = remaining
        self.behaviour = behaviour
    }
}

public enum CanStartBreakResult: Equatable, Sendable {
    case ok(BreakStartApproval)
    case refused(BreakRefusal)

    public var isOk: Bool {
        if case .ok = self { return true }
        return false
    }

    public var approval: BreakStartApproval? {
        if case .ok(let approval) = self { return approval }
        return nil
    }

    public var refusal: BreakRefusal? {
        if case .refused(let refusal) = self { return refusal }
        return nil
    }

    /// The approval, or the refusal thrown as an error.
    public func get() throws -> BreakStartApproval {
        switch self {
        case .ok(let approval): return approval
        case .refused(let refusal): throw refusal
        }
    }
}

/// What the restriction engine applies while a break session is active (`BreakRestriction`).
public struct BreakRestriction: Equatable, Sendable {
    public var restrictionBehaviour: BreakRestrictionBehaviour
    public var relaxedCategories: [RestrictionCategory]
    public var effectiveRestriction: EffectiveRestriction
    public var restrictionsShouldBeActive: Bool
    public var liftedCategories: [RestrictionCategory]
}

/// A write that closes an ACTIVE session whose time is up (`BreakSessionClosure`).
public struct BreakSessionClosure: Equatable, Sendable {
    public var sessionId: String
    public var endedAt: Date
    /// SHIFT_ENDED when the shift end cut the break short, else EXPIRED.
    public var endReason: BreakEndReason
}

public enum BreakRules {
    /// A break shorter than this is never started; a shift with less than this left refuses breaks.
    public static let minBreakDurationMinutes = 1
    /// DeviceActivity cannot reliably fire for intervals shorter than this (minutes).
    public static let deviceActivityMinReliableIntervalMinutes = 15
    /// |skew| strictly above this is shown to managers as NEEDS_ATTENTION (`DEVICE_STATUS_THRESHOLDS.clockSkewSeconds`).
    public static let clockSkewAttentionThresholdSeconds = 300

    // MARK: Session accounting

    private struct SessionSpan {
        let session: BreakSession
        let startMs: Int64
        /// Effective end so far: the session's end, or `now` while it is running.
        let endMs: Int64
        /// Where the session stops (for a running session: its cap). Equal to `endMs` once over.
        let projectedEndMs: Int64
    }

    private struct ShiftBreakSummary {
        var blocking: SessionSpan?
        var breaksTaken = 0
        var minutesUsed = 0
        var projectedMinutesUsed = 0
        var lastEndMs: Int64?
    }

    static func ms(_ date: Date) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1000).rounded())
    }

    static func date(ms: Int64) -> Date {
        Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
    }

    private static func minutesToMs(_ minutes: Int) -> Int64 {
        Int64(minutes) * 60_000
    }

    /// Whole minutes, rounded up; never negative.
    static func ceilMinutes(_ ms: Int64) -> Int {
        ms <= 0 ? 0 : Int((ms + 59_999) / 60_000)
    }

    private static func wholeMinutes(_ value: Int) -> Int {
        max(0, value)
    }

    /// Resolves what a session means at `now` (its time is capped at `min(plannedEndsAt, shift.endsAt)`).
    private static func span(of session: BreakSession, nowMs: Int64, shiftEndMs: Int64) -> SessionSpan {
        let startMs = ms(session.startedAt)
        let capMs = max(startMs, min(ms(session.plannedEndsAt), shiftEndMs))
        if let endedAt = session.endedAt {
            let endMs = max(startMs, min(ms(endedAt), capMs))
            return SessionSpan(session: session, startMs: startMs, endMs: endMs, projectedEndMs: endMs)
        }
        switch session.status {
        case .ended:
            return SessionSpan(session: session, startMs: startMs, endMs: capMs, projectedEndMs: capMs)
        case .active:
            if capMs <= nowMs { return SessionSpan(session: session, startMs: startMs, endMs: capMs, projectedEndMs: capMs) }
            return SessionSpan(session: session, startMs: startMs, endMs: max(startMs, nowMs), projectedEndMs: capMs)
        }
    }

    private static func sessions(of shift: ShiftRef, in sessions: [BreakSession]) -> [BreakSession] {
        sessions.filter { $0.shiftId == shift.id }
    }

    private static func summarise(_ sessions: [BreakSession], shift: ShiftRef, nowMs: Int64) -> ShiftBreakSummary {
        let shiftEndMs = ms(shift.endsAt)
        var summary = ShiftBreakSummary()
        for session in self.sessions(of: shift, in: sessions) {
            let span = span(of: session, nowMs: nowMs, shiftEndMs: shiftEndMs)
            summary.breaksTaken += 1
            summary.minutesUsed += ceilMinutes(span.endMs - span.startMs)
            summary.projectedMinutesUsed += ceilMinutes(span.projectedEndMs - span.startMs)
            if summary.lastEndMs.map({ span.projectedEndMs > $0 }) ?? true { summary.lastEndMs = span.projectedEndMs }
            if span.projectedEndMs > nowMs, summary.blocking.map({ span.startMs < $0.startMs }) ?? true {
                summary.blocking = span
            }
        }
        return summary
    }

    // MARK: Public API

    /// `min(requested ?? maxBreakDuration, maxBreakDuration, remainingAllowance)`, never negative.
    public static func clampBreak(maxBreakDurationMinutes: Int, requestedDurationMinutes: Int?, remainingAllowanceMinutes: Int) -> Int {
        let perBreakMax = wholeMinutes(maxBreakDurationMinutes)
        let requested = requestedDurationMinutes.map(wholeMinutes) ?? perBreakMax
        return min(requested, perBreakMax, wholeMinutes(remainingAllowanceMinutes))
    }

    private static func policyGrantsBreaks(_ policy: BreakPolicyRules) -> Bool {
        policy.breaksEnabled && wholeMinutes(policy.maxBreakDurationMinutes) >= minBreakDurationMinutes
    }

    private static func triggerAllowed(_ policy: BreakPolicyRules, _ trigger: BreakTrigger) -> Bool {
        switch trigger {
        case .employee: return policy.employeeTriggeredAllowed
        case .scheduled: return policy.scheduledBreaksAllowed
        case .manager: return true
        }
    }

    /// Decides whether a break may start at `now` and, if so, exactly when it must end. Never throws.
    public static func canStartBreak(
        policy: BreakPolicyRules,
        shift: ShiftRef,
        existingSessions: [BreakSession],
        now: Date,
        requestedDurationMinutes: Int? = nil,
        trigger: BreakTrigger
    ) -> CanStartBreakResult {
        // 1–2. Policy-level gates.
        if !policy.breaksEnabled {
            return refuse(.breaksDisabled, "Breaks are disabled by the break policy.", .breaksDisabled(reason: .breaksDisabled))
        }
        if !policyGrantsBreaks(policy) {
            return refuse(.breaksDisabled, "The break policy allows no break duration.", .breaksDisabled(reason: .noBreakDuration))
        }
        if !triggerAllowed(policy, trigger) {
            switch trigger {
            case .employee:
                return refuse(.employeeBreaksNotAllowed, "Employees cannot start breaks under this break policy.", .employeeBreaksNotAllowed)
            case .scheduled:
                return refuse(.breaksDisabled, "Scheduled breaks are not allowed by the break policy.", .breaksDisabled(reason: .scheduledBreaksNotAllowed))
            case .manager:
                break
            }
        }

        // 3–4. Input checks (Swift `Date`s are always valid instants).
        if let requested = requestedDurationMinutes {
            if requested < minBreakDurationMinutes {
                return refuse(.validationError, "requestedDurationMinutes must be a whole number of minutes ≥ 1.",
                              .validation(field: "requestedDurationMinutes", value: String(requested)))
            }
            if requested > policy.maxBreakDurationMinutes {
                return refuse(.breakTooLong, "Breaks are limited to \(policy.maxBreakDurationMinutes) minutes under this break policy.",
                              .tooLong(requestedDurationMinutes: requested, maxBreakDurationMinutes: policy.maxBreakDurationMinutes))
            }
        }

        // 5. Shift bounds — nobody bypasses these.
        let nowMs = ms(now)
        let shiftStartMs = ms(shift.startsAt)
        let shiftEndMs = ms(shift.endsAt)
        if nowMs < shiftStartMs {
            return refuse(.notOnShift, "The shift has not started yet.", .notOnShift(reason: .shiftNotStarted, shiftStartsAt: shift.startsAt, shiftEndsAt: shift.endsAt))
        }
        if nowMs >= shiftEndMs {
            return refuse(.notOnShift, "The shift has ended.", .notOnShift(reason: .shiftEnded, shiftStartsAt: shift.startsAt, shiftEndsAt: shift.endsAt))
        }
        if shiftEndMs - nowMs < minutesToMs(minBreakDurationMinutes) {
            return refuse(.notOnShift, "The shift is ending; there is no time left for a break.", .notOnShift(reason: .shiftEnding, shiftStartsAt: shift.startsAt, shiftEndsAt: shift.endsAt))
        }

        // 6. Active break (breaks never overlap).
        let summary = summarise(existingSessions, shift: shift, nowMs: nowMs)
        if let blocking = summary.blocking {
            let inProgress = blocking.startMs <= nowMs
            return refuse(
                .breakAlreadyActive,
                inProgress ? "A break is already in progress." : "A later break is already recorded for this shift.",
                .alreadyActive(reason: inProgress ? .breakInProgress : .laterBreakRecorded, sessionId: blocking.session.id,
                               startedAt: blocking.session.startedAt, plannedEndsAt: blocking.session.plannedEndsAt)
            )
        }

        // 7. Limits.
        if summary.breaksTaken >= policy.maxBreaksPerShift {
            return refuse(.breakLimitReached, "All \(policy.maxBreaksPerShift) breaks for this shift have been used.",
                          .limitReached(reason: .maxBreaksPerShift, breaksTaken: summary.breaksTaken, maxBreaksPerShift: policy.maxBreaksPerShift,
                                        minutesUsed: summary.minutesUsed, maxTotalBreakMinutes: policy.maxTotalBreakMinutes))
        }
        let minutesRemaining = max(0, policy.maxTotalBreakMinutes - summary.minutesUsed)
        if minutesRemaining < minBreakDurationMinutes {
            return refuse(.breakLimitReached, "All \(policy.maxTotalBreakMinutes) break minutes for this shift have been used.",
                          .limitReached(reason: .maxTotalBreakMinutes, breaksTaken: summary.breaksTaken, maxBreaksPerShift: policy.maxBreaksPerShift,
                                        minutesUsed: summary.minutesUsed, maxTotalBreakMinutes: policy.maxTotalBreakMinutes))
        }

        // 8. Timing (MANAGER bypasses).
        if trigger != .manager {
            let afterStartMs = shiftStartMs + minutesToMs(policy.minMinutesAfterShiftStart)
            if nowMs < afterStartMs {
                return tooSoon(.minMinutesAfterShiftStart, eligibleMs: afterStartMs, nowMs: nowMs, ruleMinutes: policy.minMinutesAfterShiftStart)
            }
            if let lastEndMs = summary.lastEndMs {
                let gapMs = lastEndMs + minutesToMs(policy.minGapBetweenBreaksMinutes)
                if nowMs < gapMs {
                    return tooSoon(.minGapBetweenBreaks, eligibleMs: gapMs, nowMs: nowMs, ruleMinutes: policy.minGapBetweenBreaksMinutes)
                }
            }
        }

        // Duration: per-break cap, then total allowance, then the shift end (never past it).
        let durationMinutes = clampBreak(maxBreakDurationMinutes: policy.maxBreakDurationMinutes, requestedDurationMinutes: requestedDurationMinutes,
                                         remainingAllowanceMinutes: minutesRemaining)
        let plannedEndMs = min(nowMs + minutesToMs(durationMinutes), shiftEndMs)
        let countedMinutes = ceilMinutes(plannedEndMs - nowMs)
        return .ok(BreakStartApproval(
            startsAt: date(ms: nowMs),
            plannedEndsAt: date(ms: plannedEndMs),
            durationMinutes: countedMinutes,
            remaining: BreakRemaining(
                breaks: max(0, policy.maxBreaksPerShift - summary.breaksTaken - 1),
                minutes: max(0, minutesRemaining - countedMinutes)
            ),
            behaviour: resolveBreakBehaviour(policy)
        ))
    }

    private static func refuse(_ code: APIErrorCode, _ message: String, _ details: BreakRefusalDetails) -> CanStartBreakResult {
        .refused(BreakRefusal(code: code, message: message, details: details))
    }

    private static func tooSoon(_ reason: BreakTooSoonReason, eligibleMs: Int64, nowMs: Int64, ruleMinutes: Int) -> CanStartBreakResult {
        let waitMinutes = ceilMinutes(eligibleMs - nowMs)
        let message: String
        switch reason {
        case .minMinutesAfterShiftStart:
            message = "Breaks can start \(ruleMinutes) minutes after the shift begins (in \(waitMinutes) min)."
        case .minGapBetweenBreaks:
            message = "Breaks must be \(ruleMinutes) minutes apart (next one in \(waitMinutes) min)."
        }
        return refuse(.breakTooSoon, message, .tooSoon(reason: reason, eligibleAt: date(ms: eligibleMs), waitMinutes: waitMinutes))
    }

    /// Allowance snapshot for the UI (`computeBreakAllowance`). `trigger` defaults to EMPLOYEE.
    public static func computeBreakAllowance(
        policy: BreakPolicyRules,
        shift: ShiftRef,
        sessions: [BreakSession],
        now: Date,
        trigger: BreakTrigger = .employee
    ) -> BreakAllowance {
        let nowMs = ms(now)
        let summary = summarise(sessions, shift: shift, nowMs: nowMs)
        let grants = policyGrantsBreaks(policy)
        let canStartNow = canStartBreak(policy: policy, shift: shift, existingSessions: sessions, now: now, trigger: trigger).isOk
        return BreakAllowance(
            breaksTaken: summary.breaksTaken,
            breaksRemaining: grants ? max(0, policy.maxBreaksPerShift - summary.breaksTaken) : 0,
            minutesUsed: summary.minutesUsed,
            minutesRemaining: grants ? max(0, policy.maxTotalBreakMinutes - summary.minutesUsed) : 0,
            nextEligibleAt: nextEligibleAt(policy: policy, shift: shift, summary: summary, nowMs: nowMs, trigger: trigger),
            canStartNow: canStartNow
        )
    }

    /// Mirrors `canStartBreak` over time, assuming no new session is recorded and running sessions run to
    /// their effective end. Invariant: `canStartBreak(now).ok` ⇔ `nextEligibleAt ≤ now`.
    private static func nextEligibleAt(policy: BreakPolicyRules, shift: ShiftRef, summary: ShiftBreakSummary, nowMs: Int64, trigger: BreakTrigger) -> Date? {
        guard policyGrantsBreaks(policy), triggerAllowed(policy, trigger) else { return nil }
        if summary.breaksTaken >= policy.maxBreaksPerShift { return nil }
        if policy.maxTotalBreakMinutes - summary.projectedMinutesUsed < minBreakDurationMinutes { return nil }

        let shiftStartMs = ms(shift.startsAt)
        // The last instant a break can start: one whole minute of shift must remain.
        let lastStartMs = ms(shift.endsAt) - minutesToMs(minBreakDurationMinutes)
        if nowMs > lastStartMs { return nil }
        // Breaks never overlap: nobody (not even MANAGER) can start before the latest break has ended.
        var eligibleMs = max(shiftStartMs, summary.lastEndMs ?? shiftStartMs)
        if trigger != .manager {
            eligibleMs = max(eligibleMs, shiftStartMs + minutesToMs(policy.minMinutesAfterShiftStart))
            if let lastEndMs = summary.lastEndMs {
                eligibleMs = max(eligibleMs, lastEndMs + minutesToMs(policy.minGapBetweenBreaksMinutes))
            }
        }
        if eligibleMs > lastStartMs { return nil }
        return date(ms: eligibleMs)
    }

    /// The ACTIVE sessions of `shift` whose time is up at `now`, and the write that closes each one, ordered
    /// by `startedAt` (`expiredBreakSessionClosures`).
    public static func expiredBreakSessionClosures(shift: ShiftRef, sessions: [BreakSession], now: Date) -> [BreakSessionClosure] {
        let nowMs = ms(now)
        let shiftEndMs = ms(shift.endsAt)
        var closures: [(closure: BreakSessionClosure, startMs: Int64)] = []
        for session in self.sessions(of: shift, in: sessions) where session.status == .active && session.endedAt == nil {
            let span = span(of: session, nowMs: nowMs, shiftEndMs: shiftEndMs)
            if span.projectedEndMs > nowMs { continue }
            closures.append((
                BreakSessionClosure(
                    sessionId: session.id,
                    endedAt: date(ms: span.projectedEndMs),
                    endReason: ms(session.plannedEndsAt) > shiftEndMs ? .shiftEnded : .expired
                ),
                span.startMs
            ))
        }
        return closures.sorted { $0.startMs < $1.startMs }.map(\.closure)
    }

    /// `canStartBreak`, but a refusal is thrown.
    public static func throwIfCannotStartBreak(
        policy: BreakPolicyRules,
        shift: ShiftRef,
        existingSessions: [BreakSession],
        now: Date,
        requestedDurationMinutes: Int? = nil,
        trigger: BreakTrigger
    ) throws -> BreakStartApproval {
        try canStartBreak(policy: policy, shift: shift, existingSessions: existingSessions, now: now,
                          requestedDurationMinutes: requestedDurationMinutes, trigger: trigger).get()
    }

    // MARK: Restriction behaviour during a break

    /// The behaviour snapshot to copy onto a new session: `relaxedCategories` is emptied unless RELAX_CATEGORIES.
    public static func resolveBreakBehaviour(_ policy: BreakPolicyRules) -> BreakBehaviourSnapshot {
        resolveBreakBehaviour(restrictionBehaviour: policy.restrictionBehaviour, relaxedCategories: policy.relaxedCategories)
    }

    public static func resolveBreakBehaviour(restrictionBehaviour: BreakRestrictionBehaviour, relaxedCategories: [RestrictionCategory]) -> BreakBehaviourSnapshot {
        switch restrictionBehaviour {
        case .relaxAll, .keepRestrictions:
            return BreakBehaviourSnapshot(restrictionBehaviour: restrictionBehaviour, relaxedCategories: [])
        case .relaxCategories:
            return BreakBehaviourSnapshot(restrictionBehaviour: restrictionBehaviour, relaxedCategories: RestrictionCategory.canonical(relaxedCategories))
        }
    }

    /// What the restriction engine applies while `session` is active — reads the session's stored snapshot,
    /// never the live policy. Same mapping as the state machine's ON_BREAK output.
    public static func breakRestrictionForSession(_ session: BreakSession) -> BreakRestriction {
        breakRestriction(restrictionBehaviour: session.restrictionBehaviour, relaxedCategories: session.relaxedCategories)
    }

    public static func breakRestriction(restrictionBehaviour: BreakRestrictionBehaviour, relaxedCategories: [RestrictionCategory]) -> BreakRestriction {
        let behaviour = resolveBreakBehaviour(restrictionBehaviour: restrictionBehaviour, relaxedCategories: relaxedCategories)
        switch behaviour.restrictionBehaviour {
        case .relaxAll:
            return BreakRestriction(restrictionBehaviour: .relaxAll, relaxedCategories: [], effectiveRestriction: .breakRelaxed,
                                    restrictionsShouldBeActive: false, liftedCategories: RestrictionCategory.allCases)
        case .keepRestrictions:
            return BreakRestriction(restrictionBehaviour: .keepRestrictions, relaxedCategories: [], effectiveRestriction: .work,
                                    restrictionsShouldBeActive: true, liftedCategories: [])
        case .relaxCategories:
            let lifted = behaviour.relaxedCategories
            return BreakRestriction(restrictionBehaviour: .relaxCategories, relaxedCategories: lifted,
                                    effectiveRestriction: lifted.isEmpty ? .work : .breakRelaxed,
                                    restrictionsShouldBeActive: lifted.count < RestrictionCategory.allCases.count, liftedCategories: lifted)
        }
    }

    /// True when `category` is unblocked during a break with the given behaviour snapshot.
    public static func isCategoryRelaxedDuringBreak(_ behaviour: BreakBehaviourSnapshot, _ category: RestrictionCategory) -> Bool {
        switch behaviour.restrictionBehaviour {
        case .relaxAll: return true
        case .keepRestrictions: return false
        case .relaxCategories: return behaviour.relaxedCategories.contains(category)
        }
    }

    // MARK: DeviceActivity and clock skew helpers (`clockSkew.ts`)

    /// True when a break of this length is too short for DeviceActivity to end it precisely with the app closed.
    public static func isBelowDeviceActivityInterval(durationMinutes: Int) -> Bool {
        durationMinutes < deviceActivityMinReliableIntervalMinutes
    }

    /// Positive when the device clock is ahead of the server; whole seconds.
    public static func computeClockSkewSeconds(deviceReportedAt: Date, serverReceivedAt: Date) -> Int {
        Int((deviceReportedAt.timeIntervalSince(serverReceivedAt)).rounded())
    }

    /// True when a reported skew should raise NEEDS_ATTENTION (|skew| > threshold).
    public static func clockSkewNeedsAttention(_ skewSeconds: Int?, threshold: Int = clockSkewAttentionThresholdSeconds) -> Bool {
        guard let skewSeconds else { return false }
        return abs(skewSeconds) > threshold
    }
}
