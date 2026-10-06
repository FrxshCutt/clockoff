import XCTest
import WorkModeCore
@testable import WorkModeApp

final class CopyFormattingTests: XCTestCase {
    func testSelectionCountsUseSingularAndPlural() {
        XCTAssertEqual(SelectionCountsText.plural(1, "website", "websites"), "1 website")
        XCTAssertEqual(SelectionCountsText.plural(0, "app", "apps"), "0 apps")
        XCTAssertEqual(SelectionCountsText.plural(4, "app", "apps"), "4 apps")
        let text = SelectionCountsText.describe(SelectionCounts(categories: 3, applications: 1, webDomains: 1))
        XCTAssertTrue(text.contains("3 categories"), text)
        XCTAssertTrue(text.contains("1 app"), text)
        XCTAssertFalse(text.contains("1 apps"), text)
        XCTAssertTrue(text.contains("1 website"), text)
        XCTAssertFalse(text.contains("1 websites"), text)
    }

    func testRelativeTimeSaysJustNowWithinAMinuteEitherSide() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let time = TimeFormatting(timeZone: TimeZone(identifier: "Europe/London")!, now: now)
        XCTAssertEqual(time.relative(now), "just now")
        XCTAssertEqual(time.relative(now.addingTimeInterval(0.4)), "just now", "clock jitter must not read 'in 0 seconds'")
        XCTAssertEqual(time.relative(now.addingTimeInterval(-45)), "just now")
        XCTAssertFalse(time.relative(now.addingTimeInterval(-300)).hasPrefix("in "))
    }
}
