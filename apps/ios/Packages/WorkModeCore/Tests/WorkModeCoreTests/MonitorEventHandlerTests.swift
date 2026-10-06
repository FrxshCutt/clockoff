import XCTest
@testable import WorkModeCore

/// The DeviceActivityMonitor extension's logic against in-memory shield stores and temporary App Group files.
final class MonitorEventHandlerTests: XCTestCase {
    private let london = TimeZone(identifier: "Europe/London")!
    private var fileStore: AppGroupFileStore!
    private var cache: StateCache!
    private var plans: PlansStore!
    private var outbox: EventOutbox!
    private var stores: InMemoryShieldStores!
    private var flags: SharedFlags!
    private var selections: SelectionStore!
    private var now = iso("2026-10-06T08:00:00Z")

    private let shift = Fixture.shift("s1", "2026-10-06T08:00:00Z", "2026-10-06T16:00:00Z")
    private var shiftActivity: String { ActivityNaming.shift(shiftId: "s1", version: 1) }

    override func setUpWithError() throws {
        fileStore = try AppGroupFileStore(directory: try makeTemporaryDirectory(self))
        cache = StateCache(fileStore: fileStore)
        plans = PlansStore(fileStore: fileStore)
        outbox = EventOutbox(cache: cache)
        stores = InMemoryShieldStores()
        flags = SharedFlags(store: InMemoryKeyValueStore())
        selections = SelectionStore(fileStore: fileStore)
        try selections.save(Data("work".utf8), summary: SelectionSummary(categoryCount: 1, applicationCount: 2, webDomainCount: 0), kind: .work)
        try seed(activeBreak: nil)
        try writePlans()
    }

    private func seed(activeBreak: BreakSession?, breakPolicy: BreakPolicy? = nil, engineState: WorkModeState? = .offShift) throws {
        try cache.save(CachedState(
            organisation: Organisation(id: "o", name: "Harpenden Coffee Co.", timezone: "Europe/London"),
            employee: Employee(id: "e", firstName: "Sam", lastName: "Patel"),
            policy: try Fixture.policy(),
            breakPolicy: breakPolicy,
            shifts: [shift],
            activeBreakSession: activeBreak,
            engineState: engineState.map { RestrictionEngineState(state: $0, source: .appEngine, updatedAt: iso("2026-10-06T07:00:00Z")) },
            lastPermissionState: .approved
        ))
    }

    private func writePlans(activeBreak: BreakSession? = nil) throws {
        let entries = ActivityPlanner().plan(now: iso("2026-10-06T07:00:00Z"), shifts: [shift], activeBreak: activeBreak, policy: try Fixture.policy(),
                                             breakPolicy: nil, timeZone: london, options: WorkModeEngineOptions())
        try plans.write(PlansFile(generatedAt: now, organisationName: "Harpenden Coffee Co.", entries: entries))
    }

    private func handler(permissionApproved: Bool = true) -> MonitorEventHandler {
        MonitorEventHandler(
            cache: cache,
            plans: plans,
            applier: ShieldApplier(stores: stores, selections: selections, flags: flags),
            flags: flags,
            timeZone: london,
            permissionApproved: { permissionApproved },
            now: { [unowned self] in self.now }
        )
    }

    private func relaxAllBreak(start: String, end: String) -> BreakSession {
        BreakSession(id: "b-server", clientBreakId: "c-1", shiftId: "s1", startedAt: iso(start), plannedEndsAt: iso(end), restrictionBehaviour: .relaxAll)
    }

    // MARK: Warnings

    func testWarningFlagsStartingSoonWithoutDowngradingARunningWorkMode() throws {
        now = iso("2026-10-06T07:45:00Z")
        let outcome = handler().intervalWillStartWarning(activityName: shiftActivity)
        XCTAssertEqual(outcome.engineState, .shiftStartingSoon)
        XCTAssertEqual(flags.shiftStartingSoon?.shiftId, "s1")
        XCTAssertEqual(cache.load()?.engineState?.state, .shiftStartingSoon)
        XCTAssertEqual(cache.load()?.engineState?.source, .monitorExtension)
        XCTAssertTrue(outbox.pending().isEmpty)
        XCTAssertFalse(stores.work.isShielding, "nothing is enforced yet")

        try seed(activeBreak: nil, engineState: .working)
        XCTAssertNil(handler().intervalWillStartWarning(activityName: shiftActivity).engineState, "an adjacent interval keeps WORKING")
        XCTAssertEqual(handler().intervalWillStartWarning(activityName: "shift-unknown-v9").note, "ignored: not a planned shift activity")
    }

