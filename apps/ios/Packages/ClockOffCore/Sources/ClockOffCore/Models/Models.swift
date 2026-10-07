import Foundation

// Resource models mirroring the mobile API (`packages/validation/src/mobile.ts`, `workState.ts`).
// JSON keys are the API's camelCase keys verbatim. Responses are additive: unknown keys are ignored.

/// `{ id, name }` reference (`NamedRef`).
public struct NamedRef: Codable, Equatable, Hashable, Sendable {
    public var id: String
    public var name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

/// `MobileOrganisation`.
public struct Organisation: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    /// IANA zone of the organisation (display only — every instant is UTC).
    public var timezone: String

    public init(id: String, name: String, timezone: String) {
        self.id = id
        self.name = name
        self.timezone = timezone
    }
}

/// `MobileEmployee.primaryLocation`.
public struct EmployeeLocation: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var timezone: String?

    public init(id: String, name: String, timezone: String? = nil) {
        self.id = id
        self.name = name
        self.timezone = timezone
    }
}

/// `MobileEmployee`.
public struct Employee: Codable, Equatable, Sendable {
    public var id: String
    public var firstName: String
    public var lastName: String
    public var jobTitle: String?
    public var primaryLocation: EmployeeLocation?

    public init(id: String, firstName: String, lastName: String, jobTitle: String? = nil, primaryLocation: EmployeeLocation? = nil) {
        self.id = id
        self.firstName = firstName
        self.lastName = lastName
        self.jobTitle = jobTitle
        self.primaryLocation = primaryLocation
    }

    public var fullName: String {
        [firstName, lastName].filter { !$0.isEmpty }.joined(separator: " ")
    }
}

/// `PolicyVersion.restriction_config` (`RestrictionConfig`).
public struct RestrictionConfig: Codable, Equatable, Sendable {
    public static let defaultPreShiftWarningMinutes = 15

    /// Categories restricted while Work Mode is active.
    public var categories: [RestrictionCategory]
    /// When true the employee picks the apps/categories to shield on their own phone.
    public var requireEmployeeAppSelection: Bool
    /// Notes shown to employees about what is always allowed (e.g. "Phone, Messages, Maps").
    public var alwaysAllowedNote: [String]
    /// Message shown on the shield screen.
    public var shieldMessage: String?
    public var activationMode: ActivationMode
    /// Minutes before a shift at which the device shows "starting soon" (0 disables).
    public var preShiftWarningMinutes: Int

    public init(
        categories: [RestrictionCategory],
        requireEmployeeAppSelection: Bool = true,
        alwaysAllowedNote: [String] = [],
        shieldMessage: String? = nil,
        activationMode: ActivationMode = .scheduled,
        preShiftWarningMinutes: Int = RestrictionConfig.defaultPreShiftWarningMinutes
    ) {
        self.categories = categories
        self.requireEmployeeAppSelection = requireEmployeeAppSelection
        self.alwaysAllowedNote = alwaysAllowedNote
        self.shieldMessage = shieldMessage
        self.activationMode = activationMode
        self.preShiftWarningMinutes = preShiftWarningMinutes
    }

    private enum CodingKeys: String, CodingKey {
        case categories, requireEmployeeAppSelection, alwaysAllowedNote, shieldMessage, activationMode, preShiftWarningMinutes
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        categories = try c.decodeCategories(forKey: .categories)
        requireEmployeeAppSelection = try c.decodeIfPresent(Bool.self, forKey: .requireEmployeeAppSelection) ?? true
        alwaysAllowedNote = try c.decodeIfPresent([String].self, forKey: .alwaysAllowedNote) ?? []
        shieldMessage = try c.decodeIfPresent(String.self, forKey: .shieldMessage)
        activationMode = try c.decodeIfPresent(ActivationMode.self, forKey: .activationMode) ?? .scheduled
        preShiftWarningMinutes = max(0, try c.decodeIfPresent(Int.self, forKey: .preShiftWarningMinutes) ?? RestrictionConfig.defaultPreShiftWarningMinutes)
    }
}

/// `MobileResolvedPolicy` — the Work Policy version in force for this employee.
public struct PolicySummary: Codable, Equatable, Sendable {
    public struct VersionRef: Codable, Equatable, Sendable {
        public var id: String
        public var versionNumber: Int

        public init(id: String, versionNumber: Int) {
            self.id = id
            self.versionNumber = versionNumber
        }
    }

