import XCTest
@testable import ClockOffApp
import WorkModeCore

/// A `BreakStarting` double: answers from closures and records every call.
final class StubBreakAPI: BreakStarting {
    var startHandler: (String, String, Date, Int?) throws -> BreakSession = { _, _, _, _ in throw StubMobileAPI.notStubbed("startBreak") }
    var endHandler: (String, Date, MobileBreakEndReason) throws -> Void = { _, _, _ in }
    private(set) var startCalls: [(clientBreakId: String, shiftId: String, requestedAt: Date, requestedDurationMinutes: Int?)] = []
    private(set) var endCalls: [(id: String, endedAt: Date, reason: MobileBreakEndReason)] = []

    func startBreak(clientBreakId: String, shiftId: String, requestedAt: Date, requestedDurationMinutes: Int?) async throws -> BreakSession {
        startCalls.append((clientBreakId, shiftId, requestedAt, requestedDurationMinutes))
        return try startHandler(clientBreakId, shiftId, requestedAt, requestedDurationMinutes)
    }

    func endBreak(id: String, endedAt: Date, reason: MobileBreakEndReason) async throws {
        endCalls.append((id, endedAt, reason))
        try endHandler(id, endedAt, reason)
    }

    /// Answers like the server: a RELAX_ALL session with a server id, starting at `requestedAt` for the requested
    /// length (default `minutes`).
    func acceptBreaks(minutes: Int = 15) {
        startHandler = { clientBreakId, shiftId, requestedAt, requested in
            BreakSession(
                id: "server-\(clientBreakId)",
                clientBreakId: clientBreakId,
                shiftId: shiftId,
                startedAt: requestedAt,
                plannedEndsAt: requestedAt.addingTimeInterval(TimeInterval((requested ?? minutes) * 60)),
                restrictionBehaviour: .relaxAll
            )
        }
    }
}

/// `WorkModeController` against the mock restriction provider, temporary App Group storage and a stubbed break
/// API: what `reconcile()` corrects, how breaks start (online, offline, refused), end and expire, and what the
/// UI is shown. The shift is 08:00–16:00Z (09:00–17:00 BST); breaks: 2 × 15 min, 60 min after start, 60 min gap.
@MainActor
final class WorkModeControllerTests: XCTestCase {
    private var env: TestEnvironment!
    private var breakAPI: StubBreakAPI!
    private var flags: SharedFlags!
    private let london = TimeZone(identifier: "Europe/London")!

    private var plan: RestrictionPlan {
        RestrictionPlan.make(shiftId: Fixtures.shift.id, policy: Fixtures.policy, breakPolicy: Fixtures.breakPolicy)
    }

    private var shiftRef: ShiftRef {
        ShiftRef(id: Fixtures.shift.id, startsAt: Fixtures.shift.startsAt, endsAt: Fixtures.shift.endsAt)
    }

    override func setUpWithError() throws {
        env = try TestEnvironment(testCase: self, now: iso("2026-10-06T09:00:00Z"))
        breakAPI = StubBreakAPI()
        flags = SharedFlags(store: InMemoryKeyValueStore())
        try env.join()
        try env.cache.update { state in
            state.policy = Fixtures.policy
            state.breakPolicy = Fixtures.breakPolicy
            state.shifts = [Fixtures.shift]
            state.policyVersion = Fixtures.policy.policyVersionId
            state.scheduleVersion = 1
            state.lastSyncAt = iso("2026-10-06T08:55:00Z")
            state.setupCompletedAt = iso("2026-10-05T12:00:00Z")
            state.lastPermissionState = .approved
        }
    }

    private func makeController() -> WorkModeController {
        let clock = env.clock
        let zone = london
        return WorkModeController(
            cache: env.cache,
            plans: env.plans,
            provider: env.provider,
            breakAPI: breakAPI,
            flags: flags,
            isDevelopmentMode: true,
            timeZone: { zone },
            now: { clock.now }
        )
    }

    // MARK: Reconcile

    func testNotJoinedPublishesUnknown() throws {
        try env.cache.wipe()
        let controller = makeController()
        XCTAssertEqual(controller.reconcile().note, "not joined")
        XCTAssertEqual(controller.state, .unknown)
        XCTAssertNil(controller.expectedState)
    }

