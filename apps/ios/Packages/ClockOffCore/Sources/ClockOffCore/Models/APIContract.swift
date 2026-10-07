import Foundation

// Request and response bodies of the mobile API (`/api/mobile/v1`, §5). Mirrors
// `packages/validation/src/mobile.ts`.
//
// PRIVACY (§12): request bodies are STRICT on the server — unknown keys are rejected — and may only carry
// the operational fields listed in docs/PRIVACY.md. Do not add a stored property to a request type without
// changing `DEVICE_TO_SERVER_ALLOWED_FIELDS` in packages/shared first. Nil optionals are omitted on encode.

// MARK: - Join

/// `POST /join/lookup` body.
public struct JoinLookupRequest: Codable, Equatable, Sendable {
    /// Canonical company code, e.g. `BREW-4821` (see `CompanyCode.normalise`).
    public var companyCode: String
    public var firstName: String
    public var lastName: String
    /// Per-employee invite ("employee") code; required by the server only when names are ambiguous.
    public var inviteCode: String?

    public init(companyCode: String, firstName: String, lastName: String, inviteCode: String? = nil) {
        self.companyCode = companyCode
        self.firstName = firstName
        self.lastName = lastName
        self.inviteCode = inviteCode
    }
}

/// `JoinMatchResult`.
public enum JoinMatchResult: String, Codable, CaseIterable, Sendable {
    case single = "SINGLE"
    case noMatch = "NONE"
    case ambiguous = "AMBIGUOUS"
}

/// `JoinLookupResponse.employeePreview` — shown on "Confirm it's you".
public struct EmployeePreview: Codable, Equatable, Sendable {
    public var id: String
    public var firstName: String
    public var lastName: String
    public var jobTitle: String?
    public var locationName: String?

    public init(id: String, firstName: String, lastName: String, jobTitle: String? = nil, locationName: String? = nil) {
        self.id = id
        self.firstName = firstName
        self.lastName = lastName
        self.jobTitle = jobTitle
        self.locationName = locationName
    }

    public var fullName: String {
        [firstName, lastName].filter { !$0.isEmpty }.joined(separator: " ")
    }
}

/// `POST /join/lookup` response.
public struct JoinLookupResponse: Codable, Equatable, Sendable {
    public struct OrganisationName: Codable, Equatable, Sendable {
        public var name: String

        public init(name: String) {
            self.name = name
        }
    }

    public var organisation: OrganisationName
    /// AMBIGUOUS → ask for the employee (invite) code and look up again. NONE → ask the manager.
    public var match: JoinMatchResult
    /// Present only when `match` is SINGLE.
    public var employeePreview: EmployeePreview?

    public init(organisation: OrganisationName, match: JoinMatchResult, employeePreview: EmployeePreview?) {
        self.organisation = organisation
        self.match = match
        self.employeePreview = employeePreview
    }
}

/// `MobileDeviceInfo` — generic, non-identifying device facts sent once when joining.
public struct MobileDeviceInfo: Codable, Equatable, Sendable {
    public var platform: DevicePlatform
    /// e.g. `1.2.0`.
    public var appVersion: String
    /// e.g. `17.5.1`.
    public var osVersion: String
    /// Generic model family only, e.g. `iPhone` — never a name, serial number or identifier.
    public var model: String

    public init(platform: DevicePlatform = .ios, appVersion: String, osVersion: String, model: String) {
        self.platform = platform
        self.appVersion = appVersion
        self.osVersion = osVersion
        self.model = model
    }
}

/// `POST /join/confirm` body. Re-sends the lookup inputs plus the previewed employee id.
public struct JoinConfirmRequest: Codable, Equatable, Sendable {
    public var companyCode: String
    public var employeeId: String
    public var firstName: String
    public var lastName: String
    public var inviteCode: String?
    public var device: MobileDeviceInfo