    public var policy: NamedRef
    public var version: VersionRef
    public var restrictionConfig: RestrictionConfig

    public init(policy: NamedRef, version: VersionRef, restrictionConfig: RestrictionConfig) {
        self.policy = policy
        self.version = version
        self.restrictionConfig = restrictionConfig
    }

    /// The PolicyVersion id: the "policy version token" the device echoes back once applied.
    public var policyVersionId: String { version.id }
}

/// Break rules (`BreakPolicyRules`).
public struct BreakPolicyRules: Codable, Equatable, Sendable {
    public var breaksEnabled: Bool
    public var maxBreaksPerShift: Int
    public var maxBreakDurationMinutes: Int
    public var maxTotalBreakMinutes: Int
    public var minGapBetweenBreaksMinutes: Int
    public var minMinutesAfterShiftStart: Int
    public var employeeTriggeredAllowed: Bool
    public var scheduledBreaksAllowed: Bool
    public var restrictionBehaviour: BreakRestrictionBehaviour
    /// Categories relaxed during a break when `restrictionBehaviour` is RELAX_CATEGORIES.
    public var relaxedCategories: [RestrictionCategory]

    public init(
        breaksEnabled: Bool = true,
        maxBreaksPerShift: Int = 2,
        maxBreakDurationMinutes: Int = 15,
        maxTotalBreakMinutes: Int = 30,
        minGapBetweenBreaksMinutes: Int = 60,
        minMinutesAfterShiftStart: Int = 60,
        employeeTriggeredAllowed: Bool = true,
        scheduledBreaksAllowed: Bool = true,
        restrictionBehaviour: BreakRestrictionBehaviour = .relaxAll,
        relaxedCategories: [RestrictionCategory] = []
    ) {
        self.breaksEnabled = breaksEnabled
        self.maxBreaksPerShift = maxBreaksPerShift
        self.maxBreakDurationMinutes = maxBreakDurationMinutes
        self.maxTotalBreakMinutes = maxTotalBreakMinutes
        self.minGapBetweenBreaksMinutes = minGapBetweenBreaksMinutes
        self.minMinutesAfterShiftStart = minMinutesAfterShiftStart
        self.employeeTriggeredAllowed = employeeTriggeredAllowed
        self.scheduledBreaksAllowed = scheduledBreaksAllowed
        self.restrictionBehaviour = restrictionBehaviour
        self.relaxedCategories = relaxedCategories
    }

    private enum CodingKeys: String, CodingKey {
        case breaksEnabled, maxBreaksPerShift, maxBreakDurationMinutes, maxTotalBreakMinutes
        case minGapBetweenBreaksMinutes, minMinutesAfterShiftStart, employeeTriggeredAllowed
        case scheduledBreaksAllowed, restrictionBehaviour, relaxedCategories
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        breaksEnabled = try c.decode(Bool.self, forKey: .breaksEnabled)
        maxBreaksPerShift = try c.decode(Int.self, forKey: .maxBreaksPerShift)
        maxBreakDurationMinutes = try c.decode(Int.self, forKey: .maxBreakDurationMinutes)
        maxTotalBreakMinutes = try c.decode(Int.self, forKey: .maxTotalBreakMinutes)
        minGapBetweenBreaksMinutes = try c.decode(Int.self, forKey: .minGapBetweenBreaksMinutes)
        minMinutesAfterShiftStart = try c.decode(Int.self, forKey: .minMinutesAfterShiftStart)
        employeeTriggeredAllowed = try c.decode(Bool.self, forKey: .employeeTriggeredAllowed)
        scheduledBreaksAllowed = try c.decode(Bool.self, forKey: .scheduledBreaksAllowed)
        restrictionBehaviour = try c.decode(BreakRestrictionBehaviour.self, forKey: .restrictionBehaviour)
        relaxedCategories = try c.decodeCategories(forKey: .relaxedCategories)
    }
}

/// `MobileBreakPolicy`.
public struct BreakPolicy: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var rules: BreakPolicyRules

    public init(id: String, name: String, rules: BreakPolicyRules) {
        self.id = id
        self.name = name
        self.rules = rules
    }
}

/// `MobileScheduledBreak` — a planned break inside a shift, with absolute instants resolved by the server.
public struct ScheduledBreak: Codable, Equatable, Sendable {
    public var id: String
    public var offsetMinutesFromStart: Int
    public var durationMinutes: Int
    public var startsAt: Date
    public var endsAt: Date