    func testExpectedWorkWithNothingAppliedAppliesWorkShieldsOnce() async throws {
        try await env.authoriseAndSelect()
        let controller = makeController()

        let outcome = controller.reconcile(reason: WorkModeController.reasonLaunch)
        XCTAssertEqual(outcome.decision?.action, .applyWork(plan))
        XCTAssertEqual(outcome.decision?.isChange, true)
        XCTAssertEqual(outcome.appliedState, .working)
        XCTAssertEqual(outcome.queuedEvents, [.workModeStarted])
        XCTAssertEqual(env.provider.activeRestriction, .work(plan))

        let cached = try XCTUnwrap(env.cache.load())
        XCTAssertEqual(cached.engineState?.state, .working)
        XCTAssertEqual(cached.engineState?.source, .appEngine)
        XCTAssertEqual(cached.lastReconcileAt, env.clock.now)
        let event = try XCTUnwrap(env.outbox.pending().first)
        XCTAssertEqual(event.type, .workModeStarted)
        XCTAssertEqual(event.metadata?.shiftId, Fixtures.shift.id)
        XCTAssertEqual(event.metadata?.reason, ReconcileDecision.reasonReconcile)

        guard case .working(let shift, let endsAt, let allowance, let relaxedByManager) = controller.state else {
            return XCTFail("expected working, got \(controller.state)")
        }
        XCTAssertEqual(shift, shiftRef)
        XCTAssertEqual(endsAt, Fixtures.shift.endsAt)
        XCTAssertFalse(relaxedByManager)
        XCTAssertEqual(allowance?.breaksRemaining, 2)
        XCTAssertEqual(allowance?.canStartNow, true, "60 minutes after the 08:00 start")
        XCTAssertFalse(controller.needsBreakSelection)

        // Already enforced: a second pass changes nothing and queues nothing.
        let again = controller.reconcile(reason: WorkModeController.reasonForeground)
        XCTAssertEqual(again.decision?.isChange, false)
        XCTAssertEqual(env.provider.appliedWorkPlans.count, 1)
        XCTAssertEqual(env.outbox.pending().count, 1)
    }

    func testExpectedNoneWithShieldsUpClearsThem() async throws {
        try await env.authoriseAndSelect()
        let controller = makeController()
        controller.reconcile()
        XCTAssertEqual(env.provider.activeRestriction, .work(plan))

        env.clock.now = iso("2026-10-06T16:00:00Z")
        try env.cache.update { $0.lastSyncAt = iso("2026-10-06T15:30:00Z") }
        let outcome = controller.reconcile(reason: WorkModeController.reasonTimer)
        XCTAssertEqual(outcome.decision?.action, .clear)
        XCTAssertEqual(outcome.queuedEvents, [.workModeEnded])
        XCTAssertEqual(env.provider.activeRestriction, .none)
        XCTAssertEqual(env.cache.load()?.engineState?.state, .offShift)
        XCTAssertEqual(controller.state, .offShift(nextShift: nil))
        XCTAssertEqual(env.outbox.pending().map(\.type), [.workModeStarted, .workModeEnded])
    }

    func testExpectedBreakRelaxedAppliesTheBreakBehaviour() async throws {
        try await env.authoriseAndSelect()
        let session = BreakSession(id: "srv-1", clientBreakId: "c-1", shiftId: Fixtures.shift.id, startedAt: iso("2026-10-06T10:00:00Z"),
                                   plannedEndsAt: iso("2026-10-06T10:15:00Z"), restrictionBehaviour: .relaxAll)
        try env.cache.update { $0.activeBreakSession = session }
        env.clock.now = iso("2026-10-06T10:05:00Z")
        let controller = makeController()

        let outcome = controller.reconcile()
        XCTAssertEqual(outcome.decision?.action, .applyBreak(plan, .relaxAll))
        XCTAssertEqual(outcome.appliedState, .onBreak)
        XCTAssertEqual(outcome.queuedEvents, [.workModeStarted], "nothing was applied before: Work Mode is entered")
        XCTAssertEqual(env.provider.activeRestriction, .onBreak(plan, .relaxAll))
        guard case .onBreak(let shown, let endsAt, let remaining) = controller.state else {
            return XCTFail("expected onBreak, got \(controller.state)")
        }
        XCTAssertEqual(shown, session)
        XCTAssertEqual(endsAt, session.plannedEndsAt)
        XCTAssertEqual(remaining, 10 * 60)
        XCTAssertFalse(controller.reconcile().decision?.isChange ?? true, "already on the break")
    }

