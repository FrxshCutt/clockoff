import XCTest
@testable import WorkModeApp
import WorkModeCore

/// `BreakReplayer` against the stubbed API and temporary App Group storage (the controller's offline records).
final class BreakReplayerTests: XCTestCase {
    private var env: TestEnvironment!
    private var replayer: BreakReplayer!

    override func setUpWithError() throws {
        env = try TestEnvironment(testCase: self, now: iso("2026-10-06T10:30:00Z"))
        try env.join()
        try env.cache.update { state in
            state.policy = Fixtures.policy
            state.breakPolicy = Fixtures.breakPolicy
            state.shifts = [Fixtures.shift]
        }
        let clock = env.clock
        replayer = BreakReplayer(api: env.breakAPI, cache: env.cache, now: { clock.now })
    }

    private func queue(clientBreakId: String, requestedAt: Date, endedAt: Date? = nil, status: QueuedBreakRecord.Status = .pendingStart,
                       serverId: String? = nil, active: Bool = true) throws {
        let plannedEnd = requestedAt.addingTimeInterval(15 * 60)
        try env.cache.update { state in
            if active {
                state.activeBreakSession = BreakSession(id: serverId ?? clientBreakId, clientBreakId: clientBreakId, shiftId: Fixtures.shift.id, startedAt: requestedAt,
                                                        plannedEndsAt: plannedEnd, endedAt: endedAt, status: endedAt == nil ? .active : .ended,
                                                        endReason: endedAt == nil ? nil : .employeeEnded, restrictionBehaviour: .relaxAll)
            }
            state.queuedBreaks.append(QueuedBreakRecord(clientBreakId: clientBreakId, shiftId: Fixtures.shift.id, requestedAt: requestedAt,
                                                        requestedDurationMinutes: 15, plannedEndsAt: plannedEnd, status: status, endedAt: endedAt,
                                                        endReason: endedAt == nil ? nil : .employeeEnded, serverBreakSessionId: serverId, createdAt: requestedAt))
        }
    }

    func testPendingStartBecomesTheServerSession() async throws {
        try queue(clientBreakId: "c-1", requestedAt: iso("2026-10-06T10:20:00Z"))
        env.api.acceptBreaks()
        let outcome = await replayer.replay()
        XCTAssertEqual(outcome, BreakReplayOutcome(replayed: 1))
        XCTAssertEqual(env.api.startBreakRequests.map(\.clientBreakId), ["c-1"])
        XCTAssertEqual(env.api.startBreakRequests.first?.requestedAt, iso("2026-10-06T10:20:00Z"))
        let cached = try XCTUnwrap(env.cache.load())
        XCTAssertTrue(cached.queuedBreaks.isEmpty)
        XCTAssertEqual(cached.activeBreakSession?.id, "server-c-1")
        XCTAssertEqual(cached.activeBreakSession?.status, .active)
        XCTAssertFalse(cached.isLocalBreak(cached.activeBreakSession!))
    }

    func testPendingStartWithALocalEndSendsTheEndToo() async throws {
        try queue(clientBreakId: "c-1", requestedAt: iso("2026-10-06T10:00:00Z"), endedAt: iso("2026-10-06T10:05:00Z"))
        env.api.acceptBreaks()
        let outcome = await replayer.replay()
        XCTAssertEqual(outcome.replayed, 1)
        XCTAssertEqual(env.api.endBreakRequests.first?.id, "server-c-1")
        XCTAssertEqual(env.api.endBreakRequests.first?.request.endedAt, iso("2026-10-06T10:05:00Z"))
        XCTAssertEqual(env.api.endBreakRequests.first?.request.reason, .employeeEnded)
        let cached = try XCTUnwrap(env.cache.load())
        XCTAssertTrue(cached.queuedBreaks.isEmpty)
        XCTAssertEqual(cached.activeBreakSession?.id, "server-c-1")
        XCTAssertEqual(cached.activeBreakSession?.status, .ended)
        XCTAssertEqual(cached.activeBreakSession?.endedAt, iso("2026-10-06T10:05:00Z"))
    }

    func testAnEndedAnswerEndsTheRunningLocalBreak() async throws {
        try queue(clientBreakId: "c-1", requestedAt: iso("2026-10-06T10:20:00Z"))
        env.api.startBreakHandler = { request in
            BreakResponse(breakSession: BreakSession(id: "server-\(request.clientBreakId)", clientBreakId: request.clientBreakId, shiftId: request.shiftId,
                                                     startedAt: request.requestedAt, plannedEndsAt: request.requestedAt.addingTimeInterval(600),
                                                     endedAt: request.requestedAt.addingTimeInterval(600), status: .ended, endReason: .policyChanged),
                          allowance: nil)
        }
        let outcome = await replayer.replay()
        XCTAssertTrue(outcome.endedActiveBreak)
        XCTAssertEqual(outcome.replayed, 1)
        let cached = try XCTUnwrap(env.cache.load())
        XCTAssertEqual(cached.activeBreakSession?.id, "server-c-1")
        XCTAssertEqual(cached.activeBreakSession?.status, .ended)
        XCTAssertEqual(cached.activeBreakSession?.endReason, .policyChanged)
        XCTAssertTrue(cached.queuedBreaks.isEmpty)
        let event = try XCTUnwrap(env.outbox.pending().last)
        XCTAssertEqual(event.type, .breakEnded)
        XCTAssertEqual(event.metadata?.reason, BreakReplayer.reasonServerEnded)
    }

