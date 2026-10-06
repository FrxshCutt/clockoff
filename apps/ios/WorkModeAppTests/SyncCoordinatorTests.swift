import XCTest
@testable import WorkModeApp
import WorkModeCore

/// `SyncCoordinator` against a stubbed API, temporary App Group storage and the mock restriction provider.
final class SyncCoordinatorTests: XCTestCase {
    private var env: TestEnvironment!

    override func setUpWithError() throws {
        env = try TestEnvironment(testCase: self, now: iso("2026-10-06T09:00:00Z"))
        try env.join()
        env.api.syncHandler = { Fixtures.bundle() }
        env.api.meHandler = { Fixtures.me }
    }

    private var shiftActivityName: String { ActivityPlanner.shiftActivityPrefix + Fixtures.shift.id }

    func testFirstSyncCachesSchedulesEnforcesAndReports() async throws {
        try await env.authoriseAndSelect()
        let outcome = await env.syncCoordinator.sync(reason: .foreground)

        XCTAssertNil(outcome.error)
        XCTAssertTrue(outcome.policyChanged)
        XCTAssertTrue(outcome.scheduleChanged)
        XCTAssertTrue(outcome.activitiesRescheduled)
        XCTAssertEqual(outcome.expectedState.state, .working)
        XCTAssertEqual(outcome.engineState.state, .working)
        XCTAssertEqual(outcome.engineState.source, .appEngine)
        let plan = RestrictionPlan.make(shiftId: Fixtures.shift.id, policy: Fixtures.policy, breakPolicy: Fixtures.breakPolicy)
        XCTAssertEqual(outcome.restrictionAction, .applyWork(plan))
        XCTAssertEqual(env.provider.activeRestriction, .work(plan))

        // DeviceActivity schedule + plans.json for the monitor extension.
        XCTAssertEqual(env.provider.scheduledActivities.map(\.name), [shiftActivityName])
        let scheduled = try XCTUnwrap(env.provider.scheduledActivities.first)
        XCTAssertEqual(scheduled.startComponents.hour, 9, "08:00Z is 09:00 BST")
        XCTAssertEqual(scheduled.endComponents.hour, 17)
        XCTAssertEqual(scheduled.warningMinutes, 15)
        let file = try XCTUnwrap(env.plans.read())
        XCTAssertEqual(file.organisationName, Fixtures.organisation.name)
        XCTAssertEqual(file.entries[shiftActivityName]?.plan, plan)

        // Cache.
        let cached = try XCTUnwrap(env.cache.load())
        XCTAssertEqual(cached.shifts, [Fixtures.shift])
        XCTAssertEqual(cached.policyVersion, Fixtures.policy.policyVersionId)
        XCTAssertEqual(cached.scheduleVersion, 1)
        XCTAssertEqual(cached.lastSyncAt, env.clock.now)
        XCTAssertEqual(cached.lastPolicySyncAt, env.clock.now)
        XCTAssertEqual(cached.engineState?.state, .working)
        XCTAssertNil(cached.lastSyncErrorCode)

        // Events delivered and check-in posted.
        XCTAssertEqual(env.api.postedEvents.map(\.type), [.policySynced, .scheduleSynced, .workModeStarted])
        XCTAssertEqual(env.api.postedEvents.last?.metadata?.shiftId, Fixtures.shift.id)
        XCTAssertTrue(env.outbox.pending().isEmpty)
        let report = try XCTUnwrap(env.api.deviceStateReports.last)
        XCTAssertEqual(report.restrictionEngineState, .working)
        XCTAssertEqual(report.policyVersionApplied, Fixtures.policy.policyVersionId)
        XCTAssertEqual(report.scheduleVersionApplied, 1)
        XCTAssertEqual(report.selectionState, .configured)
        XCTAssertEqual(env.api.calls.filter { $0 == "me" }.count, 0, "profile is refreshed only on launch/setup or when missing")
    }

    func testUnchangedVersionsDoNotRescheduleOrReEmit() async throws {
        try await env.authoriseAndSelect()
        _ = await env.syncCoordinator.sync(reason: .foreground)
        let cancelsAfterFirst = env.provider.cancelCount
        let eventsAfterFirst = env.api.postedEvents.count

        env.clock.now = iso("2026-10-06T09:10:00Z")
        let second = await env.syncCoordinator.sync(reason: .pullToRefresh)
        XCTAssertFalse(second.policyChanged)
        XCTAssertFalse(second.scheduleChanged)
        XCTAssertFalse(second.activitiesRescheduled)
        XCTAssertEqual(env.provider.cancelCount, cancelsAfterFirst)
        XCTAssertEqual(env.api.postedEvents.count, eventsAfterFirst, "no new events while nothing changed")
        XCTAssertEqual(env.api.deviceStateReports.count, 2, "every sync checks in")
    }