    func testMissingSelectionNeverAppliesAndAsksForApps() async throws {
        env.provider.authorizationOutcome = .approve
        try await env.provider.requestAuthorization()
        let controller = makeController()
        let outcome = controller.reconcile()
        XCTAssertEqual(outcome.decision?.reason, ReconcileDecision.reasonSelectionMissing)
        XCTAssertEqual(outcome.decision?.isChange, false)
        XCTAssertTrue(env.provider.appliedWorkPlans.isEmpty)
        XCTAssertEqual(controller.state, .actionRequired(.appsNotChosen))
        XCTAssertTrue(env.outbox.pending().isEmpty)
    }

    func testUIStateCoversStartingSoonManagerPauseAndStaleSync() async throws {
        try await env.authoriseAndSelect()
        let controller = makeController()

        env.clock.now = iso("2026-10-06T07:50:00Z")
        controller.reconcile()
        XCTAssertEqual(controller.state, .startingSoon(shift: shiftRef))
        XCTAssertEqual(env.provider.activeRestriction, .none, "starting soon enforces nothing")

        try env.cache.update {
            $0.activeOverrides = [ActiveOverride(id: "ov", type: .exemptTemporarily, startsAt: iso("2026-10-06T09:00:00Z"), expiresAt: iso("2026-10-06T10:00:00Z"))]
        }
        env.clock.now = iso("2026-10-06T09:30:00Z")
        controller.reconcile()
        guard case .pausedByManager(let override, let resumesAt) = controller.state else {
            return XCTFail("expected pausedByManager, got \(controller.state)")
        }
        XCTAssertEqual(override.id, "ov")
        XCTAssertEqual(resumesAt, iso("2026-10-06T10:00:00Z"))
        XCTAssertEqual(env.provider.activeRestriction, .none)

        env.clock.now = iso("2026-10-06T20:00:00Z")
        controller.reconcile()
        XCTAssertEqual(controller.state, .syncDelayed(lastSyncAt: iso("2026-10-06T08:55:00Z")), "off shift with a cache older than 6 h")
    }

    // MARK: Breaks

    func testStartBreakOnlineAppliesRelaxationSchedulesTheEndAndQueuesBreakStarted() async throws {
        try await env.authoriseAndSelect()
        breakAPI.acceptBreaks()
        env.clock.now = iso("2026-10-06T10:00:00Z")
        let controller = makeController()
        controller.reconcile()
        XCTAssertEqual(env.outbox.pending().map(\.type), [.workModeStarted])

        let session = try await controller.startBreak()
        XCTAssertEqual(breakAPI.startCalls.count, 1)
        XCTAssertEqual(breakAPI.startCalls.first?.shiftId, Fixtures.shift.id)
        XCTAssertEqual(breakAPI.startCalls.first?.requestedAt, env.clock.now)
        XCTAssertEqual(session.id, "server-\(session.clientBreakId)")
        XCTAssertEqual(session.plannedEndsAt, iso("2026-10-06T10:15:00Z"))
        XCTAssertEqual(env.cache.load()?.activeBreakSession, session)
        XCTAssertEqual(env.cache.load()?.queuedBreaks.isEmpty, true, "an online break needs no replay")
        XCTAssertEqual(env.provider.activeRestriction, .onBreak(plan, .relaxAll))

        // The DeviceActivity that ends the break with the app closed: its plans.json entry carries the true end.
        let activityName = ActivityNaming.breakActivity(clientBreakId: session.clientBreakId)
        XCTAssertEqual(env.provider.scheduledBreakActivities.map(\.name), [activityName])
        let entry = try XCTUnwrap(env.plans.entry(forActivityNamed: activityName))
        XCTAssertEqual(entry.breakBehaviour, .relaxAll)
        XCTAssertEqual(entry.clientBreakId, session.clientBreakId)
        XCTAssertEqual(entry.plannedEnd, session.plannedEndsAt)

        XCTAssertEqual(env.outbox.pending().map(\.type), [.workModeStarted, .breakStarted])
        let event = try XCTUnwrap(env.outbox.pending().last)
        XCTAssertEqual(event.metadata?.breakSessionId, session.id)
        XCTAssertEqual(event.metadata?.clientBreakId, session.clientBreakId)
        XCTAssertEqual(event.metadata?.engineState, .onBreak)
        XCTAssertEqual(env.cache.load()?.engineState?.state, .onBreak)
        guard case .onBreak(let shown, _, let remaining) = controller.state else {
            return XCTFail("expected onBreak, got \(controller.state)")
        }
        XCTAssertEqual(shown.id, session.id)
        XCTAssertEqual(remaining, 15 * 60)
        XCTAssertFalse(controller.isBreakRequestInFlight)
    }

