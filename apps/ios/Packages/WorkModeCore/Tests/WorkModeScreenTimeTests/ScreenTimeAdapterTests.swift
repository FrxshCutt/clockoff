import FamilyControls
import ManagedSettings
import XCTest
import WorkModeCore
@testable import WorkModeScreenTime

/// The thin ManagedSettings / FamilyControls adapter. Screen Time itself does not run in the simulator, so these
/// tests cover only what is pure: the authorisation mapping, the store names and the selection codec.
final class ScreenTimeAdapterTests: XCTestCase {
    func testAuthorizationStatusMapping() {
        XCTAssertEqual(RestrictionAuthorizationStatus(.notDetermined), .notDetermined)
        XCTAssertEqual(RestrictionAuthorizationStatus(.approved), .approved)
        XCTAssertEqual(RestrictionAuthorizationStatus(.denied), .denied)
    }

    func testStoreNamesAreDistinctAndStable() {
        XCTAssertEqual(ManagedSettingsStore.Name.work.rawValue, "online.clockoff.shields.work")
        XCTAssertEqual(ManagedSettingsStore.Name.breakRelaxed.rawValue, "online.clockoff.shields.breakRelaxed")
        XCTAssertNotEqual(ManagedSettingsStore.Name.work, ManagedSettingsStore.Name.breakRelaxed)
        XCTAssertEqual(ManagedSettingsStore.Name.forRole(.work), .work)
        XCTAssertEqual(ManagedSettingsStore.Name.forRole(.breakRelaxed), .breakRelaxed)
        XCTAssertEqual(ScreenTimeShieldStores().work.name, .work)
        XCTAssertEqual(ScreenTimeShieldStores().breakRelaxed.name, .breakRelaxed)
    }

    func testSelectionCodecRoundTripsAnEmptySelectionAndReportsCountsOnly() throws {
        let empty = FamilyActivitySelection()
        let data = try SelectionCodec.encode(empty)
        let decoded = try SelectionCodec.decode(data)
        XCTAssertEqual(decoded.applicationTokens.count, 0)
        XCTAssertEqual(decoded.categoryTokens.count, 0)
        XCTAssertEqual(decoded.webDomainTokens.count, 0)
        XCTAssertEqual(SelectionCodec.summary(of: empty), .empty)
        XCTAssertTrue(SelectionCodec.summary(of: empty).isEmpty)
    }

    func testSelectionCodecRejectsForeignPayloads() throws {
        XCTAssertThrowsError(try SelectionCodec.decode(Data("not a selection".utf8)))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("WorkModeScreenTimeTests-\(UUID().uuidString)", isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let store = SelectionStore(fileStore: try AppGroupFileStore(directory: directory))
        try store.save(Data("garbage".utf8), summary: SelectionSummary(categoryCount: 1, applicationCount: 0, webDomainCount: 0), kind: .work, format: "other")
        XCTAssertEqual(SelectionCodec.load(.work, from: store).categoryTokens.count, 0, "an unknown format loads as an empty selection")
    }
}
