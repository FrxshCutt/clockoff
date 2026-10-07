import Foundation

/// Tunables of the state machine. Defaults match `DEFAULT_WORK_MODE_OPTIONS` in @clockoff/shared.
public struct WorkModeEngineOptions: Equatable, Sendable {
    /// Minutes before a shift start during which the state is SHIFT_STARTING_SOON. Default 15.
    public var preShiftWarningMinutes: Int
    /// Minutes before the end of a working interval during which the state is SHIFT_ENDING. Default 5.
    public var shiftEndingWarningMinutes: Int

    public init(preShiftWarningMinutes: Int = 15, shiftEndingWarningMinutes: Int = 5) {
        self.preShiftWarningMinutes = max(0, preShiftWarningMinutes)
        self.shiftEndingWarningMinutes = max(0, shiftEndingWarningMinutes)
    }

    /// Options for a resolved Work Policy (its `preShiftWarningMinutes`), default ending warning.
    public static func forPolicy(_ policy: PolicySummary?) -> WorkModeEngineOptions {
        WorkModeEngineOptions(
            preShiftWarningMinutes: policy?.restrictionConfig.preShiftWarningMinutes ?? RestrictionConfig.defaultPreShiftWarningMinutes
        )
    }
}

/// The on-device Work Mode state machine (§6.2). Callers depend only on this protocol.
public protocol WorkModeEngineProtocol {
    func computeExpectedState(
        now: Date,
        shifts: [Shift],
        breakSessions: [BreakSession],
        overrides: [ActiveOverride],
        permissionState: PermissionState
    ) -> ExpectedState
}

/// Swift port of `packages/shared/src/workMode/computeExpectedState.ts` — field for field, rule for rule. Both
/// implementations run the same fixture file (`docs/fixtures/workmode-cases.json`, see `WorkModeFixtureTests`).
///
/// Precedence, highest first:
///  0. OFF_SHIFT           no working interval in progress and none starting within the pre-shift warning:
///                         nothing else is consulted (overrides and permission problems are moot off shift).
///  1. PERMISSION_ERROR    permission ≠ APPROVED while a shift is active or imminent (the intended restriction
///                         is still reported).
///  2. MANAGER_OVERRIDE    an active EMERGENCY_POLICY_OVERRIDE / END_WORK_MODE_EARLY / EXEMPT_TEMPORARILY
///                         while a shift is active or imminent → restrictions NONE.
///  3. ON_BREAK            a break of a shift in the current interval, startedAt ≤ now < effective end, where the
///                         effective end is min(plannedEndsAt, endedAt, end of the break's own shift) — a
///                         back-to-back shift keeps Work Mode running but ends the relaxation. ENDED rows count
///                         up to their endedAt; an ENDED row without endedAt is ignored.
///  4. TEMPORARY_EXCEPTION during a shift with no active break → state unchanged, restriction relaxed per the
///                         earliest-starting active exception that relaxes something (others are ignored).
///  5. SHIFT_ENDING        now ∈ [intervalEnd − shiftEndingWarningMinutes, intervalEnd).
///  6. WORKING             now ∈ [intervalStart, intervalEnd).
///  7. SHIFT_STARTING_SOON now ∈ [intervalStart − preShiftWarningMinutes, intervalStart).
///  8. OFF_SHIFT           otherwise.
/// Overlapping or back-to-back shifts are merged into one working interval so restrictions never flap.
/// An override is active during [startsAt, min(expiresAt, revokedAt)); with `employeeId` set, overrides scoped
/// to another employee are ignored (org-wide ones always apply). SYNC_ERROR and UNKNOWN are device states and
/// are never produced here. Pure: no clocks, no I/O.
public struct WorkModeEngine: WorkModeEngineProtocol {
    public var options: WorkModeEngineOptions
    /// IANA zone echoed on the output for presentation (the engine never converts).
    public var timezone: String?
    /// When set, overrides scoped to a different employee are ignored (`ComputeExpectedStateInput.employeeId`).
    public var employeeId: String?