    func testStartBreakOfflineUsesTheCachedPolicyAndQueuesTheBreakForReplay() async throws {
        try await env.authoriseAndSelect()
        breakAPI.startHandler = { _, _, _, _ in throw APIError.network(URLError(.notConnectedToInternet)) }
        env.clock.now = iso("2026-10-06T10:00:00Z")
        let controller = makeController()
        controller.reconcile()

        let session = try await controller.startBreak(requestedDurationMinutes: 10)
        XCTAssertEqual(session.id, session.clientBreakId, "a local break is keyed on its client break id")
        XCTAssertEqual(session.plannedEndsAt, iso("2026-10-06T10:10:00Z"))
        XCTAssertEqual(session.restrictionBehaviour, .relaxAll)
        let cached = try XCTUnwrap(env.cache.load())
        XCTAssertEqual(cached.activeBreakSession, session)
        XCTAssertTrue(cached.isLocalBreak(session))
        let record = try XCTUnwrap(cached.queuedBreaks.first)
        XCTAssertEqual(record.clientBreakId, session.clientBreakId)
        XCTAssertEqual(record.status, .pendingStart)
        XCTAssertEqual(record.requestedAt, env.clock.now)
        XCTAssertEqual(record.requestedDurationMinutes, 10)
        XCTAssertEqual(record.plannedEndsAt, session.plannedEndsAt)
        XCTAssertEqual(env.provider.activeRestriction, .onBreak(plan, .relaxAll))

        // A 10-minute break is stretched to Apple's 15-minute floor; plans.json keeps the true end.
        let activity = try XCTUnwrap(env.provider.scheduledBreakActivities.first)
        XCTAssertEqual(activity.intervalStart, iso("2026-10-06T10:00:00Z"))
        XCTAssertEqual(activity.intervalEnd, iso("2026-10-06T10:15:00Z"))
        XCTAssertEqual(env.plans.entry(forActivityNamed: activity.name)?.plannedEnd, iso("2026-10-06T10:10:00Z"))

        let event = try XCTUnwrap(env.outbox.pending().last)
        XCTAssertEqual(event.type, .breakStarted)
        XCTAssertEqual(event.metadata?.reason, BreakLedger.reasonOfflineStart)
        XCTAssertEqual(event.metadata?.clientBreakId, session.clientBreakId)
        XCTAssertNil(event.metadata?.breakSessionId, "no server id yet")
    }

    func testStartBreakTheServerRefusesStartsNothing() async throws {
        try await env.authoriseAndSelect()
        breakAPI.startHandler = { _, _, _, _ in throw APIError(code: .breakTooSoon, message: "Breaks can start at 10:00.", status: 409) }
        env.clock.now = iso("2026-10-06T10:00:00Z")
        let controller = makeController()
        controller.reconcile()

        do {
            _ = try await controller.startBreak()
            XCTFail("expected the server's refusal to be rethrown")
        } catch let error as APIError {
            XCTAssertEqual(error.code, .breakTooSoon)
        }
        XCTAssertNil(env.cache.load()?.activeBreakSession)
        XCTAssertEqual(env.cache.load()?.queuedBreaks.isEmpty, true)
        XCTAssertEqual(env.provider.activeRestriction, .work(plan))
        XCTAssertTrue(env.provider.scheduledBreakActivities.isEmpty)
        XCTAssertEqual(env.outbox.pending().map(\.type), [.workModeStarted])
        XCTAssertFalse(controller.isBreakRequestInFlight)
    }

