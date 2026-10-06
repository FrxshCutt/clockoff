import Foundation

// The seam between Work Mode's domain logic and Apple's Screen Time frameworks (§8.3).
//
// Implementations:
//  - `AppleScreenTimeRestrictionProvider` (app target) — FamilyControls / ManagedSettings / DeviceActivity.
//  - `MockRestrictionProvider` (app target, DEBUG_MOCK_RESTRICTIONS builds only) — in-memory simulation.
// WorkModeCore never imports the Screen Time frameworks, so the extensions and unit tests stay light.

/// Screen Time authorisation as the provider sees it (mirrors `AuthorizationStatus`).
public enum RestrictionAuthorizationStatus: String, Codable, CaseIterable, Sendable {
    case notDetermined
    case approved
    case denied

    /// The value reported to the server. A denial after a previous approval is a revocation.
    public func permissionState(previous: PermissionState?) -> PermissionState {
        switch self {
        case .notDetermined:
            return .notDetermined
        case .approved:
            return .approved
        case .denied:
            switch previous {
            case .some(.approved), .some(.revoked):
                return .revoked
            case .some(.notDetermined), .some(.denied), .some(.unknown), .none:
                return .denied
            }
        }
    }
}

/// What to shield during a shift. Category names are Work Mode's policy categories; the provider maps them
/// to the employee's on-device selection (opaque Apple tokens never leave the device).
public struct RestrictionPlan: Codable, Equatable, Sendable {
    public var shiftId: String
    /// PolicyVersion id the plan was built from (nil when no policy resolved).
    public var policyVersion: String?
    public var categories: [RestrictionCategory]
    /// Text for the shield screen; nil → the extension's default copy.
    public var shieldMessage: String?
    /// True when breaks relax only some categories, so the employee must also pick the subset of their
    /// selection that stays shielded during breaks.
    public var requiresBreakSubsetSelection: Bool

    public init(shiftId: String, policyVersion: String?, categories: [RestrictionCategory], shieldMessage: String?, requiresBreakSubsetSelection: Bool) {
        self.shiftId = shiftId
        self.policyVersion = policyVersion
        self.categories = categories
        self.shieldMessage = shieldMessage
        self.requiresBreakSubsetSelection = requiresBreakSubsetSelection
    }

    /// Builds the plan for a shift from the resolved Work Policy and Break Policy.
    public static func make(shiftId: String, policy: PolicySummary, breakPolicy: BreakPolicy?) -> RestrictionPlan {
        let breakBehaviour = breakPolicy?.rules.restrictionBehaviour ?? .relaxAll
        let requiresSubset: Bool
        switch breakBehaviour {
        case .relaxCategories:
            requiresSubset = !(breakPolicy?.rules.relaxedCategories.isEmpty ?? true)
        case .relaxAll, .keepRestrictions:
            requiresSubset = false
        }
        return RestrictionPlan(
            shiftId: shiftId,
            policyVersion: policy.policyVersionId,
            categories: RestrictionCategory.canonical(policy.restrictionConfig.categories),
            shieldMessage: policy.restrictionConfig.shieldMessage,
            requiresBreakSubsetSelection: requiresSubset
        )
    }
}

/// How restrictions change during a break.
public enum BreakBehaviour: Codable, Equatable, Sendable {
    /// Lift every shield for the break.
    case relaxAll
    /// Keep shielding `kept` (the plan's categories minus the relaxed ones); lift the rest.
    case relaxCategories(kept: [RestrictionCategory])
    /// The break changes nothing: shields stay up.
    case keepRestrictions

    /// Maps the domain behaviour onto the provider's terms. RELAX_CATEGORIES with nothing left to keep is
    /// RELAX_ALL; with nothing relaxed it keeps everything (same convention as the shared state machine).
    public static func from(
        restrictionBehaviour: BreakRestrictionBehaviour,
        relaxedCategories: [RestrictionCategory],
        planCategories: [RestrictionCategory]
    ) -> BreakBehaviour {
        switch restrictionBehaviour {
        case .relaxAll:
            return .relaxAll
        case .keepRestrictions:
            return .keepRestrictions
        case .relaxCategories:
            if relaxedCategories.isEmpty { return .keepRestrictions }
            let relaxed = Set(relaxedCategories)
            let kept = RestrictionCategory.canonical(planCategories.filter { !relaxed.contains($0) })
            return kept.isEmpty ? .relaxAll : .relaxCategories(kept: kept)
        }
    }
}