    func testScheduleVersionBumpReplansAndEmitsScheduleSyncedOnly() async throws {
        try await env.authoriseAndSelect()
        _ = await env.syncCoordinator.sync(reason: .foreground)
        let tomorrow = Shift(id: "00000000-0000-4000-8000-000000000031", startsAt: iso("2026-10-07T08:00:00Z"),
                             endsAt: iso("2026-10-07T12:00:00Z"), timezone: "Europe/London")
        env.api.syncHandler = { Fixtures.bundle(scheduleVersion: 2, shifts: [Fixtures.shift, tomorrow]) }

        let outcome = await env.syncCoordinator.sync(reason: .silentPush)
        XCTAssertFalse(outcome.policyChanged)
        XCTAssertTrue(outcome.scheduleChanged)
        XCTAssertTrue(outcome.activitiesRescheduled)
        XCTAssertEqual(env.provider.scheduledActivities.map(\.name), [shiftActivityName, ActivityPlanner.shiftActivityPrefix + tomorrow.id])
        XCTAssertEqual(env.api.postedEvents.filter { $0.type == .scheduleSynced }.count, 2)
        XCTAssertEqual(env.api.postedEvents.filter { $0.type == .policySynced }.count, 1)
        XCTAssertEqual(env.api.postedEvents.last(where: { $0.type == .scheduleSynced })?.metadata?.scheduleVersion, 2)
    }

    func testShiftEndClearsShieldsAndEmitsWorkModeEnded() async throws {
        try await env.authoriseAndSelect()
        _ = await env.syncCoordinator.sync(reason: .foreground)
        env.clock.now = iso("2026-10-06T16:00:00Z")
        let outcome = await env.syncCoordinator.sync(reason: .foreground)
        XCTAssertEqual(outcome.expectedState.state, .offShift)
        XCTAssertEqual(outcome.restrictionAction, .clear)
        XCTAssertEqual(env.provider.activeRestriction, .none)
        XCTAssertEqual(env.api.postedEvents.last?.type, .workModeEnded)
    }

    func testNetworkFailureEnforcesFromCacheAndKeepsTheOutbox() async throws {
        try await env.authoriseAndSelect()
        _ = await env.syncCoordinator.sync(reason: .foreground)
        env.api.syncHandler = { throw APIError.network(URLError(.notConnectedToInternet)) }
        env.api.eventsHandler = { _ in throw APIError.network(URLError(.notConnectedToInternet)) }
        env.clock.now = iso("2026-10-06T16:30:00Z")

        let outcome = await env.syncCoordinator.sync(reason: .foreground)
        XCTAssertEqual(outcome.error?.code, .networkError)
        XCTAssertEqual(outcome.expectedState.state, .offShift, "the cached schedule still drives enforcement")
        XCTAssertEqual(env.provider.activeRestriction, .none)
        XCTAssertEqual(env.outbox.pending().map(\.type), [.workModeEnded], "undelivered events stay queued")
        XCTAssertEqual(env.cache.load()?.lastSyncErrorCode, APIErrorCode.networkError.rawValue)
        XCTAssertEqual(env.cache.load()?.lastSyncAt, iso("2026-10-06T09:00:00Z"), "a failed sync does not move lastSyncAt")
    }

    func testEventsTheServerRefusesAreDroppedSoLaterEventsStillFlow() async throws {
        try await env.authoriseAndSelect()
        env.api.eventsHandler = { _ in throw APIError(code: .validationError, message: "Invalid event", status: 400) }
        _ = await env.syncCoordinator.sync(reason: .foreground)
        XCTAssertTrue(env.outbox.pending().isEmpty, "a refused batch is dropped, never retried forever")

        // Later events are delivered normally once the server accepts them again.
        env.api.eventsHandler = { events in DeviceEventsResponse(accepted: events.count, duplicates: 0) }
        env.clock.now = iso("2026-10-06T16:00:00Z")
        _ = await env.syncCoordinator.sync(reason: .foreground)
        XCTAssertEqual(env.api.postedEvents.map(\.type), [.workModeEnded])
        XCTAssertTrue(env.outbox.pending().isEmpty)
    }

    func testUnreadableCredentialsStillEnforceFromCacheAndKeepEvents() async throws {
        try await env.authoriseAndSelect()
        _ = await env.syncCoordinator.sync(reason: .foreground)
        env.api.syncHandler = { throw APIError.credentialsUnavailable() }
        env.api.eventsHandler = { _ in throw APIError.credentialsUnavailable() }
        env.api.deviceStateHandler = { _ in throw APIError.credentialsUnavailable() }
        env.clock.now = iso("2026-10-06T16:00:00Z")

        let outcome = await env.syncCoordinator.sync(reason: .backgroundRefresh)
        XCTAssertEqual(outcome.error?.code, .credentialsUnavailable)
        XCTAssertEqual(outcome.restrictionAction, .clear, "the cached schedule is still enforced: the shift ended")
        XCTAssertEqual(env.provider.activeRestriction, .none)
        XCTAssertEqual(env.outbox.pending().map(\.type), [.workModeEnded], "events wait for the Keychain to be readable")
        XCTAssertNotNil(env.cache.load()?.organisation, "nothing is wiped")
    }

