import XCTest
@testable import ClockOffApp
import ClockOffCore

final class NotificationPlannerTests: XCTestCase {
    private let london = TimeZone(identifier: "Europe/London")!

    private func cache(shifts: [Shift] = [Fixtures.shift], policy: PolicySummary? = Fixtures.policy, activeBreak: BreakSession? = nil) -> CachedState {
        CachedState(organisation: Fixtures.organisation, employee: Fixtures.employee, policy: policy, breakPolicy: Fixtures.breakPolicy,
                    shifts: shifts, activeBreakSession: activeBreak)
    }

    func testPlansWarningStartAndEndWithDeterministicIds() {
        let planned = NotificationPlanner.plan(cache: cache(), now: iso("2026-10-06T07:00:00Z"), timeZone: london)
        XCTAssertEqual(planned.map(\.id), ["clockoff.shift-\(Fixtures.shift.id)-warning", "clockoff.shift-\(Fixtures.shift.id)-start", "clockoff.shift-\(Fixtures.shift.id)-end"])
        XCTAssertEqual(planned.map(\.fireAt), [iso("2026-10-06T07:45:00Z"), iso("2026-10-06T08:00:00Z"), iso("2026-10-06T16:00:00Z")])
        XCTAssertEqual(planned.map(\.title), ["Shift begins soon", "Work Mode activated", "Work Mode ended"])
        let again = NotificationPlanner.plan(cache: cache(), now: iso("2026-10-06T07:00:00Z"), timeZone: london)
        XCTAssertEqual(planned, again, "re-planning yields the same requests, so they replace rather than duplicate")
    }

    func testSkipsPastTriggersAndPlansNothingWithoutAPolicy() {
        let during = NotificationPlanner.plan(cache: cache(), now: iso("2026-10-06T09:00:00Z"), timeZone: london)
        XCTAssertEqual(during.map(\.id), [NotificationPlanner.shiftEnd(shiftId: Fixtures.shift.id)])
        XCTAssertTrue(NotificationPlanner.plan(cache: cache(policy: nil), now: iso("2026-10-06T07:00:00Z"), timeZone: london).isEmpty)
        XCTAssertTrue(NotificationPlanner.plan(cache: CachedState(), now: iso("2026-10-06T07:00:00Z"), timeZone: london).isEmpty, "not joined")
    }

    func testNoWarningWhenThePolicyDisablesIt() {
        let policy = PolicySummary(policy: Fixtures.policy.policy, version: Fixtures.policy.version,
                                   restrictionConfig: RestrictionConfig(categories: [.games], preShiftWarningMinutes: 0))
        let planned = NotificationPlanner.plan(cache: cache(policy: policy), now: iso("2026-10-06T07:00:00Z"), timeZone: london)
        XCTAssertEqual(planned.map(\.id), [NotificationPlanner.shiftStart(shiftId: Fixtures.shift.id), NotificationPlanner.shiftEnd(shiftId: Fixtures.shift.id)])
    }

    func testBackToBackShiftsAreOneInterval() {
        let second = Shift(id: "00000000-0000-4000-8000-000000000031", startsAt: iso("2026-10-06T16:00:00Z"), endsAt: iso("2026-10-06T20:00:00Z"), timezone: "Europe/London")
        let planned = NotificationPlanner.plan(cache: cache(shifts: [Fixtures.shift, second]), now: iso("2026-10-06T07:00:00Z"), timeZone: london)
        XCTAssertEqual(planned.map(\.id), ["clockoff.shift-\(Fixtures.shift.id)-warning", "clockoff.shift-\(Fixtures.shift.id)-start", "clockoff.shift-\(Fixtures.shift.id)-end"])
        XCTAssertEqual(planned.last?.fireAt, iso("2026-10-06T20:00:00Z"), "Work Mode ends when the merged interval ends")
    }

