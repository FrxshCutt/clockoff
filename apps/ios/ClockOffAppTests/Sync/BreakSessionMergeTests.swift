import XCTest
@testable import ClockOffApp
import ClockOffCore

final class BreakSessionMergeTests: XCTestCase {
    private let local = BreakSession(id: "c-1", clientBreakId: "c-1", shiftId: Fixtures.shift.id, startedAt: iso("2026-10-06T10:00:00Z"),
                                     plannedEndsAt: iso("2026-10-06T10:15:00Z"))
    private let remote = BreakSession(id: "srv-2", clientBreakId: "c-2", shiftId: Fixtures.shift.id, startedAt: iso("2026-10-06T10:00:00Z"),
                                      plannedEndsAt: iso("2026-10-06T10:15:00Z"))
    private var record: QueuedBreakRecord {
        QueuedBreakRecord(clientBreakId: "c-1", shiftId: Fixtures.shift.id, requestedAt: iso("2026-10-06T10:00:00Z"), requestedDurationMinutes: nil,
                          plannedEndsAt: iso("2026-10-06T10:15:00Z"), createdAt: iso("2026-10-06T10:00:00Z"))
    }

    func testServerWinsWhenNothingIsQueued() {
        XCTAssertEqual(BreakSessionMerge.merge(local: local, remote: remote, queued: []), remote)
        XCTAssertNil(BreakSessionMerge.merge(local: local, remote: nil, queued: []), "the server ended or never had it")
        XCTAssertEqual(BreakSessionMerge.merge(local: nil, remote: remote, queued: []), remote)
    }

    func testALocalBreakAwaitingReplaySurvivesTheSync() {
        XCTAssertEqual(BreakSessionMerge.merge(local: local, remote: nil, queued: [record]), local)
        XCTAssertEqual(BreakSessionMerge.merge(local: local, remote: remote, queued: [record]), local)
        var pendingEnd = record
        pendingEnd.status = .pendingEnd
        pendingEnd.serverBreakSessionId = "srv-1"
        XCTAssertEqual(BreakSessionMerge.merge(local: local, remote: remote, queued: [pendingEnd]), local, "an end the server has not seen must not be undone")
    }
}
