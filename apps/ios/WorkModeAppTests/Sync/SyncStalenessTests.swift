import XCTest
@testable import WorkModeApp

final class SyncStalenessTests: XCTestCase {
    private let now = iso("2026-10-06T12:00:00Z")

    func testFreshSyncShowsNoBanner() {
        XCTAssertNil(SyncStaleness.banner(lastSyncAt: iso("2026-10-06T11:30:00Z"), now: now))
        XCTAssertNil(SyncStaleness.banner(lastSyncAt: iso("2026-10-06T11:00:00Z"), now: now), "exactly an hour is not yet stale")
        XCTAssertFalse(SyncStaleness.isStale(lastSyncAt: iso("2026-10-06T11:00:01Z"), now: now))
    }

    func testStaleSyncShowsTheAge() {
        XCTAssertEqual(SyncStaleness.banner(lastSyncAt: iso("2026-10-06T10:00:00Z"), now: now), "Last synced 2h ago · changes will apply when online")
        XCTAssertEqual(SyncStaleness.banner(lastSyncAt: iso("2026-10-06T11:30:00Z"), now: iso("2026-10-06T12:45:00Z")), "Last synced 1h ago · changes will apply when online")
        XCTAssertEqual(SyncStaleness.banner(lastSyncAt: iso("2026-10-06T10:59:00Z"), now: now), "Last synced 1h ago · changes will apply when online")
        XCTAssertEqual(SyncStaleness.banner(lastSyncAt: iso("2026-10-03T12:00:00Z"), now: now), "Last synced 3d ago · changes will apply when online")
        XCTAssertEqual(SyncStaleness.banner(lastSyncAt: nil, now: now), "Not synced yet · changes will apply when online")
    }
}