    // MARK: Shift start

    func testShiftStartAppliesWorkShieldsRecordsWorkingAndQueuesWorkModeStarted() throws {
        flags.shiftStartingSoon = SharedFlags.ShiftStartingSoon(activityName: shiftActivity, shiftId: "s1", at: now)
        let outcome = handler().intervalDidStart(activityName: shiftActivity)
        XCTAssertEqual(outcome.applied, .work)
        XCTAssertEqual(outcome.engineState, .working)
        XCTAssertEqual(outcome.queuedEvents, [.workModeStarted])
        XCTAssertTrue(stores.work.isShielding)
        XCTAssertFalse(stores.breakRelaxed.isShielding)
        XCTAssertNil(flags.shiftStartingSoon)
        let cached = try XCTUnwrap(cache.load())
        XCTAssertEqual(cached.engineState?.state, .working)
        XCTAssertEqual(cached.engineState?.source, .monitorExtension)
        let event = try XCTUnwrap(outbox.pending().first)
        XCTAssertEqual(event.type, .workModeStarted)
        XCTAssertEqual(event.metadata?.shiftId, "s1")
        XCTAssertEqual(event.metadata?.reason, MonitorEventHandler.reasonIntervalStarted)
        XCTAssertEqual(flags.lastMonitorCallback?.kind, "intervalDidStart")
        // Firing again (already WORKING) re-applies idempotently and emits nothing new.
        XCTAssertEqual(handler().intervalDidStart(activityName: shiftActivity).queuedEvents, [])
        XCTAssertEqual(outbox.pending().count, 1)
    }

    func testStaleAndForeignActivitiesAreIgnored() {
        XCTAssertEqual(handler().intervalDidStart(activityName: "shift-s1-v7").note, "ignored: stale activity (no plan entry)")
        XCTAssertEqual(handler().intervalDidStart(activityName: "something-else").note, "ignored: not ours")
        XCTAssertEqual(handler().intervalDidEnd(activityName: "shift-s1-v7").note, "ignored: stale activity (no plan entry)")
        XCTAssertFalse(stores.work.isShielding)
        XCTAssertTrue(outbox.pending().isEmpty)
    }

    func testShiftStartWithoutASelectionRecordsPermissionErrorAndFlagsIt() throws {
        try selections.removeAll()
        let outcome = handler().intervalDidStart(activityName: shiftActivity)
        XCTAssertNil(outcome.applied)
        XCTAssertEqual(outcome.engineState, .permissionError)
        XCTAssertTrue(flags.selectionIncomplete)
        XCTAssertFalse(stores.work.isShielding, "never claims enforcement it could not apply")
        XCTAssertTrue(outbox.pending().isEmpty, "PERMISSION_ERROR says nothing about the shift: no WORK_MODE_STARTED")
    }

    func testShiftStartWithoutPermissionClearsAndRecordsPermissionError() throws {
        try stores.work.applyShields(selectionPayload: Data("stale".utf8))
        let outcome = handler(permissionApproved: false).intervalDidStart(activityName: shiftActivity)
        XCTAssertEqual(outcome.applied, .cleared)
        XCTAssertEqual(outcome.engineState, .permissionError)
        XCTAssertFalse(stores.work.isShielding)
    }

    func testShiftStartWhileABreakIsRunningAppliesTheBreakBehaviour() throws {
        now = iso("2026-10-06T08:00:00Z")
        try seed(activeBreak: relaxAllBreak(start: "2026-10-06T07:58:00Z", end: "2026-10-06T08:10:00Z"))
        let outcome = handler().intervalDidStart(activityName: shiftActivity)
        XCTAssertEqual(outcome.applied, .breakRelaxedAll)
        XCTAssertEqual(outcome.engineState, .onBreak)
        XCTAssertEqual(outcome.queuedEvents, [.workModeStarted])
        XCTAssertFalse(stores.work.isShielding)
    }

    func testShiftStartUnderALiftingOverrideKeepsShieldsDown() throws {
        var state = try XCTUnwrap(cache.load())
        state.activeOverrides = [ActiveOverride(id: "ov", type: .emergencyPolicyOverride, startsAt: iso("2026-10-06T07:00:00Z"), expiresAt: iso("2026-10-06T10:00:00Z"))]
        try cache.save(state)
        let outcome = handler().intervalDidStart(activityName: shiftActivity)
        XCTAssertEqual(outcome.applied, .cleared)
        XCTAssertEqual(outcome.engineState, .managerOverride)
        XCTAssertTrue(outbox.pending().isEmpty)
    }

