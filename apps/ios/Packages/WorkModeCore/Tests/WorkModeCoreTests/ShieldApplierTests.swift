import XCTest
@testable import WorkModeCore

/// `ShieldApplier` over in-memory stores, the App Group `SelectionStore`, activity naming, break schedules,
/// the shield copy and the break ledger — everything the extensions rely on, run in the simulator.
final class ShieldApplierTests: XCTestCase {
    private var fileStore: AppGroupFileStore!
    private var selections: SelectionStore!
    private var stores: InMemoryShieldStores!
    private var flags: SharedFlags!

    private let workPayload = Data("work-selection".utf8)
    private let keptPayload = Data("kept-selection".utf8)

    override func setUpWithError() throws {
        fileStore = try AppGroupFileStore(directory: try makeTemporaryDirectory(self))
        selections = SelectionStore(fileStore: fileStore)
        stores = InMemoryShieldStores()
        flags = SharedFlags(store: InMemoryKeyValueStore())
    }

    private var applier: ShieldApplier { ShieldApplier(stores: stores, selections: selections, flags: flags) }

    private func saveWork() throws {
        try selections.save(workPayload, summary: SelectionSummary(categoryCount: 2, applicationCount: 3, webDomainCount: 1), kind: .work)
    }

    // MARK: SelectionStore

    func testSelectionStorePersistsCountsOnlyForReporting() throws {
        XCTAssertFalse(selections.hasSelection(.work))
        XCTAssertEqual(selections.summary(.work), .empty)
        try saveWork()
        XCTAssertTrue(selections.hasSelection(.work))
        XCTAssertEqual(selections.summary(.work).counts, SelectionCounts(categories: 2, applications: 3, webDomains: 1))
        XCTAssertEqual(selections.payload(.work), workPayload)
        XCTAssertEqual(selections.load(.work)?.format, SelectionStore.familyActivitySelectionFormat)
        // An empty selection is not a selection.
        try selections.save(Data(), summary: .empty, kind: .breakKept)
        XCTAssertFalse(selections.hasSelection(.breakKept))
        XCTAssertNil(selections.payload(.breakKept))
        try selections.removeAll()
        XCTAssertFalse(selections.hasSelection(.work))
        XCTAssertNil(try fileStore.read(SelectionKind.work.fileName))
    }

    // MARK: ShieldApplier

    func testApplyWorkRequiresASelectionAndClearsTheBreakStore() throws {
        XCTAssertThrowsError(try applier.applyWork()) { XCTAssertEqual($0 as? RestrictionProviderError, .noSelection) }
        XCTAssertFalse(applier.snapshot().anyShielding, "never claims shields that were not applied")
        try saveWork()
        try stores.breakRelaxed.applyShields(selectionPayload: keptPayload)
        XCTAssertEqual(try applier.applyWork(), .work)
        XCTAssertEqual(stores.work.appliedPayload, workPayload)
        XCTAssertFalse(stores.breakRelaxed.isShielding)
        XCTAssertEqual(applier.snapshot(), ShieldSnapshot(workShielding: true, breakShielding: false))
        XCTAssertEqual(try applier.applyWork(), .work, "idempotent")
    }

    func testRelaxAllLiftsEverything() throws {
        try saveWork()
        try applier.applyWork()
        XCTAssertEqual(try applier.applyBreak(.relaxAll), .breakRelaxedAll)
        XCTAssertFalse(applier.snapshot().anyShielding)
    }

    func testRelaxCategoriesUsesTheBreakKeptSelectionOrFallsBackToKeepRestrictions() throws {
        try saveWork()
        try applier.applyWork()
        // No breakKept selection: shields stay up and the UI is told the selection is incomplete.
        XCTAssertEqual(try applier.applyBreak(.relaxCategories(kept: [.games])), .breakKeptRestrictions(fallback: true))
        XCTAssertTrue(flags.selectionIncomplete)
        XCTAssertEqual(applier.snapshot(), ShieldSnapshot(workShielding: true, breakShielding: false))
        // With it: the kept subset goes on the break store and the work store is cleared.
        try selections.save(keptPayload, summary: SelectionSummary(categoryCount: 1, applicationCount: 0, webDomainCount: 0), kind: .breakKept)
        XCTAssertEqual(try applier.applyBreak(.relaxCategories(kept: [.games])), .breakRelaxedCategories)
        XCTAssertFalse(flags.selectionIncomplete)
        XCTAssertEqual(stores.breakRelaxed.appliedPayload, keptPayload)
        XCTAssertEqual(applier.snapshot(), ShieldSnapshot(workShielding: false, breakShielding: true))
        // Back to work: the work set replaces the kept subset.
        XCTAssertEqual(try applier.applyWork(), .work)
        XCTAssertEqual(applier.snapshot(), ShieldSnapshot(workShielding: true, breakShielding: false))
    }

