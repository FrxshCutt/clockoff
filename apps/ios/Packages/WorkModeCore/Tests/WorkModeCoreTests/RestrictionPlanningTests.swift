import XCTest
@testable import WorkModeCore

/// Records every call so the reconciler can be verified without Screen Time.
private final class RecordingRestrictionProvider: RestrictionProvider {
    var authorizationStatus: RestrictionAuthorizationStatus = .approved
    var calls: [String] = []

    func requestAuthorization() async throws { calls.append("authorize") }
    func hasSelection() -> Bool { true }
    func applyWorkRestrictions(plan: RestrictionPlan) throws { calls.append("work:\(plan.shiftId)") }
    func applyBreakRestrictions(plan: RestrictionPlan, behaviour: BreakBehaviour) throws { calls.append("break:\(plan.shiftId):\(behaviour)") }
    func clearRestrictions() throws { calls.append("clear") }
    func scheduleActivities(_ plans: [ActivityPlan]) throws { calls.append("schedule:\(plans.count)") }
    func cancelAllActivities() { calls.append("cancel") }
    func currentEngineState() -> RestrictionEngineState { .unknown }
}

final class RestrictionPlanningTests: XCTestCase {
    private let london = TimeZone(identifier: "Europe/London")!

    func testRestrictionPlanFromPolicies() throws {
        let plan = RestrictionPlan.make(shiftId: "s1", policy: try Fixture.policy(), breakPolicy: try Fixture.breakPolicy())
        XCTAssertEqual(plan.categories, [.socialMedia, .games, .streaming])
        XCTAssertEqual(plan.policyVersion, "22222222-2222-4222-8222-222222222222")
        XCTAssertEqual(plan.shieldMessage, "You're on shift — this app is paused.")
        XCTAssertTrue(plan.requiresBreakSubsetSelection, "RELAX_CATEGORIES break policy needs a subset selection")
        XCTAssertFalse(RestrictionPlan.make(shiftId: "s1", policy: try Fixture.policy(), breakPolicy: nil).requiresBreakSubsetSelection)
    }

    func testBreakBehaviourMapping() {
        let plan: [RestrictionCategory] = [.socialMedia, .games, .streaming]
        XCTAssertEqual(BreakBehaviour.from(restrictionBehaviour: .relaxAll, relaxedCategories: [], planCategories: plan), .relaxAll)
        XCTAssertEqual(BreakBehaviour.from(restrictionBehaviour: .keepRestrictions, relaxedCategories: [.games], planCategories: plan), .keepRestrictions)
        XCTAssertEqual(BreakBehaviour.from(restrictionBehaviour: .relaxCategories, relaxedCategories: [.socialMedia], planCategories: plan), .relaxCategories(kept: [.games, .streaming]))
        XCTAssertEqual(BreakBehaviour.from(restrictionBehaviour: .relaxCategories, relaxedCategories: [], planCategories: plan), .keepRestrictions)
        XCTAssertEqual(BreakBehaviour.from(restrictionBehaviour: .relaxCategories, relaxedCategories: RestrictionCategory.allCases, planCategories: plan), .relaxAll)
    }

    func testAuthorizationStatusToPermissionState() {
        XCTAssertEqual(RestrictionAuthorizationStatus.approved.permissionState(previous: nil), .approved)
        XCTAssertEqual(RestrictionAuthorizationStatus.notDetermined.permissionState(previous: .approved), .notDetermined)
        XCTAssertEqual(RestrictionAuthorizationStatus.denied.permissionState(previous: nil), .denied)
        XCTAssertEqual(RestrictionAuthorizationStatus.denied.permissionState(previous: .approved), .revoked)
        XCTAssertEqual(RestrictionAuthorizationStatus.denied.permissionState(previous: .revoked), .revoked)
    }

