import Foundation

/// A break the device started (or ended) without the server: queued in the App Group for the sync layer to
/// replay with the original `clientBreakId` / `requestedAt` (`POST /breaks/start`, then `POST /breaks/:id/end`
/// when `endedAt` is set). The server validates the past instant itself (docs/BREAK_RULES.md); a refusal means
/// the local break is dropped and the employee is told.
public struct QueuedBreakRecord: Codable, Equatable, Sendable, Identifiable {
    public enum Status: String, Codable, Sendable {
        /// `POST /breaks/start` has not succeeded yet.
        case pendingStart = "PENDING_START"
        /// The start is on the server (`serverBreakSessionId`); the end still has to be sent.
        case pendingEnd = "PENDING_END"
    }

    public var clientBreakId: String
    public var shiftId: String
    /// Device time of the tap (`StartBreakRequest.requestedAt`).
    public var requestedAt: Date
    public var requestedDurationMinutes: Int?
    /// The end the device computed with its cached policy (the server may shorten it).
    public var plannedEndsAt: Date
    public var status: Status
    public var endedAt: Date?
    public var endReason: MobileBreakEndReason?
    /// Set once `POST /breaks/start` succeeded.
    public var serverBreakSessionId: String?
    public var createdAt: Date

    public init(
        clientBreakId: String,
        shiftId: String,
        requestedAt: Date,
        requestedDurationMinutes: Int?,
        plannedEndsAt: Date,
        status: Status = .pendingStart,
        endedAt: Date? = nil,
        endReason: MobileBreakEndReason? = nil,
        serverBreakSessionId: String? = nil,
        createdAt: Date
    ) {
        self.clientBreakId = clientBreakId
        self.shiftId = shiftId
        self.requestedAt = requestedAt
        self.requestedDurationMinutes = requestedDurationMinutes
        self.plannedEndsAt = plannedEndsAt
        self.status = status
        self.endedAt = endedAt
        self.endReason = endReason
        self.serverBreakSessionId = serverBreakSessionId
        self.createdAt = createdAt
    }

    public var id: String { clientBreakId }
}

/// Everything the device needs to keep enforcing Work Mode offline, persisted in the App Group container
/// as `state.json`. Holds employer data and operational status only — never tokens (Keychain) and never
/// anything about how the phone is used.
public struct CachedState: Codable, Equatable, Sendable {
    public static let currentSchemaVersion = 1

    public var schemaVersion: Int
    public var organisation: Organisation?
    public var employee: Employee?
    public var deviceId: String?
    public var policy: PolicySummary?
    public var breakPolicy: BreakPolicy?
    public var shifts: [Shift]
    public var scheduleVersion: Int?
    /// PolicyVersion id applied on this device (nil when none resolved).
    public var policyVersion: String?
    public var activeBreakSession: BreakSession?
    public var activeOverrides: [ActiveOverride]
    public var breakAllowance: BreakAllowance?
    public var lastSyncAt: Date?
    public var lastPolicySyncAt: Date?
    public var lastScheduleSyncAt: Date?
    public var lastDeviceStateReportAt: Date?
    /// Code of the last sync failure (nil after a successful sync).
    public var lastSyncErrorCode: String?
    /// device − server clock difference from the last `/device/state` response.
    public var clockSkewSeconds: Int?
    public var engineState: RestrictionEngineState?
    /// Last permission state reported, used to tell a revocation from a first denial.
    public var lastPermissionState: PermissionState?
    public var setupCompletedAt: Date?
    /// Append-only queue of events awaiting `POST /events` (see `EventOutbox`).
    public var outbox: [DeviceEvent]
    /// Breaks started or ended on the device while the API was unreachable, awaiting replay (see `QueuedBreakRecord`).
    public var queuedBreaks: [QueuedBreakRecord]
    /// When `WorkModeController.reconcile` last ran.
    public var lastReconcileAt: Date?