    func testStartBreakRefusedByTheCachedPolicyNeverCallsTheServer() async throws {
        try await env.authoriseAndSelect()
        breakAPI.acceptBreaks()
        let controller = makeController()

        env.clock.now = iso("2026-10-06T08:30:00Z")
        do {
            _ = try await controller.startBreak()
            XCTFail("expected BREAK_TOO_SOON")
        } catch let refusal as BreakRefusal {
            XCTAssertEqual(refusal.code, .breakTooSoon)
            XCTAssertEqual(refusal.details, .tooSoon(reason: .minMinutesAfterShiftStart, eligibleAt: iso("2026-10-06T09:00:00Z"), waitMinutes: 30))
        }
        env.clock.now = iso("2026-10-06T07:50:00Z")
        do {
            _ = try await controller.startBreak()
            XCTFail("expected NOT_ON_SHIFT")
        } catch let refusal as BreakRefusal {
            XCTAssertEqual(refusal.code, .notOnShift)
            XCTAssertEqual(refusal.details.reasonCode, "SHIFT_NOT_STARTED")
        }
        XCTAssertTrue(breakAPI.startCalls.isEmpty)
        XCTAssertNil(env.cache.load()?.activeBreakSession)
    }

    func testEndBreakEarlyTellsTheServerRestoresWorkShieldsAndCancelsTheActivity() async throws {
        try await env.authoriseAndSelect()
        breakAPI.acceptBreaks()
        env.clock.now = iso("2026-10-06T10:00:00Z")
        let controller = makeController()
        controller.reconcile()
        let session = try await controller.startBreak()

        env.clock.now = iso("2026-10-06T10:05:00Z")
        try await controller.endBreakEarly()
        XCTAssertEqual(breakAPI.endCalls.count, 1)
        XCTAssertEqual(breakAPI.endCalls.first?.id, session.id)
        XCTAssertEqual(breakAPI.endCalls.first?.endedAt, iso("2026-10-06T10:05:00Z"))
        XCTAssertEqual(breakAPI.endCalls.first?.reason, .employeeEnded)
        let cached = try XCTUnwrap(env.cache.load())
        XCTAssertEqual(cached.activeBreakSession?.status, .ended)
        XCTAssertEqual(cached.activeBreakSession?.endedAt, iso("2026-10-06T10:05:00Z"))
        XCTAssertEqual(cached.activeBreakSession?.endReason, .employeeEnded)
        XCTAssertTrue(cached.queuedBreaks.isEmpty, "the server took the end: nothing to replay")
        XCTAssertEqual(env.provider.activeRestriction, .work(plan))
        XCTAssertTrue(env.provider.scheduledBreakActivities.isEmpty)
        XCTAssertNil(env.plans.entry(forActivityNamed: ActivityNaming.breakActivity(clientBreakId: session.clientBreakId)))
        XCTAssertEqual(env.outbox.pending().map(\.type), [.workModeStarted, .breakStarted, .breakEnded])
        XCTAssertEqual(env.outbox.pending().last?.metadata?.reason, BreakLedger.reasonEmployeeEnded)
        guard case .working = controller.state else { return XCTFail("expected working, got \(controller.state)") }

        do {
            try await controller.endBreakEarly()
            XCTFail("expected BREAK_NOT_ACTIVE")
        } catch let error as APIError {
            XCTAssertEqual(error.code, .breakNotActive)
        }
    }

