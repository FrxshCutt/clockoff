import Foundation

// Domain enums. Raw values mirror `packages/shared/src/enums.ts` (and therefore the Prisma enums) exactly;
// the API sends them as UPPER_SNAKE_CASE strings. Swift case names are camelCase.
//
// Forward compatibility: the API may add values over time. Enums that have a natural "unknown" bucket
// (`WorkModeState`, `PermissionState`) decode unrecognised values into it. Category arrays are decoded
// lossily (unknown categories are dropped, see `decodeCategories(forKey:)`). Every other enum decodes
// strictly so a contract change fails loudly instead of being silently misinterpreted.

/// Work Mode state machine states (§6.2).
public enum WorkModeState: String, Codable, CaseIterable, Sendable {
    case offShift = "OFF_SHIFT"
    case shiftStartingSoon = "SHIFT_STARTING_SOON"
    case working = "WORKING"
    case onBreak = "ON_BREAK"
    case shiftEnding = "SHIFT_ENDING"
    case managerOverride = "MANAGER_OVERRIDE"
    case permissionError = "PERMISSION_ERROR"
    case syncError = "SYNC_ERROR"
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = WorkModeState(rawValue: raw) ?? .unknown
    }
}

/// Screen Time authorisation state as reported to the server.
public enum PermissionState: String, Codable, CaseIterable, Sendable {
    case notDetermined = "NOT_DETERMINED"
    case approved = "APPROVED"
    case denied = "DENIED"
    case revoked = "REVOKED"
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = PermissionState(rawValue: raw) ?? .unknown
    }

    public var isApproved: Bool {
        switch self {
        case .approved:
            return true
        case .notDetermined, .denied, .revoked, .unknown:
            return false
        }
    }
}

/// Whether the employee has chosen what to shield.
public enum SelectionState: String, Codable, CaseIterable, Sendable {
    case none = "NONE"
    case configured = "CONFIGURED"
}

/// App categories a Work Policy can restrict (`RESTRICTION_CATEGORIES`).
public enum RestrictionCategory: String, Codable, CaseIterable, Sendable {
    case socialMedia = "SOCIAL_MEDIA"
    case games = "GAMES"
    case entertainment = "ENTERTAINMENT"
    case streaming = "STREAMING"
    case video = "VIDEO"
    case shopping = "SHOPPING"
    case dating = "DATING"
    case otherSelected = "OTHER_SELECTED"

    /// Human label, identical to `RESTRICTION_CATEGORY_LABELS` on the web.
    public var label: String {
        switch self {
        case .socialMedia: return "Social Media"
        case .games: return "Games"
        case .entertainment: return "Entertainment"
        case .streaming: return "Streaming"
        case .video: return "Video"
        case .shopping: return "Shopping"
        case .dating: return "Dating"
        case .otherSelected: return "Other selected apps"
        }
    }

    /// Canonical order (the order of `RESTRICTION_CATEGORIES`), de-duplicated.
    public static func canonical<S: Sequence>(_ categories: S) -> [RestrictionCategory] where S.Element == RestrictionCategory {
        let present = Set(categories)
        return allCases.filter { present.contains($0) }
    }
}

/// What a break (or a TEMPORARY_EXCEPTION override) does to restrictions.
public enum BreakRestrictionBehaviour: String, Codable, CaseIterable, Sendable {
    case relaxAll = "RELAX_ALL"
    case relaxCategories = "RELAX_CATEGORIES"
    case keepRestrictions = "KEEP_RESTRICTIONS"
}

/// Activity events a device may report (`DEVICE_REPORTABLE_EVENT_TYPES`, §5 POST /events, §12).
/// Manager/server-only event types are deliberately absent: the API rejects them from a device.
public enum ActivityEventType: String, Codable, CaseIterable, Sendable {
    case setupCompleted = "SETUP_COMPLETED"
    case permissionGranted = "PERMISSION_GRANTED"
    case permissionNeedsAttention = "PERMISSION_NEEDS_ATTENTION"
    case selectionConfigured = "SELECTION_CONFIGURED"
    case workModeStarted = "WORK_MODE_STARTED"
    case workModeEnded = "WORK_MODE_ENDED"
    case breakStarted = "BREAK_STARTED"
    case breakEnded = "BREAK_ENDED"
    case breakExpired = "BREAK_EXPIRED"
    case scheduleSynced = "SCHEDULE_SYNCED"
    case policySynced = "POLICY_SYNCED"
}

public enum ShiftStatus: String, Codable, CaseIterable, Sendable {
    case scheduled = "SCHEDULED"
    case cancelled = "CANCELLED"
    case completed = "COMPLETED"
}

public enum BreakSessionStatus: String, Codable, CaseIterable, Sendable {
    case active = "ACTIVE"
    case ended = "ENDED"
}

public enum BreakEndReason: String, Codable, CaseIterable, Sendable {
    case expired = "EXPIRED"
    case employeeEnded = "EMPLOYEE_ENDED"
    case shiftEnded = "SHIFT_ENDED"
    case managerEnded = "MANAGER_ENDED"
    case policyChanged = "POLICY_CHANGED"
}

/// End reasons a device may send to `POST /breaks/:id/end` (`MOBILE_BREAK_END_REASONS`).
public enum MobileBreakEndReason: String, Codable, CaseIterable, Sendable {
    case employeeEnded = "EMPLOYEE_ENDED"
    case expired = "EXPIRED"
    case shiftEnded = "SHIFT_ENDED"
}

public enum OverrideType: String, Codable, CaseIterable, Sendable {
    case exemptTemporarily = "EXEMPT_TEMPORARILY"
    case endWorkModeEarly = "END_WORK_MODE_EARLY"
    case temporaryException = "TEMPORARY_EXCEPTION"
    case emergencyPolicyOverride = "EMERGENCY_POLICY_OVERRIDE"
}

/// What the restriction engine should apply right now.
public enum EffectiveRestriction: String, Codable, CaseIterable, Sendable {
    case work = "WORK"
    case breakRelaxed = "BREAK_RELAXED"
    case none = "NONE"
}

public enum ActivationMode: String, Codable, CaseIterable, Sendable {
    case scheduled = "SCHEDULED"
    case clockEvent = "CLOCK_EVENT"
}

/// `RelaxationSource` in the expected-state contract.
public enum RelaxationSource: String, Codable, CaseIterable, Sendable {
    case breakSession = "BREAK"
    case override = "OVERRIDE"
}

/// Device platform (`PLATFORMS`). Only iOS exists.
public enum DevicePlatform: String, Codable, CaseIterable, Sendable {
    case ios = "IOS"
}

/// APNs environment sent with the push token.
public enum PushEnvironment: String, Codable, CaseIterable, Sendable {
    case sandbox
    case production
}
