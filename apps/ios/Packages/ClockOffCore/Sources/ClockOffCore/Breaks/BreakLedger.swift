import Foundation

/// The device's record of the running break, kept in `CachedState` (App Group `state.json`) and shared by the
/// app (`WorkModeController`) and the DeviceActivityMonitor extension (`MonitorEventHandler`). Both end a break
/// the same way: the session row is closed, a break started offline keeps its `QueuedBreakRecord` in step so the
/// sync layer can replay it, and the matching BREAK_* event is queued in the outbox.
///
/// Only operational facts are stored: ids, instants and reason codes (§12).
public struct BreakLedger {
    /// `reason` metadata codes carried on the events this ledger queues.
    public static let reasonEmployeeEnded = "EMPLOYEE_ENDED"
    public static let reasonOfflineStart = "OFFLINE_START"

    /// What `endActiveBreak` did.
    public struct Closure: Equatable, Sendable {
        /// The session as persisted after closing (status ENDED, `endedAt` and `endReason` set).
        public var session: BreakSession
        /// True when the break exists only on this device so far (no server id).
        public var isLocal: Bool
        public var event: DeviceEvent
        public var state: CachedState
    }

    private let cache: StateCache
    private let outbox: EventOutbox

    public init(cache: StateCache) {
        self.cache = cache
        outbox = EventOutbox(cache: cache)
    }

    // MARK: Starting

    /// Records a break the server accepted (`POST /breaks/start` succeeded) as the running break.
    @discardableResult
    public func recordServerBreak(_ session: BreakSession) throws -> CachedState {
        try cache.update { state in
            state.activeBreakSession = session
            // A retry that finally reached the server supersedes any queued start for the same id.
            state.queuedBreaks.removeAll { $0.clientBreakId.lowercased() == session.clientBreakId.lowercased() }
        }
    }

    /// Starts a break the API could not be reached for: the session exists only on this device (its `id` is the
    /// client break id) and a `QueuedBreakRecord` waits for the sync layer to replay `POST /breaks/start` with the
    /// original `clientBreakId` / `requestedAt`. The server validates that instant itself (docs/BREAK_RULES.md).
    @discardableResult
    public func startLocalBreak(
        approval: BreakStartApproval,
        shiftId: String,
        clientBreakId: String,
        requestedAt: Date,
        requestedDurationMinutes: Int?
    ) throws -> BreakSession {
        let id = clientBreakId.lowercased()
        let session = BreakSession(
            id: id,
            clientBreakId: id,
            shiftId: shiftId,
            startedAt: approval.startsAt,
            plannedEndsAt: approval.plannedEndsAt,
            endedAt: nil,
            status: .active,
            endReason: nil,
            restrictionBehaviour: approval.behaviour.restrictionBehaviour,
            relaxedCategories: approval.behaviour.relaxedCategories
        )
        let record = QueuedBreakRecord(
            clientBreakId: id,
            shiftId: shiftId,
            requestedAt: requestedAt,
            requestedDurationMinutes: requestedDurationMinutes,
            plannedEndsAt: approval.plannedEndsAt,
            status: .pendingStart,
            createdAt: requestedAt
        )
        try cache.update { state in
            state.activeBreakSession = session
            state.queuedBreaks.removeAll { $0.clientBreakId.lowercased() == id }
            state.queuedBreaks.append(record)
        }
        return session
    }

    // MARK: Ending