    func testEndBreakEarlyOfflineQueuesTheEndForReplay() async throws {
        try await env.authoriseAndSelect()
        breakAPI.acceptBreaks()
        env.clock.now = iso("2026-10-06T10:00:00Z")
        let controller = makeController()
        controller.reconcile()
        let session = try await controller.startBreak()

        breakAPI.endHandler = { _, _, _ in throw APIError.network(URLError(.timedOut)) }
        env.clock.now = iso("2026-10-06T10:05:00Z")
        try await controller.endBreakEarly()
        let record = try XCTUnwrap(env.cache.load()?.queuedBreaks.first)
        XCTAssertEqual(record.status, .pendingEnd)
        XCTAssertEqual(record.serverBreakSessionId, session.id)
        XCTAssertEqual(record.endedAt, iso("2026-10-06T10:05:00Z"))
        XCTAssertEqual(record.endReason, .employeeEnded)
        XCTAssertEqual(env.provider.activeRestriction, .work(plan))
    }

    func testABreakWhoseTimeIsUpIsClosedByReconcileAndWorkShieldsReturn() async throws {
        try await env.authoriseAndSelect()
        breakAPI.acceptBreaks()
        env.clock.now = iso("2026-10-06T10:00:00Z")
        let controller = makeController()
        controller.reconcile()
        let session = try await controller.startBreak()

        env.clock.now = iso("2026-10-06T10:15:00Z")
        let outcome = controller.reconcile(reason: WorkModeController.reasonTimer)
        XCTAssertTrue(outcome.closedBreak)
        XCTAssertEqual(outcome.queuedEvents, [.breakExpired])
        XCTAssertEqual(outcome.decision?.action, .applyWork(plan))
        let cached = try XCTUnwrap(env.cache.load())
        XCTAssertEqual(cached.activeBreakSession?.status, .ended)
        XCTAssertEqual(cached.activeBreakSession?.endReason, .expired)
        XCTAssertEqual(cached.activeBreakSession?.endedAt, session.plannedEndsAt)
        XCTAssertTrue(cached.queuedBreaks.isEmpty, "expiries need no replay: the server sweeps them")
        XCTAssertEqual(env.provider.activeRestriction, .work(plan))
        XCTAssertTrue(env.provider.scheduledBreakActivities.isEmpty)
        XCTAssertTrue(breakAPI.endCalls.isEmpty, "an expiry is never POSTed")
        XCTAssertEqual(env.outbox.pending().last?.type, .breakExpired)
        XCTAssertEqual(env.outbox.pending().last?.occurredAt, session.plannedEndsAt)
        guard case .working = controller.state else { return XCTFail("expected working, got \(controller.state)") }
    }

    func testShiftEndAlwaysEndsAnActiveBreak() async throws {
        try await env.authoriseAndSelect()
        // Approved before the shift was shortened: the row still ends 16:05, the shift now ends 16:00.
        let session = BreakSession(id: "srv-late", clientBreakId: "c-late", shiftId: Fixtures.shift.id, startedAt: iso("2026-10-06T15:50:00Z"),
                                   plannedEndsAt: iso("2026-10-06T16:05:00Z"), restrictionBehaviour: .relaxAll)
        try env.cache.update { state in
            state.activeBreakSession = session
            state.lastSyncAt = iso("2026-10-06T15:45:00Z")
        }
        env.clock.now = iso("2026-10-06T15:52:00Z")
        let controller = makeController()
        controller.reconcile()
        XCTAssertEqual(env.provider.activeRestriction, .onBreak(plan, .relaxAll))
        XCTAssertEqual(controller.expectedState?.nextTransitionAt, Fixtures.shift.endsAt, "the break ends with its shift")

        env.clock.now = iso("2026-10-06T16:00:00Z")
        let outcome = controller.reconcile(reason: WorkModeController.reasonTimer)
        XCTAssertTrue(outcome.closedBreak)
        XCTAssertEqual(outcome.queuedEvents, [.breakEnded, .workModeEnded])
        let cached = try XCTUnwrap(env.cache.load())
        XCTAssertEqual(cached.activeBreakSession?.endReason, .shiftEnded)
        XCTAssertEqual(cached.activeBreakSession?.endedAt, Fixtures.shift.endsAt)
        XCTAssertEqual(cached.engineState?.state, .offShift)
        XCTAssertEqual(env.provider.activeRestriction, .none)
        XCTAssertTrue(env.provider.scheduledBreakActivities.isEmpty)
        XCTAssertEqual(controller.state, .offShift(nextShift: nil))
    }

