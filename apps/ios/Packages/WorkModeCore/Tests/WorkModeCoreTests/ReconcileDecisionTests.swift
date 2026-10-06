import XCTest
@testable import WorkModeCore

/// `WorkModeController.reconcile`'s pure decision: what the engine expects vs. what the provider reports.
final class ReconcileDecisionTests: XCTestCase {
    private let engine = WorkModeEngine()
    private let shift = Fixture.shift("s1", "2026-10-06T08:00:00Z", "2026-10-06T16:00:00Z")

    private func expected(_ now: String, breaks: [BreakSession] = [], permission: PermissionState = .approved) -> ExpectedState {
        engine.computeExpectedState(now: iso(now), shifts: [shift], breakSessions: breaks, overrides: [], permissionState: permission)
    }

    private func provider(_ state: WorkModeState, source: RestrictionEngineStateSource = .provider) -> RestrictionEngineState {
        RestrictionEngineState(state: state, source: source, updatedAt: nil)
    }

    private func decide(_ expected: ExpectedState, _ providerState: WorkModeState, hasSelection: Bool = true, breakPolicy: BreakPolicy? = nil) throws -> ReconcileDecision {
        ReconcileDecision.decide(expected: expected, providerState: provider(providerState), policy: try Fixture.policy(), breakPolicy: breakPolicy, hasSelection: hasSelection)
    }

    func testExpectedWorkWithEmptyStoresApplies() throws {
        let plan = RestrictionPlan.make(shiftId: "s1", policy: try Fixture.policy(), breakPolicy: nil)
        let unknown = try decide(expected("2026-10-06T09:00:00Z"), .unknown)
        XCTAssertEqual(unknown, ReconcileDecision(action: .applyWork(plan), appliedState: .working, isChange: true, reason: ReconcileDecision.reasonUnknownCorrected))
        let offShift = try decide(expected("2026-10-06T09:00:00Z"), .offShift)
        XCTAssertEqual(offShift.action, .applyWork(plan))
        XCTAssertEqual(offShift.reason, ReconcileDecision.reasonReconcile)
        // Already enforced: nothing to do (SHIFT_ENDING is the same shield set).
        XCTAssertFalse(try decide(expected("2026-10-06T09:00:00Z"), .working).isChange)
        XCTAssertFalse(try decide(expected("2026-10-06T15:57:00Z"), .working).isChange)
        XCTAssertEqual(try decide(expected("2026-10-06T15:57:00Z"), .working).appliedState, .shiftEnding)
        // A break ended but the provider still relaxes: back to work.
        XCTAssertTrue(try decide(expected("2026-10-06T09:00:00Z"), .onBreak).isChange)
    }

    func testExpectedNoneWithShieldsUpClears() throws {
        for state in [WorkModeState.working, .onBreak, .shiftEnding, .unknown] {
            let decision = try decide(expected("2026-10-06T17:00:00Z"), state)
            XCTAssertEqual(decision.action, .clear, state.rawValue)
            XCTAssertTrue(decision.isChange, state.rawValue)
            XCTAssertEqual(decision.appliedState, .offShift)
        }
        XCTAssertFalse(try decide(expected("2026-10-06T17:00:00Z"), .offShift).isChange)
        XCTAssertFalse(try decide(expected("2026-10-06T07:50:00Z"), .shiftStartingSoon).isChange, "starting soon enforces nothing")
        XCTAssertEqual(try decide(expected("2026-10-06T07:50:00Z"), .working).action, .clear)
    }

    func testExpectedBreakRelaxedAppliesTheBreakBehaviour() throws {
        let relaxAll = BreakSession(id: "b", clientBreakId: "c", shiftId: "s1", startedAt: iso("2026-10-06T11:00:00Z"), plannedEndsAt: iso("2026-10-06T11:15:00Z"))
        let plan = RestrictionPlan.make(shiftId: "s1", policy: try Fixture.policy(), breakPolicy: nil)
        let decision = try decide(expected("2026-10-06T11:05:00Z", breaks: [relaxAll]), .working)
        XCTAssertEqual(decision, ReconcileDecision(action: .applyBreak(plan, .relaxAll), appliedState: .onBreak, isChange: true, reason: ReconcileDecision.reasonReconcile))
        XCTAssertFalse(try decide(expected("2026-10-06T11:05:00Z", breaks: [relaxAll]), .onBreak).isChange)
        // RELAX_ALL needs no selection; RELAX_CATEGORIES / KEEP_RESTRICTIONS do.
        XCTAssertTrue(try decide(expected("2026-10-06T11:05:00Z", breaks: [relaxAll]), .working, hasSelection: false).isChange)
        var categories = relaxAll
        categories.restrictionBehaviour = .relaxCategories
        categories.relaxedCategories = [.games]
        let missing = try decide(expected("2026-10-06T11:05:00Z", breaks: [categories]), .working, hasSelection: false)
        XCTAssertEqual(missing.action, .leaveUnchanged)
        XCTAssertEqual(missing.appliedState, .permissionError)
        XCTAssertEqual(missing.reason, ReconcileDecision.reasonSelectionMissing)
        let kept = try decide(expected("2026-10-06T11:05:00Z", breaks: [categories]), .working)
        XCTAssertEqual(kept.action, .applyBreak(plan, .relaxCategories(kept: [.socialMedia, .streaming])))
    }

    func testMissingSelectionNeverAppliesWork() throws {
        let decision = try decide(expected("2026-10-06T09:00:00Z"), .unknown, hasSelection: false)
        XCTAssertEqual(decision.action, .leaveUnchanged)
        XCTAssertEqual(decision.appliedState, .permissionError)
        XCTAssertFalse(decision.isChange)
        XCTAssertEqual(decision.reason, ReconcileDecision.reasonSelectionMissing)
    }

    func testPermissionErrorClearsLingeringShieldsOnly() throws {
        let denied = expected("2026-10-06T09:00:00Z", permission: .denied)
        let lingering = try decide(denied, .working)
        XCTAssertEqual(lingering.action, .clear)
        XCTAssertEqual(lingering.appliedState, .permissionError)
        XCTAssertTrue(lingering.isChange)
        let clean = try decide(denied, .permissionError)
        XCTAssertEqual(clean.action, .leaveUnchanged)
        XCTAssertFalse(clean.isChange)
    }

    func testNoPolicyClearsStaleShields() throws {
        let decision = ReconcileDecision.decide(expected: expected("2026-10-06T09:00:00Z"), providerState: provider(.working), policy: nil, breakPolicy: nil, hasSelection: true)
        XCTAssertEqual(decision.action, .clear)
        XCTAssertTrue(decision.isChange)
    }
}
