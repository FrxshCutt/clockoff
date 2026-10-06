import XCTest
@testable import WorkModeCore

final class DeviceComponentsTests: XCTestCase {
    private func zone(_ identifier: String) throws -> TimeZone {
        try XCTUnwrap(TimeZone(identifier: identifier))
    }

    private func wallClock(_ c: DateComponents) -> String {
        String(format: "%04d-%02d-%02d %02d:%02d:%02d", c.year ?? -1, c.month ?? -1, c.day ?? -1, c.hour ?? -1, c.minute ?? -1, c.second ?? -1)
    }

    func testCarriesCalendarZoneAndFullDate() throws {
        let london = try zone("Europe/London")
        let c = deviceComponents(for: iso("2026-10-06T08:00:00Z"), in: london)
        XCTAssertEqual(wallClock(c), "2026-10-06 09:00:00")
        XCTAssertEqual(c.timeZone, london)
        XCTAssertEqual(c.calendar?.identifier, .gregorian)
        XCTAssertNil(c.weekday, "only date + time fields: DeviceActivity treats extra fields as constraints")
        XCTAssertEqual(c.resolvedDate(), iso("2026-10-06T08:00:00Z"))
    }

    func testOvernightShiftEndsOnTheNextCalendarDay() throws {
        let london = try zone("Europe/London")
        let start = deviceComponents(for: iso("2026-10-06T21:00:00Z"), in: london)
        let end = deviceComponents(for: iso("2026-10-07T05:00:00Z"), in: london)
        XCTAssertEqual(wallClock(start), "2026-10-06 22:00:00")
        XCTAssertEqual(wallClock(end), "2026-10-07 06:00:00")
        XCTAssertEqual(end.resolvedDate(), iso("2026-10-07T05:00:00Z"))
    }

    func testSpringForwardSkipsTheMissingHour() throws {
        let london = try zone("Europe/London")
        // 2026-03-29: clocks go from 01:00 GMT to 02:00 BST at 01:00Z.
        XCTAssertEqual(wallClock(deviceComponents(for: iso("2026-03-29T00:59:00Z"), in: london)), "2026-03-29 00:59:00")
        XCTAssertEqual(wallClock(deviceComponents(for: iso("2026-03-29T01:00:00Z"), in: london)), "2026-03-29 02:00:00")
        let newYork = try zone("America/New_York")
        // 2026-03-08: 02:00 EST → 03:00 EDT at 07:00Z.
        let c = deviceComponents(for: iso("2026-03-08T07:00:00Z"), in: newYork)
        XCTAssertEqual(wallClock(c), "2026-03-08 03:00:00")
        XCTAssertEqual(c.resolvedDate(), iso("2026-03-08T07:00:00Z"))
    }

    func testFallBackWallClockIsAmbiguousAndResolvesToFirstOccurrence() throws {
        let london = try zone("Europe/London")
        // 2026-10-25: 02:00 BST → 01:00 GMT at 01:00Z; 01:30 local happens twice.
        let first = deviceComponents(for: iso("2026-10-25T00:30:00Z"), in: london)
        let second = deviceComponents(for: iso("2026-10-25T01:30:00Z"), in: london)
        XCTAssertEqual(wallClock(first), "2026-10-25 01:30:00")
        XCTAssertEqual(wallClock(second), "2026-10-25 01:30:00")
        XCTAssertEqual(first.resolvedDate(), iso("2026-10-25T00:30:00Z"))
        XCTAssertEqual(second.resolvedDate(), iso("2026-10-25T00:30:00Z"), "components alone cannot tell the two apart; keep the UTC instant")
    }

    func testOvernightShiftAcrossFallBackKeepsRealDuration() throws {
        let london = try zone("Europe/London")
        let startInstant = iso("2026-10-24T22:00:00Z")
        let endInstant = iso("2026-10-25T06:00:00Z")
        let start = deviceComponents(for: startInstant, in: london)
        let end = deviceComponents(for: endInstant, in: london)
        XCTAssertEqual(wallClock(start), "2026-10-24 23:00:00", "BST")
        XCTAssertEqual(wallClock(end), "2026-10-25 06:00:00", "GMT")
        let resolvedStart = try XCTUnwrap(start.resolvedDate())
        let resolvedEnd = try XCTUnwrap(end.resolvedDate())
        XCTAssertEqual(resolvedEnd.timeIntervalSince(resolvedStart), 8 * 3600, "8 real hours although the wall clock shows 7")
    }

    func testSameInstantDiffersByZone() throws {
        let instant = iso("2026-07-01T23:30:00Z")
        XCTAssertEqual(wallClock(deviceComponents(for: instant, in: try zone("Europe/London"))), "2026-07-02 00:30:00")
        XCTAssertEqual(wallClock(deviceComponents(for: instant, in: try zone("America/Los_Angeles"))), "2026-07-01 16:30:00")
        XCTAssertEqual(wallClock(deviceComponents(for: instant, in: try zone("Asia/Kolkata"))), "2026-07-02 05:00:00")
    }
}