    public init(
        organisation: Organisation? = nil,
        employee: Employee? = nil,
        deviceId: String? = nil,
        policy: PolicySummary? = nil,
        breakPolicy: BreakPolicy? = nil,
        shifts: [Shift] = [],
        scheduleVersion: Int? = nil,
        policyVersion: String? = nil,
        activeBreakSession: BreakSession? = nil,
        activeOverrides: [ActiveOverride] = [],
        breakAllowance: BreakAllowance? = nil,
        lastSyncAt: Date? = nil,
        lastPolicySyncAt: Date? = nil,
        lastScheduleSyncAt: Date? = nil,
        lastDeviceStateReportAt: Date? = nil,
        lastSyncErrorCode: String? = nil,
        clockSkewSeconds: Int? = nil,
        engineState: RestrictionEngineState? = nil,
        lastPermissionState: PermissionState? = nil,
        setupCompletedAt: Date? = nil,
        outbox: [DeviceEvent] = [],
        queuedBreaks: [QueuedBreakRecord] = [],
        lastReconcileAt: Date? = nil
    ) {
        schemaVersion = CachedState.currentSchemaVersion
        self.organisation = organisation
        self.employee = employee
        self.deviceId = deviceId
        self.policy = policy
        self.breakPolicy = breakPolicy
        self.shifts = shifts
        self.scheduleVersion = scheduleVersion
        self.policyVersion = policyVersion
        self.activeBreakSession = activeBreakSession
        self.activeOverrides = activeOverrides
        self.breakAllowance = breakAllowance
        self.lastSyncAt = lastSyncAt
        self.lastPolicySyncAt = lastPolicySyncAt
        self.lastScheduleSyncAt = lastScheduleSyncAt
        self.lastDeviceStateReportAt = lastDeviceStateReportAt
        self.lastSyncErrorCode = lastSyncErrorCode
        self.clockSkewSeconds = clockSkewSeconds
        self.engineState = engineState
        self.lastPermissionState = lastPermissionState
        self.setupCompletedAt = setupCompletedAt
        self.outbox = outbox
        self.queuedBreaks = queuedBreaks
        self.lastReconcileAt = lastReconcileAt
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, organisation, employee, deviceId, policy, breakPolicy, shifts, scheduleVersion, policyVersion
        case activeBreakSession, activeOverrides, breakAllowance, lastSyncAt, lastPolicySyncAt, lastScheduleSyncAt
        case lastDeviceStateReportAt, lastSyncErrorCode, clockSkewSeconds, engineState, lastPermissionState, setupCompletedAt
        case outbox, queuedBreaks, lastReconcileAt
    }

