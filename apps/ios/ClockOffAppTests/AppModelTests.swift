import XCTest
@testable import ClockOffApp
import ClockOffCore

/// `AppModel` with the `WorkModeController` mounted: routing, Home state from the controller, breaks, setup repair,
/// leave/sign-out and connectivity-driven syncs.
@MainActor
final class AppModelTests: XCTestCase {
    private var env: TestEnvironment!

    override func setUpWithError() throws {
        env = try TestEnvironment(testCase: self, now: iso("2026-10-06T07:00:00Z"))
    }

    func testRouteFollowsJoinAndSetupState() async throws {
        let fresh = env.makeAppModel()
        fresh.loadRoute()
        XCTAssertEqual(fresh.route, .onboarding)
        XCTAssertEqual(fresh.onboarding?.step, .welcome)

        try env.join()
        let joined = env.makeAppModel()
        joined.loadRoute()
        XCTAssertEqual(joined.onboarding?.step, .screenTimeExplained, "joined but not set up resumes at screen 5")

        // Progress persisted past screen 6 is clamped to what Screen Time allows.
        env.onboardingProgress.step = .chooseApps
        let resumed = env.makeAppModel()
        resumed.loadRoute()
        XCTAssertEqual(resumed.onboarding?.step, .authorise, "not authorised yet: cannot skip past screen 6")

        try await env.setUpCompletedPhone()
        let ready = env.makeAppModel()
        ready.loadRoute()
        XCTAssertEqual(ready.route, .main)
        XCTAssertNil(ready.onboarding)
        ready.controller.reconcile()
        XCTAssertEqual(ready.controller.expectedState?.state, .offShift, "the cached schedule is evaluated before any sync")
        XCTAssertEqual(ready.homeCard.kind, .offShift)
    }

    func testControllerDrivesHomeWhenTheShiftStartsWhileTheAppIsOpen() async throws {
        try await env.setUpCompletedPhone()
        let model = env.makeAppModel()
        model.loadRoute()
        model.controller.reconcile()
        XCTAssertEqual(model.homeCard.kind, .offShift)

        env.clock.now = iso("2026-10-06T08:00:00Z")
        model.controller.reconcile(reason: WorkModeController.reasonTimer)
        XCTAssertEqual(model.homeCard.kind, .working)
        XCTAssertEqual(model.homeCard.title, "WORK MODE ACTIVE")
        XCTAssertEqual(env.provider.appliedWorkPlans.count, 1)
        XCTAssertEqual(env.outbox.pending().map(\.type), [.workModeStarted])
        XCTAssertTrue(env.api.calls.isEmpty, "reconciling never touches the network")

        model.controller.reconcile(reason: WorkModeController.reasonForeground)
        XCTAssertEqual(env.provider.appliedWorkPlans.count, 1, "nothing changed: nothing re-applied")
    }

    func testStartAndEndBreakGoThroughTheControllerAndReplanNotifications() async throws {
        try await env.setUpCompletedPhone()
        env.api.acceptBreaks()
        env.clock.now = iso("2026-10-06T10:00:00Z")
        let model = env.makeAppModel()
        model.loadRoute()
        model.controller.reconcile()
        XCTAssertEqual(model.homeCard.action, .startBreak)

        let session = try await model.startBreak()
        XCTAssertEqual(env.api.startBreakRequests.count, 1)
        XCTAssertEqual(model.homeCard.kind, .onBreak)
        XCTAssertEqual(model.homeCard.action, .endBreak)
        XCTAssertEqual(model.cachedState.activeBreakSession?.id, session.id)
        let planned = env.notifications.lastPlanned.map(\.id)
        XCTAssertTrue(planned.contains(NotificationPlanner.breakEnding(clientBreakId: session.clientBreakId)))
        XCTAssertTrue(planned.contains(NotificationPlanner.breakEnded(clientBreakId: session.clientBreakId)))

        env.clock.now = iso("2026-10-06T10:05:00Z")
        try await model.endBreakEarly()
        XCTAssertEqual(env.api.endBreakRequests.count, 1)
        XCTAssertEqual(env.api.endBreakRequests.first?.id, session.id)
        XCTAssertEqual(model.homeCard.kind, .working)
        XCTAssertFalse(env.notifications.lastPlanned.map(\.id).contains(NotificationPlanner.breakEnded(clientBreakId: session.clientBreakId)))
    }