    func testKeepRestrictionsEnsuresTheWorkShieldsAreUp() throws {
        try saveWork()
        XCTAssertEqual(try applier.applyBreak(.keepRestrictions), .breakKeptRestrictions(fallback: false))
        XCTAssertTrue(stores.work.isShielding)
        let applies = stores.work.applyCount
        XCTAssertEqual(try applier.applyBreak(.keepRestrictions), .breakKeptRestrictions(fallback: false))
        XCTAssertEqual(stores.work.applyCount, applies, "no change when the work shields are already up")
    }

    func testClearAllNeverFailsAndEmptiesBothStores() throws {
        XCTAssertEqual(applier.clearAll(), .cleared)
        try saveWork()
        try applier.applyWork()
        try selections.save(keptPayload, summary: SelectionSummary(categoryCount: 1, applicationCount: 0, webDomainCount: 0), kind: .breakKept)
        try applier.applyBreak(.relaxCategories(kept: [.games]))
        XCTAssertEqual(applier.clearAll(), .cleared)
        XCTAssertFalse(applier.snapshot().anyShielding)
    }

    func testAnUndecodablePayloadSurfacesAsAnError() throws {
        try saveWork()
        struct Broken: Error {}
        stores.work.applyError = Broken()
        XCTAssertThrowsError(try applier.applyWork())
        XCTAssertFalse(applier.snapshot().anyShielding)
    }

    // MARK: Activity naming and break schedules

    func testActivityNaming() {
        XCTAssertEqual(ActivityNaming.shift(shiftId: "abc-123", version: 4), "shift-abc-123-v4")
        XCTAssertEqual(ActivityNaming.parse("shift-abc-123-v4"), .shift(shiftId: "abc-123", version: 4))
        XCTAssertEqual(ActivityNaming.parse("shift-x-v1-v2"), .shift(shiftId: "x-v1", version: 2), "the last -v<n> is the version")
        XCTAssertEqual(ActivityNaming.breakActivity(clientBreakId: "c1"), "break-c1")
        XCTAssertEqual(ActivityNaming.parse("break-c1"), .break(clientBreakId: "c1"))
        XCTAssertNil(ActivityNaming.parse("shift-"))
        XCTAssertNil(ActivityNaming.parse("shift-abc"))
        XCTAssertNil(ActivityNaming.parse("break-"))
        XCTAssertNil(ActivityNaming.parse("wm.shift.s"))
        XCTAssertTrue(ActivityNaming.isOurs("break-c1"))
        XCTAssertFalse(ActivityNaming.isOurs("somebody-else"))
    }

    func testBreakActivityScheduleFloorsToFifteenMinutesAndKeepsTheTrueEnd() throws {
        let utc = try XCTUnwrap(TimeZone(identifier: "UTC"))
        let short = BreakActivitySchedule.make(clientBreakId: "c", shiftId: "s", startedAt: iso("2026-10-06T11:00:20Z"), plannedEndsAt: iso("2026-10-06T11:05:20Z"), timeZone: utc)
        XCTAssertEqual(short.name, "break-c")
        XCTAssertEqual(short.kind, .break)
        XCTAssertEqual(short.intervalStart, iso("2026-10-06T11:00:00Z"), "start floored to the minute")
        XCTAssertEqual(short.intervalEnd, iso("2026-10-06T11:15:00Z"), "stretched to Apple's 15-minute minimum")
        XCTAssertEqual(short.plannedEnd, iso("2026-10-06T11:05:20Z"), "the true end is kept for the extension")
        XCTAssertEqual(short.warningMinutes, 0)
        let long = BreakActivitySchedule.make(clientBreakId: "c", shiftId: "s", startedAt: iso("2026-10-06T11:00:20Z"), plannedEndsAt: iso("2026-10-06T11:30:20Z"), timeZone: utc)
        XCTAssertEqual(long.intervalEnd, iso("2026-10-06T11:31:00Z"), "a long break ends at its planned end rounded up to the minute")
        let exact = BreakActivitySchedule.make(clientBreakId: "c", shiftId: "s", startedAt: iso("2026-10-06T11:00:00Z"), plannedEndsAt: iso("2026-10-06T11:15:00Z"), timeZone: utc)
        XCTAssertEqual(exact.intervalEnd, iso("2026-10-06T11:15:00Z"))
        for plan in [short, long, exact] {
            let length = try XCTUnwrap(plan.intervalEnd).timeIntervalSince(try XCTUnwrap(plan.intervalStart))
            XCTAssertGreaterThanOrEqual(length, TimeInterval(BreakActivitySchedule.minimumIntervalMinutes * 60))
            XCTAssertGreaterThanOrEqual(try XCTUnwrap(plan.intervalEnd), try XCTUnwrap(plan.plannedEnd), "the interval never ends before the planned end")
        }
    }