    /// Tolerant of keys added later (a file written by an older build must still load).
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try c.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? CachedState.currentSchemaVersion
        organisation = try c.decodeIfPresent(Organisation.self, forKey: .organisation)
        employee = try c.decodeIfPresent(Employee.self, forKey: .employee)
        deviceId = try c.decodeIfPresent(String.self, forKey: .deviceId)
        policy = try c.decodeIfPresent(PolicySummary.self, forKey: .policy)
        breakPolicy = try c.decodeIfPresent(BreakPolicy.self, forKey: .breakPolicy)
        shifts = try c.decodeIfPresent([Shift].self, forKey: .shifts) ?? []
        scheduleVersion = try c.decodeIfPresent(Int.self, forKey: .scheduleVersion)
        policyVersion = try c.decodeIfPresent(String.self, forKey: .policyVersion)
        activeBreakSession = try c.decodeIfPresent(BreakSession.self, forKey: .activeBreakSession)
        activeOverrides = try c.decodeIfPresent([ActiveOverride].self, forKey: .activeOverrides) ?? []
        breakAllowance = try c.decodeIfPresent(BreakAllowance.self, forKey: .breakAllowance)
        lastSyncAt = try c.decodeIfPresent(Date.self, forKey: .lastSyncAt)
        lastPolicySyncAt = try c.decodeIfPresent(Date.self, forKey: .lastPolicySyncAt)
        lastScheduleSyncAt = try c.decodeIfPresent(Date.self, forKey: .lastScheduleSyncAt)
        lastDeviceStateReportAt = try c.decodeIfPresent(Date.self, forKey: .lastDeviceStateReportAt)
        lastSyncErrorCode = try c.decodeIfPresent(String.self, forKey: .lastSyncErrorCode)
        clockSkewSeconds = try c.decodeIfPresent(Int.self, forKey: .clockSkewSeconds)
        engineState = try c.decodeIfPresent(RestrictionEngineState.self, forKey: .engineState)
        lastPermissionState = try c.decodeIfPresent(PermissionState.self, forKey: .lastPermissionState)
        setupCompletedAt = try c.decodeIfPresent(Date.self, forKey: .setupCompletedAt)
        outbox = try c.decodeIfPresent([DeviceEvent].self, forKey: .outbox) ?? []
        queuedBreaks = try c.decodeIfPresent([QueuedBreakRecord].self, forKey: .queuedBreaks) ?? []
        lastReconcileAt = try c.decodeIfPresent(Date.self, forKey: .lastReconcileAt)
    }

    /// True once the phone is linked to an employee (join confirmed).
    public var isJoined: Bool { organisation != nil && employee != nil }

    /// Break sessions the engine should consider (the server sends only the active one).
    public var breakSessions: [BreakSession] {
        activeBreakSession.map { [$0] } ?? []
    }

    /// The queued record of a break that has not reached the server yet, if `session` is such a break.
    public func queuedBreak(for session: BreakSession) -> QueuedBreakRecord? {
        queuedBreaks.first { $0.clientBreakId.lowercased() == session.clientBreakId.lowercased() }
    }

    /// True when `session` exists only on this device so far (its id is the client break id).
    public func isLocalBreak(_ session: BreakSession) -> Bool {
        guard let record = queuedBreak(for: session) else { return session.id.lowercased() == session.clientBreakId.lowercased() }
        return record.serverBreakSessionId == nil
    }
}

/// Atomic load/save of `CachedState` in the App Group container.
public final class StateCache {
    public static let defaultFileName = "state.json"

    private let fileStore: AppGroupFileStore
    private let fileName: String

    public init(fileStore: AppGroupFileStore, fileName: String = StateCache.defaultFileName) {
        self.fileStore = fileStore
        self.fileName = fileName
    }

    /// The cached state, or nil when nothing is cached. A file that no longer decodes (schema change,
    /// corruption) is treated as absent: the next sync rebuilds it.
    public func load() -> CachedState? {
        do {
            guard let data = try fileStore.read(fileName) else { return nil }
            return try decode(data)
        } catch {
            WorkModeLog.storage.error("state cache unreadable: \(String(describing: error), privacy: .public)")
            return nil
        }
    }

    public func save(_ state: CachedState) throws {
        try fileStore.write(try JSONEncoder.workMode.encode(state), to: fileName)
    }

    /// Coordinated read-modify-write starting from the cached state (or an empty one). Returns the saved state.
    @discardableResult
    public func update(_ mutate: (inout CachedState) throws -> Void) throws -> CachedState {
        var saved = CachedState()
        try fileStore.update(fileName) { data in
            var state = (data.flatMap { try? self.decode($0) }) ?? CachedState()
            try mutate(&state)
            state.schemaVersion = CachedState.currentSchemaVersion
            saved = state
            return try JSONEncoder.workMode.encode(state)
        }
        return saved
    }

    /// Deletes the cache (Leave Workplace / Sign Out).
    public func wipe() throws {
        try fileStore.delete(fileName)
    }

    private func decode(_ data: Data) throws -> CachedState {
        try JSONDecoder.workMode.decode(CachedState.self, from: data)
    }
}