    func testMissingSelectionDuringShiftReportsPermissionError() async throws {
        env.provider.authorizationOutcome = .approve
        try await env.provider.requestAuthorization()
        let outcome = await env.syncCoordinator.sync(reason: .foreground)
        XCTAssertEqual(outcome.expectedState.state, .working)
        XCTAssertEqual(outcome.engineState.state, .permissionError, "nothing to shield with: the employee must choose apps")
        XCTAssertTrue(env.provider.appliedWorkPlans.isEmpty)
        XCTAssertEqual(env.api.deviceStateReports.last?.selectionState, SelectionState.none)
    }

    func testLostPermissionQueuesPermissionNeedsAttention() async throws {
        try await env.authoriseAndSelect()
        _ = await env.syncCoordinator.sync(reason: .foreground)
        env.provider.simulateRevocation()
        let outcome = await env.syncCoordinator.sync(reason: .foreground)
        XCTAssertEqual(outcome.expectedState.state, .permissionError)
        XCTAssertEqual(outcome.expectedState.permissionState, .revoked)
        let attention = try XCTUnwrap(env.api.postedEvents.last { $0.type == .permissionNeedsAttention })
        XCTAssertEqual(attention.metadata?.permissionState, .revoked)
        XCTAssertEqual(env.api.deviceStateReports.last?.permissionState, .revoked)
    }

    func testNotSignedInMakesNoNetworkCalls() async {
        env.api.credentials = false
        let outcome = await env.syncCoordinator.sync(reason: .foreground)
        XCTAssertEqual(outcome.error?.code, .notSignedIn)
        XCTAssertTrue(env.api.calls.isEmpty)
    }

    func testConcurrentSyncsCoalesce() async {
        env.api.syncDelayNanoseconds = 200_000_000
        async let first = env.syncCoordinator.sync(reason: .foreground)
        async let second = env.syncCoordinator.sync(reason: .pullToRefresh)
        let outcomes = await [first, second]
        XCTAssertEqual(outcomes.count, 2)
        XCTAssertEqual(env.api.calls.filter { $0 == "sync" }.count, 1)
    }

    func testLaunchRefreshesTheProfile() async {
        _ = await env.syncCoordinator.sync(reason: .launch)
        XCTAssertEqual(env.api.calls.filter { $0 == "me" }.count, 1)
    }
}

/// The Home state card for each engine state and local health signal.
final class HomeCardTests: XCTestCase {
    private let london = TimeZone(identifier: "Europe/London")!
    private let now = iso("2026-10-06T09:00:00Z")
    private let engine = WorkModeEngine()

    private func card(at instant: String? = nil, breaks: [BreakSession] = [], permission: PermissionState = .approved,
                      hasSelection: Bool = true, lastSyncAt: Date? = iso("2026-10-06T08:55:00Z"), expected: Bool = true) -> HomeCard {
        let at = instant.map { iso($0) } ?? now
        let state = engine.computeExpectedState(now: at, shifts: [Fixtures.shift], breakSessions: breaks, overrides: [], permissionState: permission)
        return HomeCard.make(expected: expected ? state : nil, cache: CachedState(lastSyncAt: lastSyncAt), permission: permission,
                             hasSelection: hasSelection, now: at, timeZone: london)
    }

    func testStates() {
        XCTAssertEqual(card().kind, .workModeActive)
        XCTAssertEqual(card().title, "WORK MODE ACTIVE")
        XCTAssertEqual(card(at: "2026-10-06T07:50:00Z").kind, .startingSoon)
        XCTAssertEqual(card(at: "2026-10-06T18:00:00Z", lastSyncAt: iso("2026-10-06T17:55:00Z")).kind, .offShift)
        let onBreak = BreakSession(id: "b", clientBreakId: "c", shiftId: Fixtures.shift.id, startedAt: iso("2026-10-06T08:55:00Z"),
                                   plannedEndsAt: iso("2026-10-06T09:10:00Z"))
        let breakCard = card(breaks: [onBreak])
        XCTAssertEqual(breakCard.kind, .breakActive)
        XCTAssertEqual(breakCard.title, "BREAK ACTIVE")
    }

    func testActionRequiredAndSyncDelayed() {
        XCTAssertEqual(card(permission: .revoked).kind, .actionRequired)
        XCTAssertEqual(card(permission: .revoked).title, "ACTION REQUIRED")
        XCTAssertEqual(card(hasSelection: false).kind, .actionRequired)
        XCTAssertEqual(card(lastSyncAt: nil, expected: false).kind, .syncDelayed)
        XCTAssertEqual(card(lastSyncAt: nil, expected: false).title, "SYNC DELAYED")
        XCTAssertEqual(card(at: "2026-10-06T18:00:00Z", lastSyncAt: iso("2026-10-05T18:00:00Z")).kind, .syncDelayed,
                       "off shift with a stale cache says so")
    }
}