    public init(id: String, offsetMinutesFromStart: Int, durationMinutes: Int, startsAt: Date, endsAt: Date) {
        self.id = id
        self.offsetMinutesFromStart = offsetMinutesFromStart
        self.durationMinutes = durationMinutes
        self.startsAt = startsAt
        self.endsAt = endsAt
    }
}

/// `MobileShift`. Instants are UTC; `timezone` is the zone the shift was created in (display only).
public struct Shift: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var startsAt: Date
    public var endsAt: Date
    public var timezone: String
    public var status: ShiftStatus
    public var location: NamedRef?
    public var notes: String?
    /// Per-shift version; changes whenever the shift is edited.
    public var version: Int
    public var scheduledBreaks: [ScheduledBreak]
    /// Soft-deletion instant. The API never sends deleted shifts; the field exists so the engine can be fed
    /// the shared fixtures (`WorkModeShiftLike.deletedAt`) and ignores such rows exactly like the TS machine.
    public var deletedAt: Date?

    public init(
        id: String,
        startsAt: Date,
        endsAt: Date,
        timezone: String,
        status: ShiftStatus = .scheduled,
        location: NamedRef? = nil,
        notes: String? = nil,
        version: Int = 1,
        scheduledBreaks: [ScheduledBreak] = [],
        deletedAt: Date? = nil
    ) {
        self.id = id
        self.startsAt = startsAt
        self.endsAt = endsAt
        self.timezone = timezone
        self.status = status
        self.location = location
        self.notes = notes
        self.version = version
        self.scheduledBreaks = scheduledBreaks
        self.deletedAt = deletedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, startsAt, endsAt, timezone, status, location, notes, version, scheduledBreaks, deletedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        startsAt = try c.decode(Date.self, forKey: .startsAt)
        endsAt = try c.decode(Date.self, forKey: .endsAt)
        timezone = try c.decode(String.self, forKey: .timezone)
        status = try c.decode(ShiftStatus.self, forKey: .status)
        location = try c.decodeIfPresent(NamedRef.self, forKey: .location)
        notes = try c.decodeIfPresent(String.self, forKey: .notes)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        scheduledBreaks = try c.decodeIfPresent([ScheduledBreak].self, forKey: .scheduledBreaks) ?? []
        deletedAt = try c.decodeIfPresent(Date.self, forKey: .deletedAt)
    }

    /// SCHEDULED, non-deleted shifts with a positive length are the only ones ClockOff acts on (§6.2).
    public var isEffective: Bool {
        guard deletedAt == nil else { return false }
        switch status {
        case .scheduled:
            return endsAt > startsAt
        case .cancelled, .completed:
            return false
        }
    }
}

/// `BreakSession` (server row as seen by the device).
public struct BreakSession: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    /// Idempotency key generated on the device.
    public var clientBreakId: String
    public var shiftId: String
    public var startedAt: Date
    /// Absolute UTC end; relaxation lifts at this instant even if the app is closed.
    public var plannedEndsAt: Date
    public var endedAt: Date?
    public var status: BreakSessionStatus
    public var endReason: BreakEndReason?
    /// Behaviour snapshot taken when the break started.
    public var restrictionBehaviour: BreakRestrictionBehaviour
    public var relaxedCategories: [RestrictionCategory]

    public init(
        id: String,
        clientBreakId: String,
        shiftId: String,
        startedAt: Date,
        plannedEndsAt: Date,
        endedAt: Date? = nil,
        status: BreakSessionStatus = .active,
        endReason: BreakEndReason? = nil,
        restrictionBehaviour: BreakRestrictionBehaviour = .relaxAll,
        relaxedCategories: [RestrictionCategory] = []
    ) {
        self.id = id
        self.clientBreakId = clientBreakId
        self.shiftId = shiftId
        self.startedAt = startedAt
        self.plannedEndsAt = plannedEndsAt
        self.endedAt = endedAt
        self.status = status
        self.endReason = endReason
        self.restrictionBehaviour = restrictionBehaviour
        self.relaxedCategories = relaxedCategories
    }

    private enum CodingKeys: String, CodingKey {
        case id, clientBreakId, shiftId, startedAt, plannedEndsAt, endedAt, status, endReason
        case restrictionBehaviour, relaxedCategories
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        clientBreakId = try c.decodeIfPresent(String.self, forKey: .clientBreakId) ?? ""
        shiftId = try c.decode(String.self, forKey: .shiftId)
        startedAt = try c.decode(Date.self, forKey: .startedAt)
        plannedEndsAt = try c.decode(Date.self, forKey: .plannedEndsAt)
        endedAt = try c.decodeIfPresent(Date.self, forKey: .endedAt)
        status = try c.decode(BreakSessionStatus.self, forKey: .status)
        endReason = try c.decodeIfPresent(BreakEndReason.self, forKey: .endReason)
        restrictionBehaviour = try c.decodeIfPresent(BreakRestrictionBehaviour.self, forKey: .restrictionBehaviour) ?? .relaxAll
        relaxedCategories = try c.decodeCategories(forKey: .relaxedCategories)
    }
}