    // MARK: Shield copy

    func testShieldCopy() throws {
        let london = try XCTUnwrap(TimeZone(identifier: "Europe/London"))
        let locale = Locale(identifier: "en_GB")
        let now = iso("2026-10-06T10:00:00Z")
        XCTAssertEqual(ShieldCopy.make(plans: nil, now: now, timeZone: london, locale: locale), ShieldCopy(title: "Work Mode", subtitle: ShieldCopy.defaultSubtitle))

        func entry(message: String?) -> PlanEntry {
            PlanEntry(shiftId: "s", plan: RestrictionPlan(shiftId: "s", policyVersion: "pv", categories: [.games], shieldMessage: message, requiresBreakSubsetSelection: false),
                      activity: ActivityPlan(name: "shift-s-v1", shiftId: "s", startComponents: deviceComponents(for: iso("2026-10-06T08:00:00Z"), in: london),
                                             endComponents: deviceComponents(for: iso("2026-10-06T16:00:00Z"), in: london), warningMinutes: 15, kind: .shift,
                                             plannedEnd: iso("2026-10-06T16:00:00Z")))
        }
        let withMessage = PlansFile(generatedAt: now, organisationName: "Harpenden Coffee Co.", entries: [entry(message: "You're on shift.")])
        XCTAssertEqual(ShieldCopy.make(plans: withMessage, now: now, timeZone: london, locale: locale), ShieldCopy(title: "Harpenden Coffee Co.", subtitle: "You're on shift."))
        let withoutMessage = PlansFile(generatedAt: now, organisationName: "Harpenden Coffee Co.", entries: [entry(message: nil)])
        XCTAssertEqual(ShieldCopy.make(plans: withoutMessage, now: now, timeZone: london, locale: locale).subtitle, "Work Mode is active until 17:00.")
        XCTAssertEqual(ShieldCopy.make(plans: withoutMessage, now: iso("2026-10-06T20:00:00Z"), timeZone: london, locale: locale).subtitle, ShieldCopy.defaultSubtitle,
                       "no covering shift: neutral copy")
        XCTAssertEqual(ShieldCopy.make(plans: PlansFile(generatedAt: now, organisationName: "", entries: [PlanEntry]()), now: now, timeZone: london, locale: locale).title, "Work Mode")
    }

    // MARK: Break ledger

