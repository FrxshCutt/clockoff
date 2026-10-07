import Foundation
import ClockOffCore

/// What replaying the queued offline breaks did (see docs/SYNC_AND_OFFLINE.md and
/// docs/SCREEN_TIME_IMPLEMENTATION.md §6).
struct BreakReplayOutcome: Equatable, Sendable {
    struct Dropped: Equatable, Sendable {
        var clientBreakId: String
        var code: APIErrorCode
        var message: String
    }

    /// Records the server accepted (start, end or both); removed from the queue.
    var replayed = 0
    /// Starts the server refused; removed from the queue, and the local break ended if it was still running.
    var dropped: [Dropped] = []
    /// True when a running local break was ended by the replay: the shields must be reconciled now.
    var endedActiveBreak = false
    /// The transient error that stopped the replay (remaining records wait for the next sync).
    var error: APIError?

    var isEmpty: Bool { replayed == 0 && dropped.isEmpty && !endedActiveBreak && error == nil }
}

/// Replays `CachedState.queuedBreaks` against the API, oldest first, with the ORIGINAL `clientBreakId` and
/// `requestedAt` (the server validates that instant itself, docs/BREAK_RULES.md):
///
/// - `PENDING_START`: `POST /breaks/start`. An ACTIVE answer becomes the cached session (`BreakLedger.recordServerBreak`),
///   or is ended straight away when the phone already ended the break (`POST /breaks/:id/end`). An ENDED
///   answer (expired on arrival, or `POLICY_CHANGED` because the current policy disagrees) ends the local break
///   now so the shields come back. A refusal drops the record and ends the local break; the employee is told.
/// - `PENDING_END`: `POST /breaks/:id/end`; a refusal (already ended, not found) is final too.
/// - A transient failure stops the replay and keeps every remaining record for the next sync.
struct BreakReplayer {
    static let reasonServerRefused = "SERVER_REFUSED"
    static let reasonServerEnded = "SERVER_ENDED"

    private let api: BreakStarting
    private let cache: StateCache
    private let ledger: BreakLedger
    private let now: () -> Date

    init(api: BreakStarting, cache: StateCache, now: @escaping () -> Date = Date.init) {
        self.api = api
        self.cache = cache
        ledger = BreakLedger(cache: cache)
        self.now = now
    }

    func replay() async -> BreakReplayOutcome {
        var outcome = BreakReplayOutcome()
        let records = (cache.load()?.queuedBreaks ?? []).sorted { $0.requestedAt < $1.requestedAt }
        for record in records {
            do {
                switch record.status {
                case .pendingStart:
                    try await replayStart(record, outcome: &outcome)
                case .pendingEnd:
                    try await replayEnd(record, outcome: &outcome)
                }
            } catch let error as APIError where Self.shouldRetryLater(error) {
                ClockOffLog.sync.info("break replay paused (\(error.code.rawValue, privacy: .public)); \(records.count - outcome.replayed - outcome.dropped.count) record(s) kept")
                outcome.error = error
                return outcome
            } catch let error as APIError {
                drop(record, error: error, outcome: &outcome)
            } catch {
                outcome.error = APIError.network(error)
                return outcome
            }
        }
        return outcome
    }

    /// Errors that mean "try again on the next sync" rather than "the server said no".
    static func shouldRetryLater(_ error: APIError) -> Bool {
        error.isTransient || error.isAuthenticationFailure
            || [.credentialsUnavailable, .rateLimited, .cancelled].contains(error.code)
    }

    // MARK: Private