    public init(options: WorkModeEngineOptions = WorkModeEngineOptions(), timezone: String? = nil, employeeId: String? = nil) {
        self.options = options
        self.timezone = timezone
        self.employeeId = employeeId
    }

    public func computeExpectedState(
        now: Date,
        shifts: [Shift],
        breakSessions: [BreakSession],
        overrides: [ActiveOverride],
        permissionState: PermissionState
    ) -> ExpectedState {
        let context = Context(
            now: now,
            timezone: timezone,
            permissionState: permissionState,
            options: options,
            intervals: WorkModeEngine.mergeShiftIntervals(shifts),
            breaks: breakSessions.compactMap(NormalisedBreak.init),
            overrides: overrides.compactMap { NormalisedOverride($0, employeeId: employeeId) }
        )
        var snapshot = context.evaluate(at: now)
        snapshot.nextTransitionAt = context.nextTransition(after: snapshot)
        return snapshot
    }

    /// `nextTransitionAt` alone, for callers that only need the wake-up time.
    public func nextTransitionAt(
        now: Date,
        shifts: [Shift],
        breakSessions: [BreakSession],
        overrides: [ActiveOverride],
        permissionState: PermissionState
    ) -> Date? {
        computeExpectedState(now: now, shifts: shifts, breakSessions: breakSessions, overrides: overrides, permissionState: permissionState).nextTransitionAt
    }

    // MARK: Working intervals (`mergeShiftIntervals.ts`)

    /// Effective shifts (SCHEDULED, not deleted, positive length, unique id) ordered by start, then end, then id.
    public static func normaliseShifts(_ shifts: [Shift]) -> [ShiftRef] {
        var seen = Set<String>()
        var refs: [ShiftRef] = []
        for shift in shifts where shift.isEffective && !seen.contains(shift.id) {
            seen.insert(shift.id)
            refs.append(ShiftRef(id: shift.id, startsAt: shift.startsAt, endsAt: shift.endsAt))
        }
        return refs.sorted { a, b in
            if a.startsAt != b.startsAt { return a.startsAt < b.startsAt }
            if a.endsAt != b.endsAt { return a.endsAt < b.endsAt }
            return a.id < b.id
        }
    }

    /// Union of the effective shifts' half-open intervals; overlapping or exactly adjacent shifts merge.
    public static func mergeShiftIntervals(_ shifts: [Shift]) -> [WorkingInterval] {
        var intervals: [WorkingInterval] = []
        for ref in normaliseShifts(shifts) {
            if var last = intervals.last, ref.startsAt <= last.endsAt {
                if ref.endsAt > last.endsAt { last.endsAt = ref.endsAt }
                last.shiftIds.append(ref.id)
                last.shifts.append(ref)
                intervals[intervals.count - 1] = last
            } else {
                intervals.append(WorkingInterval(startsAt: ref.startsAt, endsAt: ref.endsAt, shiftIds: [ref.id], shifts: [ref]))
            }
        }
        return intervals
    }

    /// The interval containing `at` (start inclusive, end exclusive), or nil.
    public static func workingInterval(in intervals: [WorkingInterval], at instant: Date) -> WorkingInterval? {
        intervals.first { $0.startsAt <= instant && instant < $0.endsAt }
    }

    /// The first interval starting strictly after `at`, or nil.
    public static func nextWorkingInterval(in intervals: [WorkingInterval], after instant: Date) -> WorkingInterval? {
        intervals.first { $0.startsAt > instant }
    }

    /// The shift of `interval` that covers `at`: the earliest-starting one when several overlap.
    public static func coveringShift(in interval: WorkingInterval, at instant: Date) -> ShiftRef? {
        interval.shifts.first { $0.startsAt <= instant && instant < $0.endsAt }
    }

    // MARK: Signature