    func testPlannerBuildsMergedShiftActivitiesWithinHorizon() throws {
        let shifts = [
            Fixture.shift("a", "2026-10-06T08:00:00Z", "2026-10-06T12:00:00Z"),
            Fixture.shift("b", "2026-10-06T12:00:00Z", "2026-10-06T16:00:00Z"),
            Fixture.shift("past", "2026-10-05T08:00:00Z", "2026-10-05T16:00:00Z"),
            Fixture.shift("night", "2026-10-07T21:00:00Z", "2026-10-08T05:00:00Z"),
            Fixture.shift("far", "2026-10-20T08:00:00Z", "2026-10-20T16:00:00Z"),
            Fixture.shift("gone", "2026-10-09T08:00:00Z", "2026-10-09T16:00:00Z", status: .cancelled),
        ]
        let entries = ActivityPlanner().plan(now: iso("2026-10-06T09:00:00Z"), shifts: shifts, activeBreak: nil,
                                             policy: try Fixture.policy(), breakPolicy: nil, timeZone: london,
                                             options: WorkModeEngineOptions(preShiftWarningMinutes: 10))
        XCTAssertEqual(entries.map(\.activity.name), ["wm.shift.a", "wm.shift.night"])
        let first = try XCTUnwrap(entries.first)
        XCTAssertEqual(first.activity.kind, .shift)
        XCTAssertEqual(first.activity.warningMinutes, 10)
        XCTAssertEqual(first.activity.startComponents.hour, 9, "09:00 BST")
        XCTAssertEqual(first.activity.endComponents.hour, 17, "merged interval ends 16:00Z = 17:00 BST")
        XCTAssertEqual(first.activity.plannedEnd, iso("2026-10-06T16:00:00Z"))
        XCTAssertEqual(first.plan.categories, [.socialMedia, .games, .streaming])
        XCTAssertEqual(entries[1].activity.endComponents.day, 8, "overnight end on the next day")
    }

    func testPlannerStretchesShortBreaksAndPutsThemFirst() throws {
        let session = BreakSession(id: "b1", clientBreakId: "c", shiftId: "a", startedAt: iso("2026-10-06T11:00:00Z"),
                                   plannedEndsAt: iso("2026-10-06T11:10:00Z"), restrictionBehaviour: .relaxCategories, relaxedCategories: [.games])
        let entries = ActivityPlanner().plan(now: iso("2026-10-06T11:02:00Z"),
                                             shifts: [Fixture.shift("a", "2026-10-06T08:00:00Z", "2026-10-06T16:00:00Z")],
                                             activeBreak: session, policy: try Fixture.policy(), breakPolicy: nil,
                                             timeZone: london, options: WorkModeEngineOptions())
        XCTAssertEqual(entries.map(\.activity.name), ["wm.break.b1", "wm.shift.a"])
        let breakEntry = entries[0]
        XCTAssertEqual(breakEntry.activity.kind, .break)
        XCTAssertEqual(breakEntry.activity.plannedEnd, iso("2026-10-06T11:10:00Z"))
        XCTAssertEqual(breakEntry.activity.endComponents.resolvedDate(), iso("2026-10-06T11:15:00Z"), "stretched to the 15-minute minimum")
        XCTAssertEqual(breakEntry.breakBehaviour, .relaxCategories(kept: [.socialMedia, .streaming]))
    }

    func testPlannerCapsAtTwentyActivitiesAndNeedsAPolicy() throws {
        let start = iso("2026-10-06T08:00:00Z")
        let shifts = (0..<30).map { i -> Shift in
            let s = start.addingTimeInterval(TimeInterval(i) * 4 * 3600)
            return Shift(id: "s\(i)", startsAt: s, endsAt: s.addingTimeInterval(3600), timezone: "Europe/London")
        }
        let planner = ActivityPlanner()
        let entries = planner.plan(now: start, shifts: shifts, activeBreak: nil, policy: try Fixture.policy(), breakPolicy: nil, timeZone: london, options: WorkModeEngineOptions())
        XCTAssertEqual(entries.count, ActivityPlanner.maxActivities)
        XCTAssertTrue(planner.plan(now: start, shifts: shifts, activeBreak: nil, policy: nil, breakPolicy: nil, timeZone: london, options: WorkModeEngineOptions()).isEmpty)
    }

