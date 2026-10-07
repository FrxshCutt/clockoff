import XCTest
@testable import ClockOffApp
import ClockOffCore

/// A provider whose DeviceActivity registration can be made to fail (everything else forwards to the mock).
final class FailingSchedulingProvider: RestrictionProvider, SelectionCountsProviding {
    let base: MockRestrictionProvider
    var failScheduling = true
    private(set) var scheduleCalls = 0

    init(base: MockRestrictionProvider) {
        self.base = base
    }

    var authorizationStatus: RestrictionAuthorizationStatus { base.authorizationStatus }
    func requestAuthorization() async throws { try await base.requestAuthorization() }
    func hasSelection() -> Bool { base.hasSelection() }
    func applyWorkRestrictions(plan: RestrictionPlan) throws { try base.applyWorkRestrictions(plan: plan) }
    func applyBreakRestrictions(plan: RestrictionPlan, behaviour: BreakBehaviour) throws { try base.applyBreakRestrictions(plan: plan, behaviour: behaviour) }
    func clearRestrictions() throws { try base.clearRestrictions() }
    func scheduleActivities(_ plans: [ActivityPlan]) throws {
        scheduleCalls += 1
        if failScheduling { throw RestrictionProviderError.schedulingFailed("simulated") }
        try base.scheduleActivities(plans)
    }
    func cancelAllActivities() { base.cancelAllActivities() }
    func currentEngineState() -> RestrictionEngineState { base.currentEngineState() }
    func selectionCounts() -> SelectionCounts { base.selectionCounts() }
}

/// `SyncCoordinator` against a stubbed API, temporary App Group storage and the mock restriction provider.
final class SyncCoordinatorTests: XCTestCase {
    private var env: TestEnvironment!

    override func setUpWithError() throws {
        env = try TestEnvironment(testCase: self, now: iso("2026-10-06T09:00:00Z"))
        try env.join()
        env.api.syncHandler = { Fixtures.bundle() }
        env.api.meHandler = { Fixtures.me }
    }

    private var shiftActivityName: String { ActivityNaming.shift(shiftId: Fixtures.shift.id, version: Fixtures.shift.version) }
    private var plan: RestrictionPlan { RestrictionPlan.make(shiftId: Fixtures.shift.id, policy: Fixtures.policy, breakPolicy: Fixtures.breakPolicy) }

    /// A break the phone started at 10:00 while offline, as `WorkModeController` records it.
    private func queueOfflineBreak(clientBreakId: String = "c-offline", requestedAt: Date = iso("2026-10-06T10:00:00Z"), endedAt: Date? = nil) throws {
        let plannedEnd = requestedAt.addingTimeInterval(15 * 60)
        try env.cache.update { state in
            state.activeBreakSession = BreakSession(id: clientBreakId, clientBreakId: clientBreakId, shiftId: Fixtures.shift.id, startedAt: requestedAt,
                                                    plannedEndsAt: plannedEnd, endedAt: endedAt, status: endedAt == nil ? .active : .ended,
                                                    endReason: endedAt == nil ? nil : .employeeEnded, restrictionBehaviour: .relaxAll)
            state.queuedBreaks = [QueuedBreakRecord(clientBreakId: clientBreakId, shiftId: Fixtures.shift.id, requestedAt: requestedAt,
                                                    requestedDurationMinutes: 15, plannedEndsAt: plannedEnd, endedAt: endedAt,
                                                    endReason: endedAt == nil ? nil : .employeeEnded, createdAt: requestedAt)]
        }
    }