    /// Closes the cached active break (when one is running and, if given, matches `clientBreakId` or the session
    /// id), updates or creates its `QueuedBreakRecord`, and queues the BREAK_* event. Returns nil when nothing
    /// was running.
    ///
    /// - Parameters:
    ///   - endedAt: the effective end to persist (never after `plannedEndsAt`, never before `startedAt`).
    ///   - reason: why it ended (`EXPIRED`, `SHIFT_ENDED`, `EMPLOYEE_ENDED`).
    ///   - eventType: `BREAK_EXPIRED` or `BREAK_ENDED`.
    ///   - queueEndForServer: true when the server must still be told (`POST /breaks/:id/end` failed or the break
    ///     is local). Expiries and shift ends need no replay: the server closes those rows itself.
    @discardableResult
    public func endActiveBreak(
        matching clientBreakId: String? = nil,
        endedAt: Date,
        reason: BreakEndReason,
        eventType: ActivityEventType,
        eventReason: String?,
        queueEndForServer: Bool = false
    ) -> Closure? {
        var ended: BreakSession?
        var isLocal = false
        let updated = try? cache.update { state in
            guard var session = state.activeBreakSession, session.status == .active, session.endedAt == nil else { return }
            if let clientBreakId {
                let wanted = clientBreakId.lowercased()
                guard session.clientBreakId.lowercased() == wanted || session.id.lowercased() == wanted else { return }
            }
            let effectiveEnd = max(session.startedAt, min(endedAt, session.plannedEndsAt))
            session.status = .ended
            session.endedAt = effectiveEnd
            session.endReason = reason
            state.activeBreakSession = session
            isLocal = state.isLocalBreak(session)

            let mobileReason = BreakLedger.mobileReason(for: reason)
            if let index = state.queuedBreaks.firstIndex(where: { $0.clientBreakId.lowercased() == session.clientBreakId.lowercased() }) {
                state.queuedBreaks[index].endedAt = effectiveEnd
                state.queuedBreaks[index].endReason = mobileReason
                if state.queuedBreaks[index].serverBreakSessionId != nil { state.queuedBreaks[index].status = .pendingEnd }
            } else if queueEndForServer, !isLocal {
                state.queuedBreaks.append(QueuedBreakRecord(
                    clientBreakId: session.clientBreakId.isEmpty ? session.id : session.clientBreakId,
                    shiftId: session.shiftId,
                    requestedAt: session.startedAt,
                    requestedDurationMinutes: nil,
                    plannedEndsAt: session.plannedEndsAt,
                    status: .pendingEnd,
                    endedAt: effectiveEnd,
                    endReason: mobileReason,
                    serverBreakSessionId: session.id,
                    createdAt: effectiveEnd
                ))
            }
            ended = session
        }
        guard let updated, let session = ended else { return nil }
        let event = DeviceEvent(
            type: eventType,
            occurredAt: session.endedAt ?? endedAt,
            metadata: WorkModeEvents.breakMetadata(for: session, isLocal: isLocal, reason: eventReason)
        )
        _ = try? outbox.append(event)
        return Closure(session: session, isLocal: isLocal, event: event, state: updated)
    }

    /// The device-reportable end reason for a `BreakEndReason` (`POST /breaks/:id/end` accepts three values).
    public static func mobileReason(for reason: BreakEndReason) -> MobileBreakEndReason {
        switch reason {
        case .expired: return .expired
        case .shiftEnded: return .shiftEnded
        case .employeeEnded, .managerEnded, .policyChanged: return .employeeEnded
        }
    }

    /// The BREAK_* event type implied by an end reason: an expiry at the planned end is `BREAK_EXPIRED`, every
    /// other end is `BREAK_ENDED` (same rule as `diffStates`).
    public static func eventType(for reason: BreakEndReason) -> ActivityEventType {
        switch reason {
        case .expired: return .breakExpired
        case .shiftEnded, .employeeEnded, .managerEnded, .policyChanged: return .breakEnded
        }
    }

    /// Closes the cached active break when its time is up at `now` (its planned end has passed, or the end of its
    /// own shift has, or the shift is no longer scheduled). Returns nil when the break is still running or none
    /// is recorded. Used by the app when it is alive at the boundary, and by the monitor extension otherwise.
    @discardableResult
    public func closeExpiredBreak(in state: CachedState, shifts: [Shift], now: Date, eventReason: String) -> Closure? {
        guard let session = state.activeBreakSession, session.status == .active, session.endedAt == nil else { return nil }
        let shiftRef = WorkModeEngine.normaliseShifts(shifts).first { $0.id == session.shiftId }
        guard let shiftRef else {
            // The shift was cancelled or removed since the break started: the break has nothing to belong to.
            return endActiveBreak(matching: session.clientBreakId, endedAt: now, reason: .shiftEnded, eventType: .breakEnded, eventReason: eventReason)
        }
        guard let closure = BreakRules.expiredBreakSessionClosures(shift: shiftRef, sessions: [session], now: now).first else {
            return nil
        }
        return endActiveBreak(
            matching: session.clientBreakId,
            endedAt: closure.endedAt,
            reason: closure.endReason,
            eventType: BreakLedger.eventType(for: closure.endReason),
            eventReason: eventReason
        )
    }
}