    /// The parts of a state whose change is a transition (`restrictionSignature` in the TS machine): state,
    /// restriction, break, override, relaxation and which interval (imminent vs in progress) the state refers
    /// to. `activeShift` changing inside one merged interval is deliberately not a transition.
    public static func restrictionSignature(_ state: ExpectedState) -> String {
        let relax = state.relaxation.map { r in
            "\(r.source.rawValue):\(r.restrictionBehaviour.rawValue):\(r.liftedCategories.map(\.rawValue).joined(separator: ","))"
        } ?? ""
        let interval = state.workingInterval.map { i in
            "\(state.activeShift != nil ? "in" : "soon")@\(Int64((i.startsAt.timeIntervalSince1970 * 1000).rounded()))"
        } ?? ""
        return [
            state.state.rawValue,
            state.effectiveRestriction.rawValue,
            String(state.restrictionsShouldBeActive),
            state.activeBreak?.id ?? "",
            state.activeOverride?.id ?? "",
            relax,
            interval,
        ].joined(separator: "|")
    }
}

// MARK: - Internals

private struct NormalisedBreak {
    let id: String
    let shiftId: String
    let startedAt: Date
    let plannedEndsAt: Date
    let endedAt: Date?
    let behaviour: BreakRestrictionBehaviour
    let categories: [RestrictionCategory]

    /// Nil when the row has no usable window: an ENDED row without `endedAt` (`hasBreakWindow` in TS).
    init?(_ session: BreakSession) {
        switch session.status {
        case .active:
            break
        case .ended:
            guard session.endedAt != nil else { return nil }
        }
        id = session.id
        shiftId = session.shiftId
        startedAt = session.startedAt
        plannedEndsAt = session.plannedEndsAt
        endedAt = session.endedAt
        behaviour = session.restrictionBehaviour
        categories = RestrictionCategory.canonical(session.relaxedCategories)
    }
}

private struct NormalisedOverride {
    let ref: OverrideRef
    let revokedAt: Date?
    let behaviour: BreakRestrictionBehaviour
    let categories: [RestrictionCategory]

    /// Nil when the override is scoped to another employee.
    init?(_ override: ActiveOverride, employeeId: String?) {
        if let scope = override.employeeId, let employeeId, scope != employeeId { return nil }
        ref = OverrideRef(id: override.id, type: override.type, startsAt: override.startsAt, expiresAt: override.expiresAt, employeeId: override.employeeId)
        revokedAt = override.revokedAt
        // A TEMPORARY_EXCEPTION without a behaviour relaxes everything (same default as the shared machine).
        behaviour = override.breakBehaviour?.restrictionBehaviour ?? .relaxAll
        categories = RestrictionCategory.canonical(override.breakBehaviour?.relaxedCategories ?? [])
    }

    func isActive(at instant: Date) -> Bool {
        guard ref.startsAt <= instant, instant < ref.expiresAt else { return false }
        if let revokedAt { return instant < revokedAt }
        return true
    }

    var rank: Int {
        switch ref.type {
        case .emergencyPolicyOverride: return 0
        case .endWorkModeEarly: return 1
        case .exemptTemporarily: return 2
        case .temporaryException: return 3
        }
    }

    var lifts: Bool {
        switch ref.type {
        case .emergencyPolicyOverride, .endWorkModeEarly, .exemptTemporarily: return true
        case .temporaryException: return false
        }
    }
}

private struct ActiveBreakMatch {
    let ref: BreakRef
    let behaviour: BreakRestrictionBehaviour
    let categories: [RestrictionCategory]
}

private struct RestrictionOutcome {
    let effectiveRestriction: EffectiveRestriction
    let restrictionsShouldBeActive: Bool
    let relaxation: RestrictionRelaxation?

    static let work = RestrictionOutcome(effectiveRestriction: .work, restrictionsShouldBeActive: true, relaxation: nil)

