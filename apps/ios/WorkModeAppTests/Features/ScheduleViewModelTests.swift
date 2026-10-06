import XCTest
@testable import WorkModeApp
import WorkModeCore

final class ScheduleViewModelTests: XCTestCase {
    private let london = TimeZone(identifier: "Europe/London")!
    private let now = iso("2026-10-06T09:00:00Z")

    private func shift(_ id: String, _ start: String, _ end: String, status: ShiftStatus = .scheduled, breaks: [ScheduledBreak] = []) -> Shift {
        Shift(id: id, startsAt: iso(start), endsAt: iso(end), timezone: "Europe/London", status: status, scheduledBreaks: breaks)
    }

    func testGroupsByDayWithTodayFirstAndOvernightSuffix() throws {
        let scheduledBreak = ScheduledBreak(id: "sb", offsetMinutesFromStart: 150, durationMinutes: 15,
                                            startsAt: iso("2026-10-06T10:30:00Z"), endsAt: iso("2026-10-06T10:45:00Z"))
        let shifts = [
            shift("overnight", "2026-10-07T21:00:00Z", "2026-10-08T05:00:00Z"),
            shift("today", "2026-10-06T08:00:00Z", "2026-10-06T16:00:00Z", breaks: [scheduledBreak]),
            shift("yesterday", "2026-10-05T08:00:00Z", "2026-10-05T16:00:00Z"),
            shift("too-far", "2026-10-26T08:00:00Z", "2026-10-26T16:00:00Z"),
            shift("day14", "2026-10-20T08:00:00Z", "2026-10-20T12:00:00Z"),
        ]
        let sections = ScheduleViewModel.sections(shifts: shifts, now: now, timeZone: london)
        let day14Title = TimeFormatting(timeZone: london, now: now).day(iso("2026-10-20T08:00:00Z"))
        XCTAssertEqual(sections.map(\.title), ["Today", "Tomorrow", day14Title])

        let today = try XCTUnwrap(sections.first?.shifts.first)
        XCTAssertEqual(today.id, "today")
        XCTAssertEqual(today.status, .inProgress)
        XCTAssertNil(today.overnightSuffix)
        XCTAssertEqual(today.breaks.count, 1)
        XCTAssertTrue(today.breaks[0].hasSuffix("· 15 min"))
        XCTAssertNil(today.timezoneNote)

        let overnight = try XCTUnwrap(sections[1].shifts.first)
        XCTAssertEqual(overnight.id, "overnight")
        XCTAssertEqual(overnight.overnightSuffix, "+1")
        XCTAssertEqual(overnight.status, .upcoming)
        XCTAssertEqual(overnight.duration, TimeFormatting.duration(8 * 3600))
    }

    func testEmptyScheduleStillShowsToday() {
        let sections = ScheduleViewModel.sections(shifts: [], now: now, timeZone: london)
        XCTAssertEqual(sections.map(\.title), ["Today"])
        XCTAssertTrue(sections[0].shifts.isEmpty)
    }

    func testCancelledShiftsAreHidden() {
        let sections = ScheduleViewModel.sections(shifts: [shift("c", "2026-10-07T08:00:00Z", "2026-10-07T12:00:00Z", status: .cancelled)], now: now, timeZone: london)
        XCTAssertEqual(sections.flatMap(\.shifts).count, 0)
    }

    func testAShiftThatStartedYesterdayAndStillRunsIsUnderToday() throws {
        let sections = ScheduleViewModel.sections(shifts: [shift("night", "2026-10-05T20:00:00Z", "2026-10-06T10:00:00Z")], now: now, timeZone: london)
        XCTAssertEqual(sections.map(\.title), ["Today"])
        let row = try XCTUnwrap(sections[0].shifts.first)
        XCTAssertEqual(row.status, .inProgress)
        XCTAssertEqual(row.overnightSuffix, "+1")
    }

    func testAShiftCreatedInAnotherZoneSaysSo() throws {
        let other = Shift(id: "ny", startsAt: iso("2026-10-07T13:00:00Z"), endsAt: iso("2026-10-07T21:00:00Z"), timezone: "America/New_York")
        let sections = ScheduleViewModel.sections(shifts: [other], now: now, timeZone: london)
        let row = try XCTUnwrap(sections.last?.shifts.first)
        XCTAssertEqual(row.timezoneNote, "Scheduled in America/New_York; shown in your phone's time.")
    }
}
