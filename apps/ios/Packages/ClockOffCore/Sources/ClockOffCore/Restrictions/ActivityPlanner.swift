import Foundation

/// DeviceActivity names. Shift activities are versioned so a callback for a stale schedule (one re-planned
/// moments earlier) finds no plans.json entry and is ignored; break activities are keyed on the client break id.
public enum ActivityNaming {
    public static let shiftPrefix = "shift-"
    public static let breakPrefix = "break-"
    private static let versionSeparator = "-v"

    public enum Kind: Equatable, Sendable {
        case shift(shiftId: String, version: Int)
        case `break`(clientBreakId: String)
    }

    /// `shift-<shiftId>-v<version>`.
    public static func shift(shiftId: String, version: Int) -> String {
        "\(shiftPrefix)\(shiftId)\(versionSeparator)\(version)"
    }

    /// `break-<clientBreakId>`.
    public static func breakActivity(clientBreakId: String) -> String {
        "\(breakPrefix)\(clientBreakId)"
    }

    /// Nil for a name ClockOff did not register.
    public static func parse(_ name: String) -> Kind? {
        if name.hasPrefix(shiftPrefix) {
            let rest = name.dropFirst(shiftPrefix.count)
            guard let range = rest.range(of: versionSeparator, options: .backwards),
                  let version = Int(rest[range.upperBound...]) else { return nil }
            let shiftId = String(rest[..<range.lowerBound])
            guard !shiftId.isEmpty else { return nil }
            return .shift(shiftId: shiftId, version: version)
        }
        if name.hasPrefix(breakPrefix) {
            let id = String(name.dropFirst(breakPrefix.count))
            return id.isEmpty ? nil : .break(clientBreakId: id)
        }
        return nil
    }

    public static func isOurs(_ name: String) -> Bool {
        parse(name) != nil
    }
}

/// Turns the cached schedule into DeviceActivity schedules (and the matching plans.json entries).
///
/// - Works on merged working intervals, not raw shifts, so back-to-back shifts are one activity and
///   shields never flap between them.
/// - Respects Apple's limits: at most 20 monitored activities (18 shift intervals + 2 spare for breaks) and a
///   15-minute minimum interval. Intervals shorter than that are skipped (the server refuses such shifts);
///   a running break is stretched to 15 minutes with `ActivityPlan.plannedEnd` keeping the true end.
/// - Plans only the next `horizon` (7 days by default); every sync re-plans.
public struct ActivityPlanner {
    public static let maxActivities = 20
    /// Compatibility with the scaffold's naming (`clockoff.shift.<id>` style callers). Activities are now named by
    /// `ActivityNaming.shift(shiftId:version:)` — `shift-<shiftId>-v<version>` — so a stale callback is ignored.
    @available(*, deprecated, message: "Use ActivityNaming.shift(shiftId:version:); names carry a version suffix.")
    public static let shiftActivityPrefix = ActivityNaming.shiftPrefix
    /// Shift activities registered at most; the remaining slots are kept for break activities.
    public static let maxShiftActivities = 18
    public static let minimumIntervalMinutes = 15

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

        if let session = activeBreak, case .active = session.status, session.endedAt == nil, session.plannedEndsAt > now {
            let plan = RestrictionPlan.make(shiftId: session.shiftId, policy: policy, breakPolicy: breakPolicy)
            let behaviour = BreakBehaviour.from(
                restrictionBehaviour: session.restrictionBehaviour,
                relaxedCategories: session.relaxedCategories,
                planCategories: plan.categories
            )
            let clientBreakId = session.clientBreakId.isEmpty ? session.id : session.clientBreakId
            let activity = BreakActivitySchedule.make(
                clientBreakId: clientBreakId,
                shiftId: session.shiftId,
                startedAt: session.startedAt,
                plannedEndsAt: session.plannedEndsAt,
                timeZone: timeZone
            )
            entries.append(PlanEntry(shiftId: session.shiftId, plan: plan, activity: activity, breakBehaviour: behaviour, clientBreakId: clientBreakId))
        }