    // MARK: Shift end

    func testShiftEndClearsBothStoresEndsTheBreakAndQueuesEvents() throws {
        now = iso("2026-10-06T10:00:00Z")
        try seed(activeBreak: relaxAllBreak(start: "2026-10-06T09:50:00Z", end: "2026-10-06T10:05:00Z"), engineState: .onBreak)
        try writePlans(activeBreak: relaxAllBreak(start: "2026-10-06T09:50:00Z", end: "2026-10-06T10:05:00Z"))
        try stores.work.applyShields(selectionPayload: Data("work".utf8))
        // The shift was shortened to end now (the plan entry says 16:00 but the cached schedule rules).
        var state = try XCTUnwrap(cache.load())
        state.shifts = [Fixture.shift("s1", "2026-10-06T08:00:00Z", "2026-10-06T10:00:00Z")]
        try cache.save(state)

        let outcome = handler().intervalDidEnd(activityName: shiftActivity)
        XCTAssertEqual(outcome.applied, .cleared)
        XCTAssertEqual(outcome.engineState, .offShift)
        XCTAssertEqual(outcome.queuedEvents, [.breakEnded, .workModeEnded])
        XCTAssertFalse(stores.work.isShielding)
        XCTAssertFalse(stores.breakRelaxed.isShielding)
        let cached = try XCTUnwrap(cache.load())
        XCTAssertEqual(cached.activeBreakSession?.status, .ended)
        XCTAssertEqual(cached.activeBreakSession?.endReason, .shiftEnded)
        XCTAssertEqual(cached.activeBreakSession?.endedAt, iso("2026-10-06T10:00:00Z"))
        XCTAssertEqual(cached.engineState?.state, .offShift)
        let events = outbox.pending()
        XCTAssertEqual(events.map(\.type), [.breakEnded, .workModeEnded])
        XCTAssertEqual(events[0].metadata?.breakSessionId, "b-server")
        XCTAssertEqual(events[0].metadata?.reason, MonitorEventHandler.reasonShiftEnded)
        XCTAssertEqual(events[1].metadata?.reason, MonitorEventHandler.reasonIntervalEnded)
        XCTAssertTrue(plans.read()?.breakEntries.isEmpty ?? true, "the break activity entry is gone")
    }

    func testShiftEndKeepsEnforcingWhenANewerIntervalCoversNow() throws {
        now = iso("2026-10-06T16:00:00Z")
        var state = try XCTUnwrap(cache.load())
        state.shifts = [shift, Fixture.shift("s2", "2026-10-06T16:00:00Z", "2026-10-06T20:00:00Z")]
        state.engineState = RestrictionEngineState(state: .working, source: .monitorExtension, updatedAt: iso("2026-10-06T08:00:00Z"))
        try cache.save(state)
        let outcome = handler().intervalDidEnd(activityName: shiftActivity)
        XCTAssertEqual(outcome.applied, .work)
        XCTAssertEqual(outcome.engineState, .working)
        XCTAssertEqual(outcome.queuedEvents, [], "Work Mode never stopped")
        XCTAssertTrue(stores.work.isShielding)
    }

    func testShiftEndWithStaleWorkingStateQueuesWorkModeEnded() throws {
        now = iso("2026-10-06T16:00:00Z")
        try seed(activeBreak: nil, engineState: .working)
        try stores.work.applyShields(selectionPayload: Data("work".utf8))
        let outcome = handler().intervalDidEnd(activityName: shiftActivity)
        XCTAssertEqual(outcome.engineState, .offShift)
        XCTAssertEqual(outcome.queuedEvents, [.workModeEnded])
        XCTAssertFalse(stores.work.isShielding)
    }

    // MARK: Breaks

    func testBreakIntervalStartIsANoOp() throws {
        now = iso("2026-10-06T11:00:00Z")
        let session = relaxAllBreak(start: "2026-10-06T11:00:00Z", end: "2026-10-06T11:10:00Z")
        try seed(activeBreak: session, engineState: .onBreak)
        try writePlans(activeBreak: session)
        let outcome = handler().intervalDidStart(activityName: ActivityNaming.breakActivity(clientBreakId: "c-1"))
        XCTAssertEqual(outcome.note, "break interval started: no-op")
        XCTAssertNil(outcome.applied)
    }

