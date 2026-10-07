import XCTest
@testable import ClockOffApp
import WorkModeCore

final class MockRestrictionProviderTests: XCTestCase {
    private let london = TimeZone(identifier: "Europe/London")!

    private func activity(_ name: String, _ start: String, _ end: String) -> ActivityPlan {
        ActivityPlan(name: name, shiftId: "s", startComponents: deviceComponents(for: iso(start), in: london),
                     endComponents: deviceComponents(for: iso(end), in: london), warningMinutes: 15, kind: .shift)
    }

    private let plan = RestrictionPlan(shiftId: "s", policyVersion: "pv", categories: [.socialMedia], shieldMessage: nil, requiresBreakSubsetSelection: false)

    func testDebugBuildsChooseTheMockAndShowTheDevelopmentBanner() throws {
        let choice = RestrictionProviderFactory.make(store: InMemoryKeyValueStore())
        XCTAssertTrue(choice.isMock, "drives AppModel.isUsingMockRestrictions → DevelopmentModeBanner")
        XCTAssertTrue(choice.provider is MockRestrictionProvider)
        XCTAssertNotNil(choice.selectionConfigurator)

        let env = try TestEnvironment(testCase: self)
        let container = env.makeContainer()
        XCTAssertTrue(container.isUsingMockRestrictions)
    }

    func testAuthoriseSelectScheduleApplyClearFlow() async throws {
        let mock = MockRestrictionProvider(store: InMemoryKeyValueStore())
        XCTAssertEqual(mock.authorizationStatus, .notDetermined)
        XCTAssertEqual(mock.currentEngineState().state, .permissionError)

        try await mock.requestAuthorization()
        XCTAssertEqual(mock.authorizationStatus, .approved)
        XCTAssertFalse(mock.hasSelection())

        _ = try mock.configureSelection()
        XCTAssertTrue(mock.hasSelection())
        XCTAssertEqual(mock.selectionCounts(), MockRestrictionProvider.defaultSelection)

        try mock.scheduleActivities([activity("wm.shift.s", "2026-10-06T08:00:00Z", "2026-10-06T16:00:00Z")])
        XCTAssertEqual(mock.scheduledActivities.map(\.name), ["wm.shift.s"])

        try mock.applyWorkRestrictions(plan: plan)
        XCTAssertEqual(mock.activeRestriction, .work(plan))
        XCTAssertEqual(mock.currentEngineState().state, .working)
        XCTAssertEqual(mock.currentEngineState().source, .provider)

        try mock.applyBreakRestrictions(plan: plan, behaviour: .relaxAll)
        XCTAssertEqual(mock.activeRestriction, .onBreak(plan, .relaxAll))
        XCTAssertEqual(mock.currentEngineState().state, .onBreak)

        try mock.clearRestrictions()
        XCTAssertEqual(mock.activeRestriction, .none)
        XCTAssertEqual(mock.currentEngineState().state, .offShift)
        mock.cancelAllActivities()
        XCTAssertTrue(mock.scheduledActivities.isEmpty)

        XCTAssertEqual(mock.appliedWorkPlans, [plan])
        XCTAssertEqual(mock.appliedBreaks, [MockRestrictionProvider.AppliedBreak(plan: plan, behaviour: .relaxAll)])
        XCTAssertEqual(mock.clearCount, 1)
        XCTAssertEqual(mock.cancelCount, 1)
        XCTAssertFalse(mock.log.isEmpty)
    }

    func testApplyingRequiresAuthorisationThenSelection() async throws {
        let mock = MockRestrictionProvider(store: InMemoryKeyValueStore())
        XCTAssertThrowsError(try mock.applyWorkRestrictions(plan: plan)) { XCTAssertEqual($0 as? RestrictionProviderError, .notAuthorized) }
        XCTAssertThrowsError(try mock.scheduleActivities([])) { XCTAssertEqual($0 as? RestrictionProviderError, .notAuthorized) }
        try await mock.requestAuthorization()
        XCTAssertThrowsError(try mock.applyBreakRestrictions(plan: plan, behaviour: .keepRestrictions)) { XCTAssertEqual($0 as? RestrictionProviderError, .noSelection) }
        XCTAssertNoThrow(try mock.clearRestrictions(), "clearing never fails")
    }

    func testAuthorisationOutcomes() async {
        let denied = MockRestrictionProvider(store: InMemoryKeyValueStore(), authorizationOutcome: .deny)
        try? await denied.requestAuthorization()
        XCTAssertEqual(denied.authorizationStatus, .denied)

        let failing = MockRestrictionProvider(store: InMemoryKeyValueStore(), authorizationOutcome: .fail)
        do {
            try await failing.requestAuthorization()
            XCTFail("expected a simulated failure")
        } catch {}
        XCTAssertEqual(failing.authorizationStatus, .notDetermined)

        let approved = MockRestrictionProvider(store: InMemoryKeyValueStore())
        try? await approved.requestAuthorization()
        approved.simulateRevocation()
        XCTAssertEqual(approved.authorizationStatus, .denied)
        XCTAssertEqual(approved.authorizationStatus.permissionState(previous: .approved), .revoked)
    }

    func testSchedulingEnforcesAppleLimitsAndReplaces() async throws {
        let mock = MockRestrictionProvider(store: InMemoryKeyValueStore())
        try await mock.requestAuthorization()
        XCTAssertThrowsError(try mock.scheduleActivities([activity("short", "2026-10-06T08:00:00Z", "2026-10-06T08:10:00Z")]))
        let many = (0..<21).map { activity("a\($0)", "2026-10-06T08:00:00Z", "2026-10-06T09:00:00Z") }
        XCTAssertThrowsError(try mock.scheduleActivities(many))
        try mock.scheduleActivities([activity("one", "2026-10-06T08:00:00Z", "2026-10-06T09:00:00Z")])
        try mock.scheduleActivities([activity("two", "2026-10-06T10:00:00Z", "2026-10-06T11:00:00Z")])
        XCTAssertEqual(mock.scheduledActivities.map(\.name), ["two"], "a new schedule replaces the old one")
    }

    func testAuthorisationAndSelectionPersistAcrossLaunchesAndReset() async throws {
        let store = InMemoryKeyValueStore()
        let first = MockRestrictionProvider(store: store)
        try await first.requestAuthorization()
        first.simulateSelection(SelectionCounts(categories: 1, applications: 2, webDomains: 0))
        let relaunched = MockRestrictionProvider(store: store)
        XCTAssertEqual(relaunched.authorizationStatus, .approved)
        XCTAssertEqual(relaunched.selectionCounts().applications, 2)
        relaunched.reset()
        let afterReset = MockRestrictionProvider(store: store)
        XCTAssertEqual(afterReset.authorizationStatus, .notDetermined)
        XCTAssertFalse(afterReset.hasSelection())
    }
}