    func testBreakLedgerStartsLocalBreaksAndClosesThem() throws {
        let cache = StateCache(fileStore: fileStore)
        let outbox = EventOutbox(cache: cache)
        try cache.save(CachedState(organisation: Organisation(id: "o", name: "Org", timezone: "UTC"), employee: Employee(id: "e", firstName: "A", lastName: "B")))
        let ledger = BreakLedger(cache: cache)
        let approval = BreakStartApproval(startsAt: iso("2026-10-06T11:00:00Z"), plannedEndsAt: iso("2026-10-06T11:15:00Z"), durationMinutes: 15,
                                          remaining: BreakRemaining(breaks: 1, minutes: 15), behaviour: BreakBehaviourSnapshot(restrictionBehaviour: .relaxAll))
        let session = try ledger.startLocalBreak(approval: approval, shiftId: "s", clientBreakId: "ABCDEF00-0000-4000-8000-000000000001", requestedAt: iso("2026-10-06T11:00:00Z"), requestedDurationMinutes: nil)
        XCTAssertEqual(session.id, "abcdef00-0000-4000-8000-000000000001", "a local break's id is its client break id, lower-cased")
        let state = try XCTUnwrap(cache.load())
        XCTAssertEqual(state.activeBreakSession, session)
        XCTAssertTrue(state.isLocalBreak(session))
        XCTAssertEqual(state.queuedBreaks.map(\.status), [.pendingStart])

        // Still running: nothing to close.
        XCTAssertNil(ledger.closeExpiredBreak(in: state, shifts: [Fixture.shift("s", "2026-10-06T08:00:00Z", "2026-10-06T16:00:00Z")], now: iso("2026-10-06T11:10:00Z"), eventReason: "TEST"))
        // Expired: closed at its planned end with BREAK_EXPIRED; the queued start keeps the end for replay.
        let closure = try XCTUnwrap(ledger.closeExpiredBreak(in: state, shifts: [Fixture.shift("s", "2026-10-06T08:00:00Z", "2026-10-06T16:00:00Z")], now: iso("2026-10-06T11:20:00Z"), eventReason: "TEST"))
        XCTAssertEqual(closure.session.status, .ended)
        XCTAssertEqual(closure.session.endedAt, iso("2026-10-06T11:15:00Z"))
        XCTAssertEqual(closure.session.endReason, .expired)
        XCTAssertTrue(closure.isLocal)
        XCTAssertEqual(closure.event.type, .breakExpired)
        XCTAssertEqual(closure.event.metadata?.clientBreakId, session.clientBreakId)
        XCTAssertNil(closure.event.metadata?.breakSessionId, "a local break has no server id yet")
        XCTAssertEqual(closure.state.queuedBreaks.first?.endedAt, iso("2026-10-06T11:15:00Z"))
        XCTAssertEqual(closure.state.queuedBreaks.first?.endReason, .expired)
        XCTAssertEqual(closure.state.queuedBreaks.first?.status, .pendingStart, "the start still has to reach the server first")
        XCTAssertEqual(outbox.pending().map(\.type), [.breakExpired])
        XCTAssertNil(ledger.endActiveBreak(endedAt: Date(), reason: .employeeEnded, eventType: .breakEnded, eventReason: nil), "nothing active any more")
    }

    func testBreakLedgerClosesServerBreaksAndQueuesTheEndOnlyWhenAsked() throws {
        let cache = StateCache(fileStore: fileStore)
        let ledger = BreakLedger(cache: cache)
        let server = BreakSession(id: "11111111-1111-4111-8111-111111111111", clientBreakId: "22222222-2222-4222-8222-222222222222", shiftId: "s",
                                  startedAt: iso("2026-10-06T11:00:00Z"), plannedEndsAt: iso("2026-10-06T11:15:00Z"))
        try ledger.recordServerBreak(server)
        XCTAssertFalse(try XCTUnwrap(cache.load()).isLocalBreak(server))

        // Shift shortened to 11:10 → SHIFT_ENDED at the new end, BREAK_ENDED, nothing queued (the server sweeps it).
        let shortened = Fixture.shift("s", "2026-10-06T08:00:00Z", "2026-10-06T11:10:00Z")
        let closure = try XCTUnwrap(ledger.closeExpiredBreak(in: try XCTUnwrap(cache.load()), shifts: [shortened], now: iso("2026-10-06T11:12:00Z"), eventReason: "SHIFT_ENDED"))
        XCTAssertEqual(closure.session.endReason, .shiftEnded)
        XCTAssertEqual(closure.session.endedAt, iso("2026-10-06T11:10:00Z"))
        XCTAssertEqual(closure.event.type, .breakEnded)
        XCTAssertEqual(closure.event.metadata?.breakSessionId, server.id)
        XCTAssertTrue(closure.state.queuedBreaks.isEmpty)

        // An employee end the API could not deliver is queued as PENDING_END with the server id.
        try ledger.recordServerBreak(server)
        let early = try XCTUnwrap(ledger.endActiveBreak(matching: server.clientBreakId, endedAt: iso("2026-10-06T11:05:00Z"), reason: .employeeEnded,
                                                        eventType: .breakEnded, eventReason: BreakLedger.reasonEmployeeEnded, queueEndForServer: true))
        XCTAssertEqual(early.state.queuedBreaks.map(\.status), [.pendingEnd])
        XCTAssertEqual(early.state.queuedBreaks.first?.serverBreakSessionId, server.id)
        XCTAssertEqual(early.state.queuedBreaks.first?.endReason, .employeeEnded)
        XCTAssertNil(ledger.endActiveBreak(matching: "someone-else", endedAt: Date(), reason: .employeeEnded, eventType: .breakEnded, eventReason: nil))
    }
}