/// `MobileBreakBehaviour` — a relaxation profile (restriction behaviour + relaxed categories).
public struct BreakBehaviourSnapshot: Codable, Equatable, Sendable {
    public var restrictionBehaviour: BreakRestrictionBehaviour
    public var relaxedCategories: [RestrictionCategory]

    public init(restrictionBehaviour: BreakRestrictionBehaviour, relaxedCategories: [RestrictionCategory] = []) {
        self.restrictionBehaviour = restrictionBehaviour
        self.relaxedCategories = relaxedCategories
    }

    private enum CodingKeys: String, CodingKey {
        case restrictionBehaviour, relaxedCategories
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        restrictionBehaviour = try c.decode(BreakRestrictionBehaviour.self, forKey: .restrictionBehaviour)
        relaxedCategories = try c.decodeCategories(forKey: .relaxedCategories)
    }
}

/// `MobileActiveOverride` — a manager override currently (or soon) affecting this employee. The server
/// sends only overrides applicable to this employee that have not been revoked; `revokedAt` and
/// `employeeId` exist for parity with the shared state machine's `WorkModeOverrideLike` (fixtures, replay).
public struct ActiveOverride: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var type: OverrideType
    public var startsAt: Date
    public var expiresAt: Date
    /// Relaxation applied while a TEMPORARY_EXCEPTION is active; nil for other types (= RELAX_ALL default).
    public var breakBehaviour: BreakBehaviourSnapshot?
    /// Revocation instant: the override stops applying at `min(expiresAt, revokedAt)`.
    public var revokedAt: Date?
    /// Employee the override is scoped to; nil for an organisation-wide override.
    public var employeeId: String?

    public init(
        id: String,
        type: OverrideType,
        startsAt: Date,
        expiresAt: Date,
        breakBehaviour: BreakBehaviourSnapshot? = nil,
        revokedAt: Date? = nil,
        employeeId: String? = nil
    ) {
        self.id = id
        self.type = type
        self.startsAt = startsAt
        self.expiresAt = expiresAt
        self.breakBehaviour = breakBehaviour
        self.revokedAt = revokedAt
        self.employeeId = employeeId
    }

    private enum CodingKeys: String, CodingKey {
        case id, type, startsAt, expiresAt, breakBehaviour, revokedAt, employeeId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        type = try c.decode(OverrideType.self, forKey: .type)
        startsAt = try c.decode(Date.self, forKey: .startsAt)
        expiresAt = try c.decode(Date.self, forKey: .expiresAt)
        // Parsed defensively like the TS machine's override payload: an unreadable behaviour means RELAX_ALL.
        breakBehaviour = try? c.decodeIfPresent(BreakBehaviourSnapshot.self, forKey: .breakBehaviour)
        revokedAt = try c.decodeIfPresent(Date.self, forKey: .revokedAt)
        employeeId = try c.decodeIfPresent(String.self, forKey: .employeeId)
    }
}

/// `BreakAllowance` — the employee's break allowance for the current (or next) shift.
public struct BreakAllowance: Codable, Equatable, Sendable {
    public var breaksTaken: Int
    public var breaksRemaining: Int
    public var minutesUsed: Int
    public var minutesRemaining: Int
    public var nextEligibleAt: Date?
    public var canStartNow: Bool

    public init(breaksTaken: Int, breaksRemaining: Int, minutesUsed: Int, minutesRemaining: Int, nextEligibleAt: Date?, canStartNow: Bool) {
        self.breaksTaken = breaksTaken
        self.breaksRemaining = breaksRemaining
        self.minutesUsed = minutesUsed
        self.minutesRemaining = minutesRemaining
        self.nextEligibleAt = nextEligibleAt
        self.canStartNow = canStartNow
    }
}