    public init(companyCode: String, employeeId: String, firstName: String, lastName: String, inviteCode: String? = nil, device: MobileDeviceInfo) {
        self.companyCode = companyCode
        self.employeeId = employeeId
        self.firstName = firstName
        self.lastName = lastName
        self.inviteCode = inviteCode
        self.device = device
    }
}

/// Access + refresh token pair (`MobileTokens`). Stored only in the Keychain.
public struct TokenPair: Codable, Equatable, Sendable {
    /// HS256 JWT, ~15 minutes. Sent as `Authorization: Bearer <token>`.
    public var accessToken: String
    /// Opaque, single-use; every refresh returns a new one.
    public var refreshToken: String
    public var accessTokenExpiresAt: Date
    public var refreshTokenExpiresAt: Date

    public init(accessToken: String, refreshToken: String, accessTokenExpiresAt: Date, refreshTokenExpiresAt: Date) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.accessTokenExpiresAt = accessTokenExpiresAt
        self.refreshTokenExpiresAt = refreshTokenExpiresAt
    }
}

/// `POST /join/confirm` response: the token pair (flattened) plus who/where the phone is now linked to.
public struct JoinConfirmResponse: Codable, Equatable, Sendable {
    public var accessToken: String
    public var refreshToken: String
    public var accessTokenExpiresAt: Date
    public var refreshTokenExpiresAt: Date
    public var deviceId: String
    public var employee: Employee
    public var organisation: Organisation

    public init(tokens: TokenPair, deviceId: String, employee: Employee, organisation: Organisation) {
        accessToken = tokens.accessToken
        refreshToken = tokens.refreshToken
        accessTokenExpiresAt = tokens.accessTokenExpiresAt
        refreshTokenExpiresAt = tokens.refreshTokenExpiresAt
        self.deviceId = deviceId
        self.employee = employee
        self.organisation = organisation
    }

    public var tokens: TokenPair {
        TokenPair(
            accessToken: accessToken,
            refreshToken: refreshToken,
            accessTokenExpiresAt: accessTokenExpiresAt,
            refreshTokenExpiresAt: refreshTokenExpiresAt
        )
    }
}

// MARK: - Auth

/// `POST /auth/refresh` body.
public struct RefreshTokenRequest: Codable, Equatable, Sendable {
    public var refreshToken: String

    public init(refreshToken: String) {
        self.refreshToken = refreshToken
    }
}

/// `POST /auth/logout` body.
public struct LogoutRequest: Codable, Equatable, Sendable {
    public var refreshToken: String?

    public init(refreshToken: String?) {
        self.refreshToken = refreshToken
    }
}

/// Empty JSON object body (`emptyBodySchema`), e.g. `POST /leave-workplace`.
public struct EmptyRequest: Codable, Equatable, Sendable {
    public init() {}
}

/// `{ ok: true }` responses. Tolerates any body (including none).
public struct OkResponse: Codable, Equatable, Sendable {
    public var ok: Bool

    public init(ok: Bool = true) {
        self.ok = ok
    }

    private enum CodingKeys: String, CodingKey { case ok }

    public init(from decoder: Decoder) throws {
        let c = try? decoder.container(keyedBy: CodingKeys.self)
        ok = (try? c?.decodeIfPresent(Bool.self, forKey: .ok)) ?? true
    }
}

// MARK: - Me & schedule

/// `GET /me` response.
public struct MeResponse: Codable, Equatable, Sendable {
    public var employee: Employee
    public var organisation: Organisation
    public var deviceId: String
    public var resolvedPolicy: PolicySummary?
    public var resolvedBreakPolicy: BreakPolicy?
    public var policyVersion: String?
    public var scheduleVersion: Int

    public init(
        employee: Employee,
        organisation: Organisation,
        deviceId: String,
        resolvedPolicy: PolicySummary? = nil,
        resolvedBreakPolicy: BreakPolicy? = nil,
        policyVersion: String? = nil,
        scheduleVersion: Int = 0
    ) {
        self.employee = employee
        self.organisation = organisation
        self.deviceId = deviceId
        self.resolvedPolicy = resolvedPolicy
        self.resolvedBreakPolicy = resolvedBreakPolicy
        self.policyVersion = policyVersion
        self.scheduleVersion = scheduleVersion
    }
}