    func testBreakIntervalEndRestoresWorkShieldsMarksExpiredAndQueuesBreakExpired() throws {
        let session = relaxAllBreak(start: "2026-10-06T11:00:00Z", end: "2026-10-06T11:10:00Z")
        try seed(activeBreak: session, engineState: .onBreak)
        try writePlans(activeBreak: session)
        let breakActivity = ActivityNaming.breakActivity(clientBreakId: "c-1")
        XCTAssertNotNil(plans.entry(forActivityNamed: breakActivity))

        // The 15-minute floor fires at 11:15, after the 11:10 planned end.
        now = iso("2026-10-06T11:15:00Z")
        let outcome = handler().intervalDidEnd(activityName: breakActivity)
        XCTAssertEqual(outcome.applied, .work)
        XCTAssertEqual(outcome.engineState, .working)
        XCTAssertEqual(outcome.queuedEvents, [.breakExpired])
        XCTAssertTrue(stores.work.isShielding)
        let cached = try XCTUnwrap(cache.load())
        XCTAssertEqual(cached.activeBreakSession?.status, .ended)
        XCTAssertEqual(cached.activeBreakSession?.endedAt, iso("2026-10-06T11:10:00Z"), "ended at the planned end, not when the activity fired")
        XCTAssertEqual(cached.activeBreakSession?.endReason, .expired)
        XCTAssertEqual(cached.engineState?.state, .working)
        let event = try XCTUnwrap(outbox.pending().first)
        XCTAssertEqual(event.type, .breakExpired)
        XCTAssertEqual(event.occurredAt, iso("2026-10-06T11:10:00Z"))
        XCTAssertEqual(event.metadata?.breakSessionId, "b-server")
        XCTAssertNil(plans.entry(forActivityNamed: breakActivity))
        XCTAssertEqual(handler().intervalDidEnd(activityName: breakActivity).note, "break already ended: no-op")
    }

    func testBreakIntervalEndBeforeThePlannedEndIsIgnored() throws {
        let session = relaxAllBreak(start: "2026-10-06T11:00:00Z", end: "2026-10-06T11:30:00Z")
        try seed(activeBreak: session, engineState: .onBreak)
        try writePlans(activeBreak: session)
        now = iso("2026-10-06T11:15:00Z")
        let outcome = handler().intervalDidEnd(activityName: ActivityNaming.breakActivity(clientBreakId: "c-1"))
        XCTAssertEqual(outcome.note, "break interval ended before plannedEndsAt: ignored")
        XCTAssertEqual(cache.load()?.activeBreakSession?.status, .active)
    }

    func testBreakEndAfterShiftEndClearsShields() throws {
        let session = relaxAllBreak(start: "2026-10-06T15:50:00Z", end: "2026-10-06T16:05:00Z")
        try seed(activeBreak: session, engineState: .onBreak)
        try writePlans(activeBreak: session)
        now = iso("2026-10-06T16:05:00Z")
        let outcome = handler().intervalDidEnd(activityName: ActivityNaming.breakActivity(clientBreakId: "c-1"))
        XCTAssertEqual(outcome.applied, .cleared)
        XCTAssertEqual(outcome.engineState, .offShift)
        XCTAssertEqual(outcome.queuedEvents, [.breakExpired, .workModeEnded])
    }

    func testLocalBreakExpiryUpdatesTheQueuedRecord() throws {
        let local = BreakSession(id: "c-local", clientBreakId: "c-local", shiftId: "s1", startedAt: iso("2026-10-06T11:00:00Z"), plannedEndsAt: iso("2026-10-06T11:10:00Z"))
        try seed(activeBreak: local, engineState: .onBreak)
        try cache.update { state in
            state.queuedBreaks = [QueuedBreakRecord(clientBreakId: "c-local", shiftId: "s1", requestedAt: local.startedAt, requestedDurationMinutes: nil,
                                                    plannedEndsAt: local.plannedEndsAt, createdAt: local.startedAt)]
        }
        try writePlans(activeBreak: local)
        now = iso("2026-10-06T11:15:00Z")
        _ = handler().intervalDidEnd(activityName: ActivityNaming.breakActivity(clientBreakId: "c-local"))
        let record = try XCTUnwrap(cache.load()?.queuedBreaks.first)
        XCTAssertEqual(record.endedAt, iso("2026-10-06T11:10:00Z"))
        XCTAssertEqual(record.endReason, .expired)
        XCTAssertEqual(record.status, .pendingStart)
        XCTAssertEqual(outbox.pending().first?.metadata?.clientBreakId, "c-local")
        XCTAssertNil(outbox.pending().first?.metadata?.breakSessionId)
    }
}