    /// KEEP_RESTRICTIONS → WORK; RELAX_CATEGORIES with an empty list → WORK; RELAX_CATEGORIES ≥ 1 → BREAK_RELAXED
    /// with the listed categories lifted; RELAX_ALL → BREAK_RELAXED with everything lifted (`restrictionFor` in TS).
    static func forBehaviour(_ behaviour: BreakRestrictionBehaviour, categories: [RestrictionCategory], source: RelaxationSource) -> RestrictionOutcome {
        switch behaviour {
        case .keepRestrictions:
            return .work
        case .relaxAll:
            return RestrictionOutcome(
                effectiveRestriction: .breakRelaxed,
                restrictionsShouldBeActive: false,
                relaxation: RestrictionRelaxation(source: source, restrictionBehaviour: behaviour, relaxedCategories: [], liftedCategories: RestrictionCategory.allCases)
            )
        case .relaxCategories:
            if categories.isEmpty { return .work }
            return RestrictionOutcome(
                effectiveRestriction: .breakRelaxed,
                restrictionsShouldBeActive: categories.count < RestrictionCategory.allCases.count,
                relaxation: RestrictionRelaxation(source: source, restrictionBehaviour: behaviour, relaxedCategories: categories, liftedCategories: categories)
            )
        }
    }

    func apply(to state: inout ExpectedState) {
        state.effectiveRestriction = effectiveRestriction
        state.restrictionsShouldBeActive = restrictionsShouldBeActive
        state.relaxation = relaxation
    }
}

private struct Context {
    let now: Date
    let timezone: String?
    let permissionState: PermissionState
    let options: WorkModeEngineOptions
    let intervals: [WorkingInterval]
    let breaks: [NormalisedBreak]
    let overrides: [NormalisedOverride]

    private var preShift: TimeInterval { TimeInterval(options.preShiftWarningMinutes * 60) }
    private var ending: TimeInterval { TimeInterval(options.shiftEndingWarningMinutes * 60) }

    /// Every effective shift by id (each belongs to exactly one interval).
    private func shift(withId id: String) -> ShiftRef? {
        for interval in intervals {
            if let shift = interval.shifts.first(where: { $0.id == id }) { return shift }
        }
        return nil
    }

    func evaluate(at instant: Date) -> ExpectedState {
        let current = WorkModeEngine.workingInterval(in: intervals, at: instant)
        let upcoming = WorkModeEngine.nextWorkingInterval(in: intervals, after: instant)
        var imminent: WorkingInterval?
        if current == nil, let upcoming, upcoming.startsAt.addingTimeInterval(-preShift) <= instant {
            imminent = upcoming
        }

        var snapshot = ExpectedState(
            state: .offShift,
            effectiveRestriction: .none,
            restrictionsShouldBeActive: false,
            computedAt: instant,
            timezone: timezone,
            permissionState: permissionState,
            upcomingShift: upcoming?.shifts.first
        )

        // Off shift and not imminent: nothing else applies (overrides and permission problems are moot).
        if current == nil && imminent == nil { return snapshot }

        // Schedule-derived state.
        var activeBreak: ActiveBreakMatch?
        if let current {
            snapshot.workingInterval = current
            snapshot.activeShift = WorkModeEngine.coveringShift(in: current, at: instant)
            activeBreak = findActiveBreak(in: current, at: instant)
            if let activeBreak {
                snapshot.state = .onBreak
                snapshot.activeBreak = activeBreak.ref
                RestrictionOutcome.forBehaviour(activeBreak.behaviour, categories: activeBreak.categories, source: .breakSession).apply(to: &snapshot)
            } else if instant >= current.endsAt.addingTimeInterval(-ending) {
                snapshot.state = .shiftEnding
                RestrictionOutcome.work.apply(to: &snapshot)
            } else {
                snapshot.state = .working
                RestrictionOutcome.work.apply(to: &snapshot)
            }
        } else if let imminent {
            snapshot.state = .shiftStartingSoon
            snapshot.workingInterval = imminent
        }

        // Manager overrides.
        let active = overrides.filter { $0.isActive(at: instant) }.sorted { a, b in
            if a.rank != b.rank { return a.rank < b.rank }
            if a.ref.startsAt != b.ref.startsAt { return a.ref.startsAt < b.ref.startsAt }
            return a.ref.id < b.ref.id
        }
        if let lifting = active.first(where: { $0.lifts }) {
            // The break session (if any) keeps running underneath: activeBreak stays reported.
            snapshot.state = .managerOverride
            snapshot.effectiveRestriction = .none
            snapshot.restrictionsShouldBeActive = false
            snapshot.relaxation = nil
            snapshot.activeOverride = lifting.ref
        } else if current != nil && activeBreak == nil {
            // TEMPORARY_EXCEPTION: an exception that relaxes nothing is not reported and does not mask another
            // that does; among relaxing ones the earliest-starting applies (then id), per the sort above.
            for exception in active where exception.ref.type == .temporaryException {
                let outcome = RestrictionOutcome.forBehaviour(exception.behaviour, categories: exception.categories, source: .override)
                guard outcome.relaxation != nil else { continue }
                outcome.apply(to: &snapshot)
                snapshot.activeOverride = exception.ref
                break
            }
        }

        // Permission dominates while a shift is active or imminent; the intended restriction is kept.
        if !permissionState.isApproved { snapshot.state = .permissionError }
        return snapshot
    }