/// `GET /schedule?from&to` response.
public struct ScheduleResponse: Codable, Equatable, Sendable {
    public var from: Date
    public var to: Date
    public var shifts: [Shift]
    public var scheduleVersion: Int
    public var serverTime: Date

    public init(from: Date, to: Date, shifts: [Shift], scheduleVersion: Int, serverTime: Date) {
        self.from = from
        self.to = to
        self.shifts = shifts
        self.scheduleVersion = scheduleVersion
        self.serverTime = serverTime
    }
}

// MARK: - Sync

/// `GET /sync` response — everything the device needs to schedule DeviceActivity intervals offline.
public struct SyncBundle: Codable, Equatable, Sendable {
    public var policy: PolicySummary?
    public var breakPolicy: BreakPolicy?
    /// Shifts from 1 day ago to 14 days ahead.
    public var shifts: [Shift]
    /// PolicyVersion id in force (nil when no published policy resolves).
    public var policyVersion: String?
    /// Monotonic per-employee schedule version.
    public var scheduleVersion: Int
    public var serverTime: Date
    public var activeOverrides: [ActiveOverride]
    /// Server-computed state (the server's view; the device computes its own with `WorkModeEngine`).
    public var expectedState: ExpectedState?
    public var activeBreakSession: BreakSession?
    public var breakAllowance: BreakAllowance?

    public init(
        policy: PolicySummary? = nil,
        breakPolicy: BreakPolicy? = nil,
        shifts: [Shift] = [],
        policyVersion: String? = nil,
        scheduleVersion: Int = 0,
        serverTime: Date,
        activeOverrides: [ActiveOverride] = [],
        expectedState: ExpectedState? = nil,
        activeBreakSession: BreakSession? = nil,
        breakAllowance: BreakAllowance? = nil
    ) {
        self.policy = policy
        self.breakPolicy = breakPolicy
        self.shifts = shifts
        self.policyVersion = policyVersion
        self.scheduleVersion = scheduleVersion
        self.serverTime = serverTime
        self.activeOverrides = activeOverrides
        self.expectedState = expectedState
        self.activeBreakSession = activeBreakSession
        self.breakAllowance = breakAllowance
    }

    private enum CodingKeys: String, CodingKey {
        case policy, breakPolicy, shifts, policyVersion, scheduleVersion, serverTime, activeOverrides
        case expectedState, activeBreakSession, breakAllowance
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        policy = try c.decodeIfPresent(PolicySummary.self, forKey: .policy)
        breakPolicy = try c.decodeIfPresent(BreakPolicy.self, forKey: .breakPolicy)
        shifts = try c.decodeIfPresent([Shift].self, forKey: .shifts) ?? []
        policyVersion = try c.decodeIfPresent(String.self, forKey: .policyVersion)
        scheduleVersion = try c.decodeIfPresent(Int.self, forKey: .scheduleVersion) ?? 0
        serverTime = try c.decode(Date.self, forKey: .serverTime)
        // An override type this build does not know cannot be interpreted; skip it rather than fail the sync.
        activeOverrides = try c.decodeLossyArray(ActiveOverride.self, forKey: .activeOverrides)
        expectedState = try? c.decodeIfPresent(ExpectedState.self, forKey: .expectedState)
        activeBreakSession = try c.decodeIfPresent(BreakSession.self, forKey: .activeBreakSession)
        breakAllowance = try? c.decodeIfPresent(BreakAllowance.self, forKey: .breakAllowance)
    }
}

// MARK: - Device state

/// `selectionCounts` — numbers only; never which apps, categories or websites.
public struct SelectionCounts: Codable, Equatable, Sendable {
    public var categories: Int
    public var applications: Int
    public var webDomains: Int