        let versions = Dictionary(shifts.map { ($0.id, $0.version) }, uniquingKeysWith: { first, _ in first })
        let windowEnd = now.addingTimeInterval(horizon)
        let intervals = WorkModeEngine.mergeShiftIntervals(shifts).filter { $0.endsAt > now && $0.startsAt < windowEnd }
        var shiftActivities = 0
        for interval in intervals {
            guard shiftActivities < ActivityPlanner.maxShiftActivities, let shiftId = interval.shiftIds.first else { break }
            // Shorter than DeviceActivity's minimum: nothing to register (the API rejects such shifts anyway).
            guard interval.endsAt.timeIntervalSince(interval.startsAt) >= minimum else { continue }
            let plan = RestrictionPlan.make(shiftId: shiftId, policy: policy, breakPolicy: breakPolicy)
            // The sum of the merged shifts' versions changes whenever any of them is edited.
            let version = interval.shiftIds.reduce(0) { $0 + (versions[$1] ?? 1) }
            let activity = ActivityPlan(
                name: ActivityNaming.shift(shiftId: shiftId, version: version),
                shiftId: shiftId,
                startComponents: deviceComponents(for: interval.startsAt, in: timeZone),
                endComponents: deviceComponents(for: interval.endsAt, in: timeZone),
                warningMinutes: options.preShiftWarningMinutes,
                kind: .shift,
                plannedEnd: interval.endsAt
            )
            entries.append(PlanEntry(shiftId: shiftId, plan: plan, activity: activity, version: version, shiftIds: interval.shiftIds))
            shiftActivities += 1
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

/// `WorkModeController.reconcile(now:)`'s decision: compares what the engine expects with what the provider
/// reports is actually applied and says whether (and how) to touch the stores. Pure, so it is unit-tested with
/// the mock provider's states.
///
///  (a) expected WORK and the stores are empty            → apply work ("UNKNOWN_CORRECTED" when the provider
///                                                           reports UNKNOWN, else "RECONCILE")
///  (b) expected NONE and the stores are not empty         → clear
///  (c) expected BREAK_RELAXED and not already on a break → apply the break behaviour
///  (d) PERMISSION_ERROR with shields still up            → clear (shields are moot and must not linger)
///  otherwise                                              → nothing to do
public struct ReconcileDecision: Equatable, Sendable {
    public static let reasonReconcile = "RECONCILE"
    public static let reasonUnknownCorrected = "UNKNOWN_CORRECTED"
    public static let reasonSelectionMissing = "SELECTION_MISSING"

    public var action: RestrictionAction
    /// The engine state to record once `action` has been performed (or that already holds).
    public var appliedState: WorkModeState
    /// True when the provider must be touched (and events/engine state recorded).
    public var isChange: Bool
    /// `reason` metadata for the events this decision queues.
    public var reason: String

    public init(action: RestrictionAction, appliedState: WorkModeState, isChange: Bool, reason: String) {
        self.action = action
        self.appliedState = appliedState
        self.isChange = isChange
        self.reason = reason
    }

    public static func decide(
        expected: ExpectedState,
        providerState: RestrictionEngineState,
        policy: PolicySummary?,
        breakPolicy: BreakPolicy?,
        hasSelection: Bool
    ) -> ReconcileDecision {
        let base = RestrictionReconciler.action(for: expected, policy: policy, breakPolicy: breakPolicy)
        let provider = providerState.state
        let providerActive = WorkModeEngine.isActiveState(provider)
        let reason = provider == .unknown ? reasonUnknownCorrected : reasonReconcile

        switch base {
        case .applyWork(let plan):
            guard hasSelection else {
                return ReconcileDecision(action: .leaveUnchanged, appliedState: .permissionError, isChange: false, reason: reasonSelectionMissing)
            }
            if provider == .working || provider == .shiftEnding {
                return ReconcileDecision(action: .leaveUnchanged, appliedState: expected.state, isChange: false, reason: reasonReconcile)
            }
            return ReconcileDecision(action: .applyWork(plan), appliedState: expected.state, isChange: true, reason: reason)

        case .applyBreak(let plan, let behaviour):
            if case .relaxAll = behaviour {
                // Nothing to shield with is fine for a RELAX_ALL break: everything is lifted anyway.
            } else if !hasSelection {
                return ReconcileDecision(action: .leaveUnchanged, appliedState: .permissionError, isChange: false, reason: reasonSelectionMissing)
            }
            if provider == .onBreak {
                return ReconcileDecision(action: .leaveUnchanged, appliedState: expected.state, isChange: false, reason: reasonReconcile)
            }
            return ReconcileDecision(action: .applyBreak(plan, behaviour), appliedState: expected.state, isChange: true, reason: reason)

        case .clear:
            if providerActive || provider == .unknown {
                return ReconcileDecision(action: .clear, appliedState: expected.state, isChange: true, reason: reason)
            }
            return ReconcileDecision(action: .leaveUnchanged, appliedState: expected.state, isChange: false, reason: reasonReconcile)

        case .leaveUnchanged:
            if expected.state == .permissionError, providerActive {
                return ReconcileDecision(action: .clear, appliedState: .permissionError, isChange: true, reason: reasonReconcile)
            }
            return ReconcileDecision(action: .leaveUnchanged, appliedState: expected.state, isChange: false, reason: reasonReconcile)
        }
    }
}