    /// Effective end of a break: min(plannedEndsAt, endedAt, end of its own shift).
    private func effectiveEnd(of session: NormalisedBreak, ownShift: ShiftRef) -> Date {
        var endsAt = min(session.plannedEndsAt, ownShift.endsAt)
        if let endedAt = session.endedAt { endsAt = min(endsAt, endedAt) }
        return endsAt
    }

    private func findActiveBreak(in interval: WorkingInterval, at instant: Date) -> ActiveBreakMatch? {
        var best: ActiveBreakMatch?
        for session in breaks where interval.shiftIds.contains(session.shiftId) {
            // Only breaks of a shift in this interval count; the break's own shift end always terminates it,
            // even when a back-to-back shift keeps Work Mode itself running.
            guard let ownShift = shift(withId: session.shiftId) else { continue }
            guard session.startedAt <= instant else { continue }
            let endsAt = effectiveEnd(of: session, ownShift: ownShift)
            if endsAt <= instant { continue }
            let candidate = ActiveBreakMatch(
                ref: BreakRef(id: session.id, shiftId: session.shiftId, startedAt: session.startedAt, plannedEndsAt: session.plannedEndsAt, endsAt: endsAt),
                behaviour: session.behaviour,
                categories: session.categories
            )
            // Two open sessions at once is an upstream integrity bug; prefer the most recently started one.
            if let current = best {
                if candidate.ref.startedAt > current.ref.startedAt
                    || (candidate.ref.startedAt == current.ref.startedAt && candidate.ref.id < current.ref.id) {
                    best = candidate
                }
            } else {
                best = candidate
            }
        }
        return best
    }

    /// Earliest future instant at which the output changes: every boundary of every input is a candidate,
    /// and the first candidate whose evaluation differs is the answer (`findNextTransition` in TS).
    func nextTransition(after snapshot: ExpectedState) -> Date? {
        var candidates: [Date] = []
        for interval in intervals {
            candidates.append(interval.startsAt.addingTimeInterval(-preShift))
            candidates.append(interval.startsAt)
            candidates.append(interval.endsAt.addingTimeInterval(-ending))
            candidates.append(interval.endsAt)
        }
        for session in breaks {
            candidates.append(session.startedAt)
            candidates.append(session.plannedEndsAt)
            if let endedAt = session.endedAt { candidates.append(endedAt) }
            // A break also ends at its own shift's end, which inside a merged interval is not an interval boundary.
            if let ownShift = shift(withId: session.shiftId) { candidates.append(ownShift.endsAt) }
        }
        for override in overrides {
            candidates.append(override.ref.startsAt)
            candidates.append(override.ref.expiresAt)
            if let revokedAt = override.revokedAt { candidates.append(revokedAt) }
        }
        let base = WorkModeEngine.restrictionSignature(snapshot)
        for instant in Set(candidates.filter { $0 > now }).sorted() {
            if WorkModeEngine.restrictionSignature(evaluate(at: instant)) != base { return instant }
        }
        return nil
    }
}
