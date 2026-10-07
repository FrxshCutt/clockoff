import Foundation

// Wire form of the Work Mode state machine output (`expectedStateSchema` / `ExpectedStateJson`). The server
// computes it with `computeExpectedState()` in @clockoff/shared; the on-device `WorkModeEngine` produces the
// same shape so the app, the extensions and the dashboard can be compared like for like.

public struct ShiftRef: Codable, Equatable, Hashable, Sendable {
    public var id: String
    public var startsAt: Date
    public var endsAt: Date

    public init(id: String, startsAt: Date, endsAt: Date) {
        self.id = id
        self.startsAt = startsAt
        self.endsAt = endsAt
    }
}

public struct BreakRef: Codable, Equatable, Sendable {
    public var id: String
    public var shiftId: String
    public var startedAt: Date
    public var plannedEndsAt: Date
    /// Effective end: min(plannedEndsAt, endedAt, end of the working interval).
    public var endsAt: Date

    public init(id: String, shiftId: String, startedAt: Date, plannedEndsAt: Date, endsAt: Date) {
        self.id = id
        self.shiftId = shiftId
        self.startedAt = startedAt
        self.plannedEndsAt = plannedEndsAt
        self.endsAt = endsAt
    }
}

public struct OverrideRef: Codable, Equatable, Sendable {
    public var id: String
    public var type: OverrideType
    public var startsAt: Date
    public var expiresAt: Date
    /// Nil for an organisation-wide override (or when the device does not know the scope).
    public var employeeId: String?

    public init(id: String, type: OverrideType, startsAt: Date, expiresAt: Date, employeeId: String? = nil) {
        self.id = id
        self.type = type
        self.startsAt = startsAt
        self.expiresAt = expiresAt
        self.employeeId = employeeId
    }
}

/// Union of overlapping/adjacent scheduled shifts. Restrictions never flap inside one.
public struct WorkingInterval: Codable, Equatable, Sendable {
    public var startsAt: Date
    public var endsAt: Date
    public var shiftIds: [String]
    public var shifts: [ShiftRef]

    public init(startsAt: Date, endsAt: Date, shiftIds: [String], shifts: [ShiftRef]) {
        self.startsAt = startsAt
        self.endsAt = endsAt
        self.shiftIds = shiftIds
        self.shifts = shifts
    }
}

/// What a running break (or TEMPORARY_EXCEPTION) relaxes. `liftedCategories` is what the device actually
/// unblocks (every category for RELAX_ALL); the wire schema treats it as optional, so it is derived when absent.
public struct RestrictionRelaxation: Codable, Equatable, Sendable {
    public var source: RelaxationSource
    public var restrictionBehaviour: BreakRestrictionBehaviour
    public var relaxedCategories: [RestrictionCategory]
    public var liftedCategories: [RestrictionCategory]

    public init(source: RelaxationSource, restrictionBehaviour: BreakRestrictionBehaviour, relaxedCategories: [RestrictionCategory], liftedCategories: [RestrictionCategory]) {
        self.source = source
        self.restrictionBehaviour = restrictionBehaviour
        self.relaxedCategories = relaxedCategories
        self.liftedCategories = liftedCategories
    }

    private enum CodingKeys: String, CodingKey {
        case source, restrictionBehaviour, relaxedCategories, liftedCategories
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        source = try c.decode(RelaxationSource.self, forKey: .source)
        restrictionBehaviour = try c.decode(BreakRestrictionBehaviour.self, forKey: .restrictionBehaviour)
        relaxedCategories = try c.decodeCategories(forKey: .relaxedCategories)
        if c.contains(.liftedCategories) {
            liftedCategories = try c.decodeCategories(forKey: .liftedCategories)
        } else {
            switch restrictionBehaviour {
            case .relaxAll: liftedCategories = RestrictionCategory.allCases
            case .relaxCategories: liftedCategories = relaxedCategories
            case .keepRestrictions: liftedCategories = []
            }
        }
    }
}

public struct ExpectedState: Codable, Equatable, Sendable {
    public var state: WorkModeState
    /// What the restriction engine should apply right now (the intended restriction under PERMISSION_ERROR).
    public var effectiveRestriction: EffectiveRestriction
    /// True when at least part of the policy's shield set should currently be enforced.
    public var restrictionsShouldBeActive: Bool
    public var computedAt: Date
    public var timezone: String?
    public var permissionState: PermissionState
    public var activeShift: ShiftRef?
    public var upcomingShift: ShiftRef?
    public var activeBreak: BreakRef?
    public var activeOverride: OverrideRef?
    public var workingInterval: WorkingInterval?
    public var relaxation: RestrictionRelaxation?
    /// Earliest future instant at which this output changes; nil when nothing is scheduled.
    public var nextTransitionAt: Date?

    public init(
        state: WorkModeState,
        effectiveRestriction: EffectiveRestriction,
        restrictionsShouldBeActive: Bool,
        computedAt: Date,
        timezone: String? = nil,
        permissionState: PermissionState,
        activeShift: ShiftRef? = nil,
        upcomingShift: ShiftRef? = nil,
        activeBreak: BreakRef? = nil,
        activeOverride: OverrideRef? = nil,
        workingInterval: WorkingInterval? = nil,
        relaxation: RestrictionRelaxation? = nil,
        nextTransitionAt: Date? = nil
    ) {
        self.state = state
        self.effectiveRestriction = effectiveRestriction
        self.restrictionsShouldBeActive = restrictionsShouldBeActive
        self.computedAt = computedAt
        self.timezone = timezone
        self.permissionState = permissionState
        self.activeShift = activeShift
        self.upcomingShift = upcomingShift
        self.activeBreak = activeBreak
        self.activeOverride = activeOverride
        self.workingInterval = workingInterval
        self.relaxation = relaxation
        self.nextTransitionAt = nextTransitionAt
    }
}