    func testReconcilerActions() throws {
        let policy = try Fixture.policy()
        let engine = WorkModeEngine()
        let shift = Fixture.shift("s1", "2026-10-06T08:00:00Z", "2026-10-06T16:00:00Z")
        func expected(_ now: String, breaks: [BreakSession] = [], permission: PermissionState = .approved) -> ExpectedState {
            engine.computeExpectedState(now: iso(now), shifts: [shift], breakSessions: breaks, overrides: [], permissionState: permission)
        }

        let provider = RecordingRestrictionProvider()
        XCTAssertEqual(try RestrictionReconciler.reconcile(expected("2026-10-06T09:00:00Z"), policy: policy, breakPolicy: nil, provider: provider),
                       .applyWork(RestrictionPlan.make(shiftId: "s1", policy: policy, breakPolicy: nil)))
        let relaxed = BreakSession(id: "b", clientBreakId: "c", shiftId: "s1", startedAt: iso("2026-10-06T11:00:00Z"),
                                   plannedEndsAt: iso("2026-10-06T11:15:00Z"), restrictionBehaviour: .relaxCategories, relaxedCategories: [.games])
        try RestrictionReconciler.reconcile(expected("2026-10-06T11:05:00Z", breaks: [relaxed]), policy: policy, breakPolicy: nil, provider: provider)
        var keep = relaxed
        keep.restrictionBehaviour = .keepRestrictions
        try RestrictionReconciler.reconcile(expected("2026-10-06T11:05:00Z", breaks: [keep]), policy: policy, breakPolicy: nil, provider: provider)
        try RestrictionReconciler.reconcile(expected("2026-10-06T20:00:00Z"), policy: policy, breakPolicy: nil, provider: provider)
        XCTAssertEqual(try RestrictionReconciler.reconcile(expected("2026-10-06T09:00:00Z", permission: .denied), policy: policy, breakPolicy: nil, provider: provider), .leaveUnchanged)
        XCTAssertEqual(RestrictionReconciler.action(for: expected("2026-10-06T09:00:00Z"), policy: nil, breakPolicy: nil), .clear,
                       "no Work Policy resolves: nothing to enforce, stale shields are lifted")
        XCTAssertEqual(RestrictionReconciler.action(for: expected("2026-10-06T07:50:00Z"), policy: policy, breakPolicy: nil), .clear, "starting soon enforces nothing")
        XCTAssertEqual(provider.calls, [
            "work:s1",
            "break:s1:relaxCategories(kept: [WorkModeCore.RestrictionCategory.socialMedia, WorkModeCore.RestrictionCategory.streaming])",
            "break:s1:keepRestrictions",
            "clear",
        ])
    }
}

final class WorkModeEventsTests: XCTestCase {
    private func expected(_ state: WorkModeState, shiftId: String? = "s1") -> ExpectedState {
        ExpectedState(state: state, effectiveRestriction: .none, restrictionsShouldBeActive: false, computedAt: Date(), permissionState: .approved,
                      activeShift: shiftId.map { ShiftRef(id: $0, startsAt: Date(), endsAt: Date()) })
    }

    func testStartAndEndTransitions() {
        let at = iso("2026-10-06T08:00:00Z")
        let started = WorkModeEvents.transitionEvents(from: .shiftStartingSoon, to: expected(.working), at: at)
        XCTAssertEqual(started.map(\.type), [.workModeStarted])
        XCTAssertEqual(started.first?.metadata?.shiftId, "s1")
        XCTAssertEqual(started.first?.occurredAt, at)
        XCTAssertEqual(WorkModeEvents.transitionEvents(from: nil, to: expected(.onBreak), at: at).map(\.type), [.workModeStarted])
        XCTAssertEqual(WorkModeEvents.transitionEvents(from: .shiftEnding, to: expected(.offShift, shiftId: nil), at: at).map(\.type), [.workModeEnded])
        XCTAssertEqual(WorkModeEvents.transitionEvents(from: .working, to: expected(.managerOverride), at: at).map(\.type), [.workModeEnded])
    }

    func testNoEventsWithinOrOutsideActivePeriodsOrForIndeterminateStates() {
        let at = Date()
        XCTAssertTrue(WorkModeEvents.transitionEvents(from: .working, to: expected(.onBreak), at: at).isEmpty)
        XCTAssertTrue(WorkModeEvents.transitionEvents(from: .offShift, to: expected(.shiftStartingSoon), at: at).isEmpty)
        XCTAssertTrue(WorkModeEvents.transitionEvents(from: .working, to: expected(.permissionError), at: at).isEmpty)
        XCTAssertTrue(WorkModeEvents.transitionEvents(from: .working, to: expected(.unknown), at: at).isEmpty)
    }
}