    // MARK: Versions, plans, shields, events

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
        XCTAssertEqual(env.syncMetadata.lastServerContactAt, env.clock.now)
    }

    func testUnchangedVersionsDoNotRescheduleOrReEmit() async throws {
        try await env.authoriseAndSelect()
        _ = await env.syncCoordinator.sync(reason: .foreground)
        let cancelsAfterFirst = env.provider.cancelCount
        let eventsAfterFirst = env.api.postedEvents.count
        let appliedAfterFirst = env.provider.appliedWorkPlans.count

        env.clock.now = iso("2026-10-06T09:10:00Z")
        let second = await env.syncCoordinator.sync(reason: .pullToRefresh)
        XCTAssertFalse(second.policyChanged)
        XCTAssertFalse(second.scheduleChanged)
        XCTAssertFalse(second.activitiesRescheduled)
        XCTAssertEqual(second.restrictionAction, .leaveUnchanged, "shields already up: nothing re-applied")
        XCTAssertEqual(env.provider.appliedWorkPlans.count, appliedAfterFirst)
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
        XCTAssertEqual(env.provider.scheduledActivities.map(\.name), [shiftActivityName, ActivityNaming.shift(shiftId: tomorrow.id, version: tomorrow.version)])
        XCTAssertEqual(env.api.postedEvents.filter { $0.type == .scheduleSynced }.count, 2)
        XCTAssertEqual(env.api.postedEvents.filter { $0.type == .policySynced }.count, 1)
        XCTAssertEqual(env.api.postedEvents.last(where: { $0.type == .scheduleSynced })?.metadata?.scheduleVersion, 2)
    }

    func testPlansFileIsWrittenBeforeSchedulingAndAFailedRegistrationIsRetried() async throws {
        try await env.authoriseAndSelect()
        let failing = FailingSchedulingProvider(base: env.provider)
        let coordinator = env.makeSyncCoordinator(provider: failing)

        let first = await coordinator.sync(reason: .foreground)
        XCTAssertFalse(first.activitiesRescheduled)
        XCTAssertEqual(failing.scheduleCalls, 1)
        XCTAssertNotNil(env.plans.read()?.entries[shiftActivityName], "plans.json is written before monitoring starts, even when registration fails")
        XCTAssertTrue(env.syncMetadata.activitiesNeedReschedule)
        XCTAssertTrue(env.provider.scheduledActivities.isEmpty)
        XCTAssertEqual(env.provider.activeRestriction, .work(plan), "the shields are still applied")

        failing.failScheduling = false
        env.clock.now = iso("2026-10-06T09:10:00Z")
        let second = await coordinator.sync(reason: .pullToRefresh)
        XCTAssertTrue(second.activitiesRescheduled, "the plan is unchanged but the registration is retried")
        XCTAssertEqual(env.provider.scheduledActivities.map(\.name), [shiftActivityName])
        XCTAssertFalse(env.syncMetadata.activitiesNeedReschedule)
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

    // MARK: Offline breaks

    func testOfflineBreakIsReplayedBeforeTheSyncWithItsOriginalIds() async throws {
        try await env.authoriseAndSelect()
        _ = await env.syncCoordinator.sync(reason: .foreground)
        let requestedAt = iso("2026-10-06T10:00:00Z")
        try queueOfflineBreak(requestedAt: requestedAt)
        env.api.acceptBreaks()
        // The real server includes the break it just recorded in the bundle.
        env.api.syncHandler = { [api = env.api] in
            let session = api.startBreakRequests.first.map { request in
                BreakSession(id: "server-\(request.clientBreakId)", clientBreakId: request.clientBreakId, shiftId: request.shiftId, startedAt: request.requestedAt,
                             plannedEndsAt: request.requestedAt.addingTimeInterval(15 * 60), restrictionBehaviour: .relaxAll)
            }
            return Fixtures.bundle(activeBreakSession: session)
        }
        env.clock.now = iso("2026-10-06T10:05:00Z")

        let outcome = await env.syncCoordinator.sync(reason: .connectivity)
        XCTAssertEqual(outcome.breakReplay.replayed, 1)
        XCTAssertTrue(outcome.breakReplay.dropped.isEmpty)
        let request = try XCTUnwrap(env.api.startBreakRequests.first)
        XCTAssertEqual(request.clientBreakId, "c-offline")
        XCTAssertEqual(request.requestedAt, requestedAt, "the original tap time, never the replay time")
        XCTAssertEqual(request.requestedDurationMinutes, 15)
        let startIndex = try XCTUnwrap(env.api.calls.firstIndex(of: "startBreak"))
        let syncIndex = try XCTUnwrap(env.api.calls.lastIndex(of: "sync"))
        XCTAssertLessThan(startIndex, syncIndex, "the replay runs before GET /sync")
        let cached = try XCTUnwrap(env.cache.load())
        XCTAssertTrue(cached.queuedBreaks.isEmpty)
        XCTAssertEqual(cached.activeBreakSession?.id, "server-c-offline")
        XCTAssertEqual(outcome.expectedState.state, .onBreak)
        XCTAssertEqual(env.provider.activeRestriction, .onBreak(plan, .relaxAll))
    }

    func testSyncKeepsALocalBreakTheServerDoesNotKnowYet() async throws {
        try await env.authoriseAndSelect()
        _ = await env.syncCoordinator.sync(reason: .foreground)
        try queueOfflineBreak()
        env.api.startBreakHandler = { _ in throw APIError.network(URLError(.notConnectedToInternet)) }
        env.clock.now = iso("2026-10-06T10:05:00Z")

        let outcome = await env.syncCoordinator.sync(reason: .foreground)
        XCTAssertEqual(outcome.breakReplay.error?.code, .networkError)
        let cached = try XCTUnwrap(env.cache.load())
        XCTAssertEqual(cached.queuedBreaks.count, 1, "the record waits for the next sync")
        XCTAssertEqual(cached.activeBreakSession?.id, "c-offline", "the bundle's empty active break does not clobber the local one")
        XCTAssertEqual(outcome.expectedState.state, .onBreak)
    }

    func testRefusedOfflineBreakIsDroppedAndEndedLocally() async throws {
        try await env.authoriseAndSelect()
        _ = await env.syncCoordinator.sync(reason: .foreground)
        try queueOfflineBreak()
        env.api.startBreakHandler = { _ in throw APIError(code: .breakLimitReached, message: "No breaks left.", status: 409) }
        env.clock.now = iso("2026-10-06T10:05:00Z")

        let outcome = await env.syncCoordinator.sync(reason: .connectivity)
        XCTAssertEqual(outcome.breakReplay.dropped.map(\.code), [.breakLimitReached])
        XCTAssertTrue(outcome.breakReplay.endedActiveBreak)
        let cached = try XCTUnwrap(env.cache.load())
        XCTAssertTrue(cached.queuedBreaks.isEmpty)
        XCTAssertNil(cached.activeBreakSession, "the server never recorded it, so the bundle's view (no break) wins once nothing is queued")
        XCTAssertEqual(outcome.expectedState.state, .working, "the relaxation is withdrawn")
        XCTAssertEqual(env.provider.activeRestriction, .work(plan))
        let ended = try XCTUnwrap(env.api.postedEvents.last { $0.type == .breakEnded })
        XCTAssertEqual(ended.metadata?.reason, BreakReplayer.reasonServerRefused)
        XCTAssertEqual(ended.metadata?.clientBreakId, "c-offline")
        XCTAssertNil(ended.metadata?.breakSessionId, "the server never had this break")
    }

    func testOfflineBreakEndedBeforeReconnectingIsStartedThenEndedOnTheServer() async throws {
        try await env.authoriseAndSelect()
        _ = await env.syncCoordinator.sync(reason: .foreground)
        try queueOfflineBreak(endedAt: iso("2026-10-06T10:05:00Z"))
        env.api.acceptBreaks()
        env.clock.now = iso("2026-10-06T10:30:00Z")

        let outcome = await env.syncCoordinator.sync(reason: .connectivity)
        XCTAssertEqual(outcome.breakReplay.replayed, 1)
        XCTAssertEqual(env.api.startBreakRequests.map(\.clientBreakId), ["c-offline"])
        let end = try XCTUnwrap(env.api.endBreakRequests.first)
        XCTAssertEqual(end.id, "server-c-offline")
        XCTAssertEqual(end.request.endedAt, iso("2026-10-06T10:05:00Z"))
        XCTAssertEqual(end.request.reason, .employeeEnded)
        XCTAssertTrue(env.cache.load()?.queuedBreaks.isEmpty ?? false)
    }

    // MARK: Notifications

    func testSyncPlansShiftNotificationsAndNotifiesScheduleChangesOnce() async throws {
        try await env.authoriseAndSelect()
        env.clock.now = iso("2026-10-06T07:00:00Z")
        let first = await env.syncCoordinator.sync(reason: .launch)
        XCTAssertEqual(first.notificationsPlanned, 3)
        XCTAssertEqual(env.notifications.lastPlanned.map(\.id), [
            NotificationPlanner.shiftWarning(shiftId: Fixtures.shift.id),
            NotificationPlanner.shiftStart(shiftId: Fixtures.shift.id),
            NotificationPlanner.shiftEnd(shiftId: Fixtures.shift.id),
        ])
        XCTAssertEqual(env.notifications.lastPlanned.map(\.fireAt), [iso("2026-10-06T07:45:00Z"), iso("2026-10-06T08:00:00Z"), iso("2026-10-06T16:00:00Z")])
        XCTAssertTrue(env.notifications.posted.isEmpty, "the first schedule is not a change")

        env.api.syncHandler = { Fixtures.bundle(scheduleVersion: 2) }
        _ = await env.syncCoordinator.sync(reason: .silentPush)
        XCTAssertEqual(env.notifications.posted.map(\.id), [NotificationPlanner.scheduleChangedIdentifier])
        _ = await env.syncCoordinator.sync(reason: .silentPush)
        XCTAssertEqual(env.notifications.posted.count, 1, "the same version is never announced twice")
    }

    // MARK: Outbox

    func testOutboxFlushesInBatchesOfAtMost200AndNeverResendsDeliveredEvents() async throws {
        try await env.authoriseAndSelect()
        var events = (0..<250).map { index in
            DeviceEvent(type: .scheduleSynced, occurredAt: env.clock.now, metadata: DeviceEventMetadata(scheduleVersion: index))
        }
        events.append(events[0])
        XCTAssertEqual(try env.outbox.append(contentsOf: events), 250, "a duplicate clientEventId is ignored")

        _ = await env.syncCoordinator.sync(reason: .foreground)
        // 250 queued + POLICY_SYNCED, SCHEDULE_SYNCED, WORK_MODE_STARTED from this sync.
        XCTAssertEqual(env.api.postedBatches.map(\.count), [200, 53])
        XCTAssertEqual(Set(env.api.postedEvents.map(\.clientEventId)).count, 253)
        XCTAssertTrue(env.outbox.pending().isEmpty)
    }

    func testTransientFlushFailureKeepsEventsAndDeliversThemOnceLater() async throws {
        try await env.authoriseAndSelect()
        env.api.eventsHandler = { _ in throw APIError.network(URLError(.timedOut)) }
        _ = await env.syncCoordinator.sync(reason: .foreground)
        XCTAssertEqual(env.outbox.pending().count, 3)
        XCTAssertTrue(env.api.postedEvents.isEmpty)

        env.api.eventsHandler = { events in DeviceEventsResponse(accepted: events.count, duplicates: 0) }
        env.clock.now = iso("2026-10-06T09:10:00Z")
        _ = await env.syncCoordinator.sync(reason: .foreground)
        XCTAssertEqual(env.api.postedEvents.map(\.type), [.policySynced, .scheduleSynced, .workModeStarted])
        XCTAssertTrue(env.outbox.pending().isEmpty)
    }
}