    func testSetupRepairRestoresASelectionThatRegressed() async throws {
        try await env.setUpCompletedPhone()
        env.provider.clearSelection()
        let model = env.makeAppModel()
        model.loadRoute()
        model.controller.reconcile()
        XCTAssertEqual(model.route, .main, "a regression after setup never sends the employee back to onboarding")
        XCTAssertTrue(model.setupNeedsRepair)
        XCTAssertEqual(model.homeCard.kind, .actionRequired)
        XCTAssertEqual(model.homeCard.action, .openSetup)

        model.openSetupRepair()
        let repair = try XCTUnwrap(model.repair)
        XCTAssertEqual(repair.mode, .repair)
        XCTAssertEqual(repair.step, .chooseApps)
        repair.chooseApps()
        await repair.continueFromChooseApps()
        XCTAssertNil(model.repair, "finishing the repair dismisses it")
        XCTAssertFalse(model.setupNeedsRepair)
        XCTAssertEqual(env.api.deviceStateReports.last?.selectionState, .configured)
        XCTAssertEqual(model.homeCard.kind, .offShift)
    }

    func testSetupRepairStartsAtAuthorisationWhenAccessWasRevoked() async throws {
        try await env.setUpCompletedPhone()
        env.provider.simulateRevocation()
        let model = env.makeAppModel()
        model.loadRoute()
        model.controller.reconcile()
        XCTAssertEqual(model.permissionState, .revoked)
        XCTAssertEqual(model.homeCard.kind, .actionRequired)
        model.openSetupRepair()
        XCTAssertEqual(model.repair?.step, .authorise)
    }

    func testLeaveWorkplaceLiftsRestrictionsWipesAndUnlinks() async throws {
        try await env.setUpCompletedPhone()
        let container = env.makeContainer()
        try container.tokenStore.saveTokens(Fixtures.confirmResponse.tokens)
        env.onboardingProgress.step = .confirmPolicy
        env.syncMetadata.lastServerContactAt = env.clock.now
        let model = env.makeAppModel(container: container)
        model.loadRoute()
        model.controller.start()

        try await model.leaveWorkplace()
        XCTAssertEqual(env.api.calls, ["leaveWorkplace"])
        XCTAssertGreaterThanOrEqual(env.provider.clearCount, 1)
        XCTAssertGreaterThanOrEqual(env.provider.cancelCount, 1)
        XCTAssertNil(env.cache.load())
        XCTAssertNil(env.plans.read())
        XCTAssertNil(try container.tokenStore.loadTokens())
        XCTAssertFalse(env.provider.hasSelection(), "the simulated selection is forgotten too")
        XCTAssertEqual(env.notifications.cancelAllCount, 1)
        XCTAssertNil(env.onboardingProgress.step)
        XCTAssertNil(env.syncMetadata.lastServerContactAt)
        XCTAssertEqual(model.route, .onboarding)
        XCTAssertEqual(model.onboarding?.step, .welcome)
        XCTAssertEqual(model.controller.state, .unknown)
    }

    func testLeaveWorkplaceStillLeavesLocallyWhenTheServerIsUnreachable() async throws {
        try await env.setUpCompletedPhone()
        env.api.leaveHandler = { throw APIError.network(URLError(.notConnectedToInternet)) }
        let model = env.makeAppModel()
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
        try await env.setUpCompletedPhone()
        env.api.syncHandler = { throw APIError.credentialsUnavailable() }
        let model = env.makeAppModel()
        model.loadRoute()
        await model.refresh(reason: .foreground)
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(model.route, .main, "a locked or failing Keychain is not a sign-out")
        XCTAssertEqual(model.lastSyncError?.code, .credentialsUnavailable)
        XCTAssertNotNil(env.cache.load()?.organisation)
        XCTAssertNil(model.sessionEndedMessage)
    }