    private func replayStart(_ record: QueuedBreakRecord, outcome: inout BreakReplayOutcome) async throws {
        let session = try await api.startBreak(
            clientBreakId: record.clientBreakId,
            shiftId: record.shiftId,
            requestedAt: record.requestedAt,
            requestedDurationMinutes: record.requestedDurationMinutes
        )
        let state = cache.load() ?? CachedState()
        let isCurrent = state.activeBreakSession.map { Self.sameBreak($0, record) } ?? false
        let localRunning = isCurrent && state.activeBreakSession?.status == .active && state.activeBreakSession?.endedAt == nil

        if session.status == .ended {
            // Expired on arrival, or the policy in force disagrees with what the phone did (POLICY_CHANGED).
            if localRunning {
                _ = ledger.endActiveBreak(matching: record.clientBreakId, endedAt: session.endedAt ?? now(),
                                          reason: session.endReason ?? .policyChanged, eventType: .breakEnded,
                                          eventReason: Self.reasonServerEnded)
                outcome.endedActiveBreak = true
            }
            try cache.update { state in
                if isCurrent { state.activeBreakSession = session }
                Self.remove(record, from: &state)
            }
            outcome.replayed += 1
            return
        }

        if let endedAt = record.endedAt {
            // The phone already ended this break: the server has the start now, give it the end too.
            let reason = record.endReason ?? .employeeEnded
            var final = session
            final.status = .ended
            final.endedAt = max(session.startedAt, min(endedAt, session.plannedEndsAt))
            final.endReason = Self.breakEndReason(reason)
            do {
                try await api.endBreak(id: session.id, endedAt: endedAt, reason: reason)
            } catch let error as APIError where !Self.shouldRetryLater(error) {
                // Already ended on the server (sweep, manager): nothing left to say.
                ClockOffLog.sync.info("break end replay refused (\(error.code.rawValue, privacy: .public)); treating as ended")
            }
            try cache.update { state in
                if isCurrent { state.activeBreakSession = final }
                Self.remove(record, from: &state)
            }
        } else if localRunning {
            try ledger.recordServerBreak(session)
        } else {
            try cache.update { Self.remove(record, from: &$0) }
        }
        outcome.replayed += 1
    }

    private func replayEnd(_ record: QueuedBreakRecord, outcome: inout BreakReplayOutcome) async throws {
        guard let serverId = record.serverBreakSessionId, let endedAt = record.endedAt else {
            try cache.update { Self.remove(record, from: &$0) }
            return
        }
        do {
            try await api.endBreak(id: serverId, endedAt: endedAt, reason: record.endReason ?? .employeeEnded)
        } catch let error as APIError where !Self.shouldRetryLater(error) {
            ClockOffLog.sync.info("break end replay refused (\(error.code.rawValue, privacy: .public)); treating as ended")
        }
        try cache.update { Self.remove(record, from: &$0) }
        outcome.replayed += 1
    }

    private func drop(_ record: QueuedBreakRecord, error: APIError, outcome: inout BreakReplayOutcome) {
        let state = cache.load()
        if let local = state?.activeBreakSession, Self.sameBreak(local, record), local.status == .active, local.endedAt == nil {
            _ = ledger.endActiveBreak(matching: record.clientBreakId, endedAt: now(), reason: .policyChanged,
                                      eventType: .breakEnded, eventReason: Self.reasonServerRefused)
            outcome.endedActiveBreak = true
        }
        try? cache.update { Self.remove(record, from: &$0) }
        switch record.status {
        case .pendingStart:
            ClockOffLog.sync.error("offline break refused by the server: \(error.code.rawValue, privacy: .public)")
            outcome.dropped.append(.init(clientBreakId: record.clientBreakId, code: error.code, message: error.message))
        case .pendingEnd:
            outcome.replayed += 1
        }
    }

    private static func sameBreak(_ session: BreakSession, _ record: QueuedBreakRecord) -> Bool {
        session.clientBreakId.lowercased() == record.clientBreakId.lowercased()
            || session.id.lowercased() == record.clientBreakId.lowercased()
    }

    private static func remove(_ record: QueuedBreakRecord, from state: inout CachedState) {
        state.queuedBreaks.removeAll { $0.clientBreakId.lowercased() == record.clientBreakId.lowercased() }
    }

    private static func breakEndReason(_ reason: MobileBreakEndReason) -> BreakEndReason {
        switch reason {
        case .employeeEnded: return .employeeEnded
        case .expired: return .expired
        case .shiftEnded: return .shiftEnded
        }
    }
}
