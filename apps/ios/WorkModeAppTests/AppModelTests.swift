import XCTest
@testable import WorkModeApp
import WorkModeCore

@MainActor
final class AppModelTests: XCTestCase {
    private var env: TestEnvironment!

    override func setUpWithError() throws {
        env = try TestEnvironment(testCase: self, now: iso("2026-10-06T07:00:00Z"))
    }

    /// A phone that finished setup, with today's 08:00–16:00 shift and a policy cached.
    private func setUpCompletedPhone() async throws {
        try env.join()
        try await env.authoriseAndSelect()
        try env.cache.update { state in
            state.policy = Fixtures.policy
            state.breakPolicy = Fixtures.breakPolicy
            state.shifts = [Fixtures.shift]
            state.policyVersion = Fixtures.policy.policyVersionId
            state.scheduleVersion = 1
            state.lastSyncAt = iso("2026-10-06T06:55:00Z")
            state.setupCompletedAt = iso("2026-10-05T12:00:00Z")
            state.lastPermissionState = .approved
        }
        try env.plans.write(PlansFile(generatedAt: env.clock.now, organisationName: "Org", entries: [:]))
    }

    func testRouteFollowsJoinAndSetupState() async throws {
        let fresh = AppModel(container: env.makeContainer(), now: { [clock = env.clock] in clock.now })
        fresh.loadRoute()
        XCTAssertEqual(fresh.route, .onboarding)
        XCTAssertEqual(fresh.onboarding?.step, .welcome)

        try env.join()
        let joined = AppModel(container: env.makeContainer(), now: { [clock = env.clock] in clock.now })
        joined.loadRoute()
        XCTAssertEqual(joined.onboarding?.step, .screenTimeExplained, "joined but not set up resumes at screen 5")

        try await setUpCompletedPhone()
        let ready = AppModel(container: env.makeContainer(), now: { [clock = env.clock] in clock.now })
        ready.loadRoute()
        XCTAssertEqual(ready.route, .main)
        XCTAssertEqual(ready.expectedState?.state, .offShift, "the cached schedule is evaluated before any sync")
        XCTAssertEqual(ready.homeCard.kind, .offShift)
    }

    func testTickEnforcesWhenTheSavedScheduleSaysTheShiftStarted() async throws {
        try await setUpCompletedPhone()
        let model = AppModel(container: env.makeContainer(), now: { [clock = env.clock] in clock.now })
        model.loadRoute()
        XCTAssertEqual(model.expectedState?.state, .offShift)

        env.clock.now = iso("2026-10-06T08:00:00Z")
        await model.tick()
        XCTAssertEqual(model.expectedState?.state, .working)
        XCTAssertEqual(env.provider.appliedWorkPlans.count, 1)
        XCTAssertEqual(model.homeCard.kind, .workModeActive)
        XCTAssertEqual(env.outbox.pending().map(\.type), [.workModeStarted])

        env.clock.now = iso("2026-10-06T08:00:30Z")
        await model.tick()
        XCTAssertEqual(env.provider.appliedWorkPlans.count, 1, "nothing changed: nothing re-applied")
        XCTAssertTrue(env.api.calls.isEmpty, "ticks never touch the network")
    }

    func testLeaveWorkplaceLiftsRestrictionsWipesAndUnlinks() async throws {
        try await setUpCompletedPhone()
        let container = env.makeContainer()
        try container.tokenStore.saveTokens(Fixtures.confirmResponse.tokens)
        let model = AppModel(container: container, now: { [clock = env.clock] in clock.now })
        model.loadRoute()

        try await model.leaveWorkplace()
        XCTAssertEqual(env.api.calls, ["leaveWorkplace"])
        XCTAssertGreaterThanOrEqual(env.provider.clearCount, 1)
        XCTAssertGreaterThanOrEqual(env.provider.cancelCount, 1)
        XCTAssertNil(env.cache.load())
        XCTAssertNil(env.plans.read())
        XCTAssertNil(try container.tokenStore.loadTokens())
        XCTAssertFalse(env.provider.hasSelection(), "the simulated selection is forgotten too")
        XCTAssertEqual(model.route, .onboarding)
        XCTAssertEqual(model.onboarding?.step, .welcome)
    }

    func testLeaveWorkplaceStillLeavesLocallyWhenTheServerIsUnreachable() async throws {
        try await setUpCompletedPhone()
        env.api.leaveHandler = { throw APIError.network(URLError(.notConnectedToInternet)) }
        let model = AppModel(container: env.makeContainer(), now: { [clock = env.clock] in clock.now })
        model.loadRoute()
        do {
            try await model.leaveWorkplace()
            XCTFail("the UI must be told the server was not reached")
        } catch {
            XCTAssertEqual((error as? APIError)?.code, .networkError)
        }
        XCTAssertNil(env.cache.load())
        XCTAssertEqual(env.provider.activeRestriction, .none)
        XCTAssertEqual(model.route, .onboarding)
    }

    func testUnreadableCredentialsDoNotEndTheSession() async throws {
        try await setUpCompletedPhone()
        env.api.syncHandler = { throw APIError.credentialsUnavailable() }
        let model = AppModel(container: env.makeContainer(), now: { [clock = env.clock] in clock.now })
        model.loadRoute()
        await model.refresh(reason: .foreground)
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(model.route, .main, "a locked or failing Keychain is not a sign-out")
        XCTAssertEqual(model.lastSyncError?.code, .credentialsUnavailable)
        XCTAssertNotNil(env.cache.load()?.organisation)
        XCTAssertNil(model.sessionEndedMessage)
    }

    func testDeactivatedDeviceEndsTheSessionAndLiftsRestrictions() async throws {
        try await setUpCompletedPhone()
        env.clock.now = iso("2026-10-06T09:00:00Z")
        _ = await env.syncCoordinator.enforceFromCache()
        XCTAssertNotEqual(env.provider.activeRestriction, .none, "shields are up during the shift")
        env.api.syncHandler = { throw APIError(code: .deviceInactive, message: "This device has been deactivated", status: 401) }
        let model = AppModel(container: env.makeContainer(), now: { [clock = env.clock] in clock.now })
        model.loadRoute()
        await model.refresh(reason: .foreground)
        for _ in 0..<50 where model.route != .onboarding {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(model.route, .onboarding)
        XCTAssertEqual(model.onboarding?.step, .welcome)
        XCTAssertNotNil(model.sessionEndedMessage)
        XCTAssertNil(env.cache.load())
        XCTAssertEqual(env.provider.activeRestriction, .none)
    }

    func testHasChangedIgnoresTimestampsOnly() {
        let engine = WorkModeEngine()
        let a = engine.computeExpectedState(now: iso("2026-10-06T09:00:00Z"), shifts: [Fixtures.shift], breakSessions: [], overrides: [], permissionState: .approved)
        let b = engine.computeExpectedState(now: iso("2026-10-06T09:01:00Z"), shifts: [Fixtures.shift], breakSessions: [], overrides: [], permissionState: .approved)
        let c = engine.computeExpectedState(now: iso("2026-10-06T15:56:00Z"), shifts: [Fixtures.shift], breakSessions: [], overrides: [], permissionState: .approved)
        XCTAssertFalse(AppModel.hasChanged(from: a, to: b))
        XCTAssertTrue(AppModel.hasChanged(from: a, to: c), "WORKING → SHIFT_ENDING")
    }
}
