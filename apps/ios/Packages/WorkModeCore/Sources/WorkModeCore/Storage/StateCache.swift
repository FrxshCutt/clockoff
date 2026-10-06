import Foundation

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
        outbox: [DeviceEvent] = []
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
    }

    /// True once the phone is linked to an employee (join confirmed).
    public var isJoined: Bool { organisation != nil && employee != nil }

    /// Break sessions the engine should consider (the server sends only the active one).
    public var breakSessions: [BreakSession] {
        activeBreakSession.map { [$0] } ?? []
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