    func testBreakEndingSoonTwoMinutesBeforeThePlannedEnd() {
        let session = BreakSession(id: "srv", clientBreakId: "c-1", shiftId: Fixtures.shift.id, startedAt: iso("2026-10-06T10:00:00Z"),
                                   plannedEndsAt: iso("2026-10-06T10:15:00Z"), restrictionBehaviour: .relaxAll)
        let planned = NotificationPlanner.plan(cache: cache(activeBreak: session), now: iso("2026-10-06T10:05:00Z"), timeZone: london)
        XCTAssertEqual(planned.map(\.id), ["clockoff.break-c-1-ending", "clockoff.break-c-1-ended", "clockoff.shift-\(Fixtures.shift.id)-end"])
        XCTAssertEqual(planned[0].fireAt, iso("2026-10-06T10:13:00Z"))
        XCTAssertEqual(planned[1].fireAt, iso("2026-10-06T10:15:00Z"))

        let late = NotificationPlanner.plan(cache: cache(activeBreak: session), now: iso("2026-10-06T10:14:00Z"), timeZone: london)
        XCTAssertEqual(late.map(\.id), ["clockoff.break-c-1-ended", "clockoff.shift-\(Fixtures.shift.id)-end"], "the warning moment has passed")

        var ended = session
        ended.status = .ended
        ended.endedAt = iso("2026-10-06T10:06:00Z")
        let after = NotificationPlanner.plan(cache: cache(activeBreak: ended), now: iso("2026-10-06T10:07:00Z"), timeZone: london)
        XCTAssertEqual(after.map(\.id), ["clockoff.shift-\(Fixtures.shift.id)-end"], "an ended break is not announced")
    }

    func testBreakCutShortByTheShiftEndHasNoBreakNotifications() {
        let session = BreakSession(id: "srv", clientBreakId: "c-late", shiftId: Fixtures.shift.id, startedAt: iso("2026-10-06T15:50:00Z"),
                                   plannedEndsAt: iso("2026-10-06T16:05:00Z"), restrictionBehaviour: .relaxAll)
        let planned = NotificationPlanner.plan(cache: cache(activeBreak: session), now: iso("2026-10-06T15:52:00Z"), timeZone: london)
        XCTAssertEqual(planned.map(\.id), ["clockoff.shift-\(Fixtures.shift.id)-end"], "\"Work Mode ended\" covers the break too")
    }

    func testCapsAtTheIOSPendingLimitSoonestFirst() {
        let shifts = (0..<40).map { day in
            Shift(id: "00000000-0000-4000-8000-0000000001\(String(format: "%02d", day))", startsAt: iso("2026-10-06T08:00:00Z").addingTimeInterval(TimeInterval(day) * 4 * 3600),
                  endsAt: iso("2026-10-06T08:00:00Z").addingTimeInterval(TimeInterval(day) * 4 * 3600 + 3600), timezone: "Europe/London")
        }
        let planned = NotificationPlanner.plan(cache: cache(shifts: shifts), now: iso("2026-10-06T07:00:00Z"), timeZone: london)
        XCTAssertEqual(planned.count, NotificationPlanner.maxPending)
        XCTAssertEqual(planned, planned.sorted { $0.fireAt < $1.fireAt })
    }

    func testImmediateNoticesHaveFixedIdentifiers() {
        XCTAssertEqual(NotificationPlanner.scheduleChangedIdentifier, "clockoff.schedule-changed")
        XCTAssertEqual(NotificationPlanner.permissionAttentionIdentifier, "clockoff.permission-attention")
        XCTAssertTrue(NotificationPlanner.isOurs("clockoff.shift-x-start"))
        XCTAssertFalse(NotificationPlanner.isOurs("other.app"))
        XCTAssertEqual(NotificationPlanner.scheduleChanged().title, "Schedule changed")
        XCTAssertEqual(NotificationPlanner.permissionAttention().title, "ClockOff needs attention")
    }
}