    // MARK: Permission, selection, time changes and the shield

    func testLosingScreenTimeAccessReportsItOnceAndShowsActionRequired() async throws {
        try await env.authoriseAndSelect()
        let controller = makeController()
        controller.reconcile()
        XCTAssertEqual(env.provider.activeRestriction, .work(plan))

        env.provider.simulateRevocation() // iOS drops the shields itself when access is withdrawn
        controller.handleAuthorizationChange(.denied)
        XCTAssertEqual(env.outbox.pending().map(\.type), [.workModeStarted, .permissionNeedsAttention])
        let attention = try XCTUnwrap(env.outbox.pending().last)
        XCTAssertEqual(attention.metadata?.permissionState, .revoked)
        XCTAssertEqual(attention.metadata?.reason, "PERMISSION_REVOKED")
        XCTAssertEqual(env.cache.load()?.lastPermissionState, .revoked)
        XCTAssertEqual(controller.state, .actionRequired(.screenTimeNotAllowed(.revoked)))
        XCTAssertEqual(controller.expectedState?.state, .permissionError)
        XCTAssertNotNil(controller.settingsURL)

        // A repeated notification does not repeat the report.
        controller.handleAuthorizationChange(.denied)
        XCTAssertEqual(env.outbox.pending().count, 2)
    }

    func testReplanWritesPlansJsonAndRegistersVersionedShiftActivities() async throws {
        try await env.authoriseAndSelect()
        let controller = makeController()

        let file = try XCTUnwrap(try controller.replanActivities())
        let expectedName = ActivityNaming.shift(shiftId: Fixtures.shift.id, version: Fixtures.shift.version)
        XCTAssertEqual(file.activities.map(\.name), [expectedName])
        XCTAssertEqual(env.plans.read(), file, "plans.json is written before monitoring starts")
        XCTAssertEqual(env.provider.scheduledActivities.map(\.name), [expectedName])
        XCTAssertEqual(env.provider.cancelCount, 1, "the previous set is stopped before the new one is registered")
        let activity = try XCTUnwrap(env.provider.scheduledActivities.first)
        XCTAssertEqual(activity.startComponents.hour, 9, "08:00Z is 09:00 BST")
        XCTAssertEqual(activity.endComponents.hour, 17)
        XCTAssertEqual(activity.warningMinutes, Fixtures.policy.restrictionConfig.preShiftWarningMinutes)
        XCTAssertEqual(file.organisationName, Fixtures.organisation.name)
        XCTAssertEqual(file.entries[expectedName]?.plan, plan)

        // A significant time / time-zone change re-plans everything and reconciles the shields.
        controller.handleTimeChange()
        XCTAssertEqual(env.provider.cancelCount, 2)
        XCTAssertEqual(env.provider.scheduledActivities.map(\.name), [expectedName])
        XCTAssertEqual(env.provider.activeRestriction, .work(plan))
    }

    func testShieldOpenRequestIsConsumedOnForeground() async throws {
        try await env.authoriseAndSelect()
        let controller = makeController()
        flags.openStatusRequested = true

        controller.handleDidBecomeActive()
        XCTAssertTrue(controller.statusRequestedFromShield)
        XCTAssertFalse(flags.openStatusRequested, "consumed")
        XCTAssertEqual(env.provider.activeRestriction, .work(plan), "foreground reconciles the shields")
    }

    func testSelectionChangeDuringAShiftAppliesTheShields() async throws {
        env.provider.authorizationOutcome = .approve
        try await env.provider.requestAuthorization()
        let controller = makeController()
        controller.reconcile()
        XCTAssertEqual(controller.state, .actionRequired(.appsNotChosen))

        env.provider.simulateSelection(MockRestrictionProvider.defaultSelection)
        controller.reconcile(reason: WorkModeController.reasonSelectionChanged)
        XCTAssertEqual(env.provider.activeRestriction, .work(plan))
        guard case .working = controller.state else { return XCTFail("expected working, got \(controller.state)") }
    }
}