/// One DeviceActivity schedule to register. Components are wall-clock values in the device's timezone
/// produced by `deviceComponents(for:in:)`; `plannedEnd` keeps the exact UTC end for intervals that had to
/// be stretched to DeviceActivity's 15-minute minimum (short breaks).
public struct ActivityPlan: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case shift
        case `break`
    }

    /// DeviceActivityName raw value, e.g. `wm.shift.<shiftId>`; also the key into plans.json.
    public var name: String
    public var shiftId: String
    public var startComponents: DateComponents
    public var endComponents: DateComponents
    /// DeviceActivitySchedule.warningTime in minutes (0 = none).
    public var warningMinutes: Int
    public var kind: Kind
    public var plannedEnd: Date?

    public init(name: String, shiftId: String, startComponents: DateComponents, endComponents: DateComponents, warningMinutes: Int, kind: Kind, plannedEnd: Date? = nil) {
        self.name = name
        self.shiftId = shiftId
        self.startComponents = startComponents
        self.endComponents = endComponents
        self.warningMinutes = warningMinutes
        self.kind = kind
        self.plannedEnd = plannedEnd
    }
}

/// Where the provider's view of the engine state came from.
public enum RestrictionEngineStateSource: String, Codable, CaseIterable, Sendable {
    /// Computed by the app's `WorkModeEngine` and applied through the provider.
    case appEngine
    /// Written by the DeviceActivityMonitor extension at an interval boundary.
    case monitorExtension
    /// Read back from the provider's own record of what it last applied.
    case provider
    /// Restored from the App Group cache (no fresh evaluation yet).
    case cache
    /// Nothing has been applied or evaluated yet.
    case none
}

/// The restriction engine's current state: the same states as `WorkModeState` plus provenance.
public struct RestrictionEngineState: Codable, Equatable, Sendable {
    public var state: WorkModeState
    public var source: RestrictionEngineStateSource
    public var updatedAt: Date?

    public init(state: WorkModeState, source: RestrictionEngineStateSource, updatedAt: Date? = nil) {
        self.state = state
        self.source = source
        self.updatedAt = updatedAt
    }

    public static let unknown = RestrictionEngineState(state: .unknown, source: .none, updatedAt: nil)
}

public enum RestrictionProviderError: Error, Equatable, LocalizedError {
    case notAuthorized
    case noSelection
    case notImplemented(String)
    case unavailable(String)
    case schedulingFailed(String)

    public var errorDescription: String? {
        switch self {
        case .notAuthorized:
            return "Screen Time access has not been granted."
        case .noSelection:
            return "No apps have been chosen to block."
        case .notImplemented(let what):
            return "\(what) is not available in this build yet."
        case .unavailable(let reason):
            return reason
        case .schedulingFailed(let reason):
            return "Work Mode could not schedule your shifts: \(reason)"
        }
    }
}

/// §8.3 — the restriction engine abstraction. Implementations must be safe to call from any thread.
///
/// Semantics every implementation follows:
/// - `applyWorkRestrictions` / `applyBreakRestrictions` replace whatever is currently applied (idempotent);
///   they throw `.notAuthorized` without Screen Time approval and `.noSelection` without a selection.
/// - `scheduleActivities` replaces the full set of monitored activities with `plans` (at most 20).
/// - `clearRestrictions` and `cancelAllActivities` never fail when there is nothing to clear.
public protocol RestrictionProvider: AnyObject {
    var authorizationStatus: RestrictionAuthorizationStatus { get }
    func requestAuthorization() async throws
    func hasSelection() -> Bool
    func applyWorkRestrictions(plan: RestrictionPlan) throws
    func applyBreakRestrictions(plan: RestrictionPlan, behaviour: BreakBehaviour) throws
    func clearRestrictions() throws
    func scheduleActivities(_ plans: [ActivityPlan]) throws
    func cancelAllActivities()
    func currentEngineState() -> RestrictionEngineState
}

/// Counts of the employee's selection for `/device/state` (numbers only, §12). Separate from
/// `RestrictionProvider` so the §8.3 protocol stays exactly as specified.
public protocol SelectionCountsProviding: AnyObject {
    func selectionCounts() -> SelectionCounts
}
