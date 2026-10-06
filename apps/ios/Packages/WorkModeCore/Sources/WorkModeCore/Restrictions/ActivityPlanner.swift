import Foundation

/// Turns the cached schedule into DeviceActivity schedules (and the matching plans.json entries).
///
/// - Works on merged working intervals, not raw shifts, so back-to-back shifts are one activity and
///   shields never flap between them.
/// - Respects Apple's limits: at most 20 monitored activities and a 15-minute minimum interval. A shorter
///   interval (a 10-minute break) is stretched to 15 minutes; `ActivityPlan.plannedEnd` keeps the true end so
///   the monitor extension / app can lift the relaxation on time.
/// - Plans only the next `horizon` (7 days by default); every sync re-plans.
public struct ActivityPlanner {
    public static let maxActivities = 20
    public static let minimumIntervalMinutes = 15
    public static let shiftActivityPrefix = "wm.shift."
    public static let breakActivityPrefix = "wm.break."

    public var horizon: TimeInterval

    public init(horizon: TimeInterval = 7 * 24 * 60 * 60) {
        self.horizon = horizon
    }

    /// Plan entries ordered by start (an active break first). Empty when no policy resolves: without a
    /// Work Policy there is nothing to enforce.
    public func plan(
        now: Date,
        shifts: [Shift],
        activeBreak: BreakSession?,
        policy: PolicySummary?,
        breakPolicy: BreakPolicy?,
        timeZone: TimeZone,
        options: WorkModeEngineOptions
    ) -> [PlanEntry] {
        guard let policy else { return [] }
        let minimum = TimeInterval(ActivityPlanner.minimumIntervalMinutes * 60)
        var entries: [PlanEntry] = []

        if let session = activeBreak, case .active = session.status, session.plannedEndsAt > now {
            let plan = RestrictionPlan.make(shiftId: session.shiftId, policy: policy, breakPolicy: breakPolicy)
            let behaviour = BreakBehaviour.from(
                restrictionBehaviour: session.restrictionBehaviour,
                relaxedCategories: session.relaxedCategories,
                planCategories: plan.categories
            )
            let end = max(session.plannedEndsAt, session.startedAt.addingTimeInterval(minimum))
            let activity = ActivityPlan(
                name: ActivityPlanner.breakActivityPrefix + session.id,
                shiftId: session.shiftId,
                startComponents: deviceComponents(for: session.startedAt, in: timeZone),
                endComponents: deviceComponents(for: end, in: timeZone),
                warningMinutes: 0,
                kind: .break,
                plannedEnd: session.plannedEndsAt
            )
            entries.append(PlanEntry(shiftId: session.shiftId, plan: plan, activity: activity, breakBehaviour: behaviour))
        }

        let windowEnd = now.addingTimeInterval(horizon)
        let intervals = WorkModeEngine.mergeShiftIntervals(shifts).filter { $0.endsAt > now && $0.startsAt < windowEnd }
        for interval in intervals {
            guard entries.count < ActivityPlanner.maxActivities, let shiftId = interval.shiftIds.first else { break }
            let plan = RestrictionPlan.make(shiftId: shiftId, policy: policy, breakPolicy: breakPolicy)
            let end = max(interval.endsAt, interval.startsAt.addingTimeInterval(minimum))
            let activity = ActivityPlan(
                name: ActivityPlanner.shiftActivityPrefix + shiftId,
                shiftId: shiftId,
                startComponents: deviceComponents(for: interval.startsAt, in: timeZone),
                endComponents: deviceComponents(for: end, in: timeZone),
                warningMinutes: options.preShiftWarningMinutes,
                kind: .shift,
                plannedEnd: interval.endsAt
            )
            entries.append(PlanEntry(shiftId: shiftId, plan: plan, activity: activity))
        }
        return entries
    }
}

/// What the app should do to the shields for an expected state.
public enum RestrictionAction: Equatable, Sendable {
    case applyWork(RestrictionPlan)
    case applyBreak(RestrictionPlan, BreakBehaviour)
    case clear
    /// Nothing can or should change (permission missing, state unknown).
    case leaveUnchanged
}

/// Maps the engine's expected state onto the `RestrictionProvider`. Used by the app on every sync and
/// foreground; the DeviceActivityMonitor extension applies the same mapping at interval boundaries.
public enum RestrictionReconciler {
    public static func action(for expected: ExpectedState, policy: PolicySummary?, breakPolicy: BreakPolicy?) -> RestrictionAction {
        switch expected.state {
        case .working, .shiftEnding, .onBreak:
            // No published Work Policy resolves for this employee: there is nothing to enforce, so any shields
            // left from an earlier policy are lifted rather than kept up indefinitely.
            guard let policy else { return .clear }
            guard let shiftId = expected.activeShift?.id ?? expected.workingInterval?.shiftIds.first else {
                return .leaveUnchanged
            }
            let plan = RestrictionPlan.make(shiftId: shiftId, policy: policy, breakPolicy: breakPolicy)
            if case .breakRelaxed = expected.effectiveRestriction, let relaxation = expected.relaxation {
                let behaviour = BreakBehaviour.from(
                    restrictionBehaviour: relaxation.restrictionBehaviour,
                    relaxedCategories: relaxation.liftedCategories,
                    planCategories: plan.categories
                )
                return .applyBreak(plan, behaviour)
            }
            if case .onBreak = expected.state {
                return .applyBreak(plan, .keepRestrictions)
            }
            return .applyWork(plan)
        case .offShift, .shiftStartingSoon, .managerOverride:
            return .clear
        case .permissionError, .syncError, .unknown:
            return .leaveUnchanged
        }
    }

    /// Applies `action(for:...)` through `provider` and returns it.
    @discardableResult
    public static func reconcile(_ expected: ExpectedState, policy: PolicySummary?, breakPolicy: BreakPolicy?, provider: RestrictionProvider) throws -> RestrictionAction {
        let action = action(for: expected, policy: policy, breakPolicy: breakPolicy)
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
        return action
    }
}