    func testDeactivatedDeviceEndsTheSessionAndLiftsRestrictions() async throws {
        try await env.setUpCompletedPhone()
        env.clock.now = iso("2026-10-06T09:00:00Z")
        _ = await env.syncCoordinator.enforceFromCache()
        XCTAssertNotEqual(env.provider.activeRestriction, .none, "shields are up during the shift")
        env.api.syncHandler = { throw APIError(code: .deviceInactive, message: "This device has been deactivated", status: 401) }
        let model = env.makeAppModel()
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

    func testStaleBannerAfterAnHourWithoutASync() async throws {
        try await env.setUpCompletedPhone(lastSyncAt: iso("2026-10-06T04:00:00Z"))
        let model = env.makeAppModel()
        model.loadRoute()
        XCTAssertEqual(model.staleBanner, "Last synced 3h ago · changes will apply when online")
        try env.cache.update { $0.lastSyncAt = iso("2026-10-06T06:30:00Z") }
        model.loadRoute()
        XCTAssertNil(model.staleBanner)
    }

    func testConnectivityRestoredTriggersASyncThatReconcilesTheController() async throws {
        try await env.setUpCompletedPhone()
        env.api.syncHandler = { Fixtures.bundle() }
        env.api.meHandler = { Fixtures.me }
        let model = env.makeAppModel()
        model.start()
        for _ in 0..<200 where env.api.calls.filter({ $0 == "sync" }).count < 1 || model.isSyncing {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertFalse(model.isSyncing)
        XCTAssertEqual(env.connectivity.startCount, 1)
        XCTAssertEqual(env.api.calls.filter { $0 == "sync" }.count, 1, "launch sync")

        env.connectivity.simulate(online: false)
        env.connectivity.simulate(online: true)
        for _ in 0..<100 where env.api.calls.filter({ $0 == "sync" }).count < 2 {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(env.api.calls.filter { $0 == "sync" }.count, 2, "reconnecting syncs again")
        XCTAssertTrue(model.isOnline)
    }

    func testRefusedOfflineBreakIsReportedToTheEmployeeAfterTheSync() async throws {
        try await env.setUpCompletedPhone()
        env.clock.now = iso("2026-10-06T10:05:00Z")
        let requestedAt = iso("2026-10-06T10:00:00Z")
        try env.cache.update { state in
            state.activeBreakSession = BreakSession(id: "c-1", clientBreakId: "c-1", shiftId: Fixtures.shift.id, startedAt: requestedAt,
                                                    plannedEndsAt: iso("2026-10-06T10:15:00Z"), restrictionBehaviour: .relaxAll)
            state.queuedBreaks = [QueuedBreakRecord(clientBreakId: "c-1", shiftId: Fixtures.shift.id, requestedAt: requestedAt,
                                                    requestedDurationMinutes: 15, plannedEndsAt: iso("2026-10-06T10:15:00Z"), createdAt: requestedAt)]
        }
        env.api.startBreakHandler = { _ in throw APIError(code: .breakTooSoon, message: "Breaks can start at 11:00.", status: 409) }
        env.api.syncHandler = { Fixtures.bundle() }
        let model = env.makeAppModel()
        model.loadRoute()
        await model.refresh(reason: .connectivity)
        XCTAssertEqual(model.notice, "Your break taken offline wasn't accepted by your workplace: Breaks can start at 11:00.")
        XCTAssertEqual(model.homeCard.kind, .working, "the relaxation is withdrawn")
        XCTAssertTrue(model.cachedState.queuedBreaks.isEmpty)
    }
}