    func testARefusalDropsTheRecordAndEndsTheLocalBreak() async throws {
        try queue(clientBreakId: "c-1", requestedAt: iso("2026-10-06T10:20:00Z"))
        env.api.startBreakHandler = { _ in throw APIError(code: .breakTooSoon, message: "Breaks can start at 11:00.", status: 409) }
        let outcome = await replayer.replay()
        XCTAssertEqual(outcome.dropped, [.init(clientBreakId: "c-1", code: .breakTooSoon, message: "Breaks can start at 11:00.")])
        XCTAssertTrue(outcome.endedActiveBreak)
        XCTAssertNil(outcome.error)
        let cached = try XCTUnwrap(env.cache.load())
        XCTAssertTrue(cached.queuedBreaks.isEmpty)
        XCTAssertEqual(cached.activeBreakSession?.status, .ended)
        XCTAssertEqual(cached.activeBreakSession?.endedAt, env.clock.now)
        XCTAssertEqual(cached.activeBreakSession?.endReason, .policyChanged)
        let event = try XCTUnwrap(env.outbox.pending().last)
        XCTAssertEqual(event.type, .breakEnded)
        XCTAssertEqual(event.metadata?.reason, BreakReplayer.reasonServerRefused)
        XCTAssertNil(event.metadata?.breakSessionId)
    }

    func testATransientErrorKeepsEveryRemainingRecord() async throws {
        try queue(clientBreakId: "c-1", requestedAt: iso("2026-10-06T09:30:00Z"), endedAt: iso("2026-10-06T09:45:00Z"), active: false)
        try queue(clientBreakId: "c-2", requestedAt: iso("2026-10-06T10:20:00Z"))
        env.api.startBreakHandler = { _ in throw APIError.network(URLError(.notConnectedToInternet)) }
        let outcome = await replayer.replay()
        XCTAssertEqual(outcome.error?.code, .networkError)
        XCTAssertEqual(outcome.replayed, 0)
        XCTAssertEqual(env.api.startBreakRequests.count, 1, "stops at the first transient failure")
        let cached = try XCTUnwrap(env.cache.load())
        XCTAssertEqual(cached.queuedBreaks.map(\.clientBreakId), ["c-1", "c-2"])
        XCTAssertEqual(cached.activeBreakSession?.status, .active)
    }

    func testRecordsAreReplayedOldestFirst() async throws {
        try queue(clientBreakId: "c-late", requestedAt: iso("2026-10-06T10:20:00Z"))
        try queue(clientBreakId: "c-early", requestedAt: iso("2026-10-06T09:00:00Z"), endedAt: iso("2026-10-06T09:15:00Z"), active: false)
        env.api.acceptBreaks()
        let outcome = await replayer.replay()
        XCTAssertEqual(outcome.replayed, 2)
        XCTAssertEqual(env.api.startBreakRequests.map(\.clientBreakId), ["c-early", "c-late"])
        XCTAssertEqual(env.api.endBreakRequests.map(\.id), ["server-c-early"])
        XCTAssertTrue(env.cache.load()?.queuedBreaks.isEmpty ?? false)
    }

    func testPendingEndIsSentAndARefusalIsFinal() async throws {
        try queue(clientBreakId: "c-1", requestedAt: iso("2026-10-06T10:00:00Z"), endedAt: iso("2026-10-06T10:05:00Z"), status: .pendingEnd, serverId: "srv-1")
        env.api.acceptBreaks()
        var outcome = await replayer.replay()
        XCTAssertEqual(outcome.replayed, 1)
        XCTAssertEqual(env.api.endBreakRequests.map(\.id), ["srv-1"])
        XCTAssertTrue(env.cache.load()?.queuedBreaks.isEmpty ?? false)

        try queue(clientBreakId: "c-2", requestedAt: iso("2026-10-06T10:10:00Z"), endedAt: iso("2026-10-06T10:12:00Z"), status: .pendingEnd, serverId: "srv-2")
        env.api.endBreakHandler = { _, _ in throw APIError(code: .notFound, message: "Break session not found", status: 404) }
        outcome = await replayer.replay()
        XCTAssertEqual(outcome.replayed, 1, "the server no longer has it: nothing left to replay")
        XCTAssertTrue(outcome.dropped.isEmpty)
        XCTAssertTrue(env.cache.load()?.queuedBreaks.isEmpty ?? false)
    }

    func testNothingQueuedIsANoOp() async {
        let outcome = await replayer.replay()
        XCTAssertTrue(outcome.isEmpty)
        XCTAssertTrue(env.api.calls.isEmpty)
    }
}