    public init(categories: Int, applications: Int, webDomains: Int) {
        self.categories = categories
        self.applications = applications
        self.webDomains = webDomains
    }

    public static let zero = SelectionCounts(categories: 0, applications: 0, webDomains: 0)

    public var total: Int { categories + applications + webDomains }
}

/// `POST /device/state` body — the periodic compliance check-in.
public struct DeviceStateReport: Codable, Equatable, Sendable {
    public var permissionState: PermissionState
    public var selectionState: SelectionState
    public var selectionCounts: SelectionCounts?
    public var restrictionEngineState: WorkModeState
    public var appVersion: String
    public var osVersion: String
    /// PolicyVersion id the device has applied.
    public var policyVersionApplied: String?
    public var scheduleVersionApplied: Int?
    /// Device clock at send time; the server stores only the skew.
    public var localTime: Date
    /// IANA zone identifier, e.g. `Europe/London`.
    public var timezone: String

    public init(
        permissionState: PermissionState,
        selectionState: SelectionState,
        selectionCounts: SelectionCounts? = nil,
        restrictionEngineState: WorkModeState,
        appVersion: String,
        osVersion: String,
        policyVersionApplied: String? = nil,
        scheduleVersionApplied: Int? = nil,
        localTime: Date,
        timezone: String
    ) {
        self.permissionState = permissionState
        self.selectionState = selectionState
        self.selectionCounts = selectionCounts
        self.restrictionEngineState = restrictionEngineState
        self.appVersion = appVersion
        self.osVersion = osVersion
        self.policyVersionApplied = policyVersionApplied
        self.scheduleVersionApplied = scheduleVersionApplied
        self.localTime = localTime
        self.timezone = timezone
    }
}

/// `POST /device/state` response.
public struct DeviceStateResponse: Codable, Equatable, Sendable {
    public var serverTime: Date
    /// device − server, whole seconds (positive = device clock ahead).
    public var clockSkewSeconds: Int
    public var expectedState: ExpectedState?

    public init(serverTime: Date, clockSkewSeconds: Int, expectedState: ExpectedState? = nil) {
        self.serverTime = serverTime
        self.clockSkewSeconds = clockSkewSeconds
        self.expectedState = expectedState
    }

    private enum CodingKeys: String, CodingKey { case serverTime, clockSkewSeconds, expectedState }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        serverTime = try c.decode(Date.self, forKey: .serverTime)
        clockSkewSeconds = try c.decodeIfPresent(Int.self, forKey: .clockSkewSeconds) ?? 0
        expectedState = try? c.decodeIfPresent(ExpectedState.self, forKey: .expectedState)
    }
}

// MARK: - Events

/// `DeviceEventMetadata` — strict allow-list, no free text (`reason` is an UPPER_SNAKE_CASE code).
public struct DeviceEventMetadata: Codable, Equatable, Sendable {
    public var shiftId: String?
    public var breakSessionId: String?
    public var clientBreakId: String?
    public var policyVersion: String?
    public var scheduleVersion: Int?
    public var reason: String?
    public var engineState: WorkModeState?
    public var permissionState: PermissionState?
    public var selectionCounts: SelectionCounts?

    public init(
        shiftId: String? = nil,
        breakSessionId: String? = nil,
        clientBreakId: String? = nil,
        policyVersion: String? = nil,
        scheduleVersion: Int? = nil,
        reason: String? = nil,
        engineState: WorkModeState? = nil,
        permissionState: PermissionState? = nil,
        selectionCounts: SelectionCounts? = nil
    ) {
        self.shiftId = shiftId
        self.breakSessionId = breakSessionId
        self.clientBreakId = clientBreakId
        self.policyVersion = policyVersion
        self.scheduleVersion = scheduleVersion
        self.reason = reason
        self.engineState = engineState
        self.permissionState = permissionState
        self.selectionCounts = selectionCounts
    }
}

/// `DeviceEvent` — an enumerated operational event queued in the outbox.
public struct DeviceEvent: Codable, Equatable, Sendable, Identifiable {
    /// Device-generated idempotency key (lower-case UUID).
    public var clientEventId: String
    public var type: ActivityEventType
    public var occurredAt: Date
    public var metadata: DeviceEventMetadata?

    public init(clientEventId: String = DeviceEvent.newClientEventId(), type: ActivityEventType, occurredAt: Date, metadata: DeviceEventMetadata? = nil) {
        self.clientEventId = clientEventId.lowercased()
        self.type = type
        self.occurredAt = occurredAt
        self.metadata = metadata
    }

    public var id: String { clientEventId }

    public static func newClientEventId() -> String {
        UUID().uuidString.lowercased()
    }
}

/// `POST /events` body (1…200 events).
public struct DeviceEventsRequest: Codable, Equatable, Sendable {
    public static let maxEventsPerBatch = 200

    public var events: [DeviceEvent]

    public init(events: [DeviceEvent]) {
        self.events = events
    }
}

/// `POST /events` response.
public struct DeviceEventsResponse: Codable, Equatable, Sendable {
    public struct Rejected: Codable, Equatable, Sendable {
        public var clientEventId: String
        public var code: String

        public init(clientEventId: String, code: String) {
            self.clientEventId = clientEventId
            self.code = code
        }
    }

    public var accepted: Int
    public var duplicates: Int
    public var rejected: [Rejected]

    public init(accepted: Int, duplicates: Int, rejected: [Rejected] = []) {
        self.accepted = accepted
        self.duplicates = duplicates
        self.rejected = rejected
    }

    private enum CodingKeys: String, CodingKey { case accepted, duplicates, rejected }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        accepted = try c.decodeIfPresent(Int.self, forKey: .accepted) ?? 0
        duplicates = try c.decodeIfPresent(Int.self, forKey: .duplicates) ?? 0
        rejected = try c.decodeIfPresent([Rejected].self, forKey: .rejected) ?? []
    }
}

// MARK: - Breaks

/// `POST /breaks/start` body. Idempotent on `clientBreakId`.
public struct StartBreakRequest: Codable, Equatable, Sendable {
    public var clientBreakId: String
    public var shiftId: String
    /// Device time of the tap.
    public var requestedAt: Date
    /// Defaults to the policy's maxBreakDurationMinutes.
    public var requestedDurationMinutes: Int?

    public init(clientBreakId: String = UUID().uuidString.lowercased(), shiftId: String, requestedAt: Date, requestedDurationMinutes: Int? = nil) {
        self.clientBreakId = clientBreakId.lowercased()
        self.shiftId = shiftId
        self.requestedAt = requestedAt
        self.requestedDurationMinutes = requestedDurationMinutes
    }
}

/// `POST /breaks/:id/end` body.
public struct EndBreakRequest: Codable, Equatable, Sendable {
    public var endedAt: Date
    public var reason: MobileBreakEndReason

    public init(endedAt: Date, reason: MobileBreakEndReason) {
        self.endedAt = endedAt
        self.reason = reason
    }
}

/// `MobileBreakResponse`.
public struct BreakResponse: Codable, Equatable, Sendable {
    public var breakSession: BreakSession
    public var allowance: BreakAllowance?

    public init(breakSession: BreakSession, allowance: BreakAllowance?) {
        self.breakSession = breakSession
        self.allowance = allowance
    }
}

// MARK: - Push

/// `POST /device/push-token` body.
public struct PushTokenRequest: Codable, Equatable, Sendable {
    /// Hex-encoded APNs device token.
    public var token: String
    public var environment: PushEnvironment

    public init(token: String, environment: PushEnvironment) {
        self.token = token
        self.environment = environment
    }

    /// Hex-encodes an APNs device token as delivered to `didRegisterForRemoteNotificationsWithDeviceToken`.
    public static func hexString(from deviceToken: Data) -> String {
        deviceToken.map { String(format: "%02x", $0) }.joined()
    }
}
