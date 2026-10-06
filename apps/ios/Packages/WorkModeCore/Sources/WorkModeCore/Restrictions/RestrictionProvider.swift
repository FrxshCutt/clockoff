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

    /// DeviceActivityName raw value (`ActivityNaming`), e.g. `shift-<shiftId>-v<version>`; also the key into plans.json.
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

    /// The registered interval as instants (first occurrence for an ambiguous fall-back wall clock).
    public var intervalStart: Date? { startComponents.resolvedDate() }
    public var intervalEnd: Date? { endComponents.resolvedDate() }
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

/// Registers the DeviceActivity interval that ends a break even when the app is closed (one activity per
/// break, `ActivityNaming.breakActivity`). Apple's 15-minute minimum is honoured by stretching the interval;
/// the true `plannedEndsAt` lives in plans.json (`BreakActivitySchedule`).
public protocol BreakScheduling: AnyObject {
    /// Replaces any activity registered for `clientBreakId`. Returns the schedule actually registered. The
    /// caller writes the matching `plans.json` entry BEFORE calling this, so the monitor extension always finds it.
    @discardableResult
    func scheduleBreak(clientBreakId: String, shiftId: String, startedAt: Date, plannedEndsAt: Date) throws -> ActivityPlan
    /// Stops monitoring the break's activity (ended early, or ended by the shift end). Never fails.
    func cancelBreakActivity(clientBreakId: String)
}

/// Lets the app observe Screen Time authorisation changes (approval revoked in Settings › Screen Time).
public protocol RestrictionAuthorizationObserving: AnyObject {
    /// Called on an arbitrary thread whenever the authorisation status changes.
    var onAuthorizationStatusChange: ((RestrictionAuthorizationStatus) -> Void)? { get set }
}

extension Notification.Name {
    /// Posted (on an arbitrary thread) by a `RestrictionProvider` when Screen Time authorisation changes, with
    /// `RestrictionAuthorizationNotification.statusKey` → `RestrictionAuthorizationStatus.rawValue` in `userInfo`.
    /// On a revocation the provider has already cleared both shield stores and recorded PERMISSION_ERROR; the
    /// app reconciles, reports to the server and shows "Action Required".
    public static let workModeAuthorizationStatusDidChange = Notification.Name("com.workmode.authorizationStatusDidChange")
}

public enum RestrictionAuthorizationNotification {
    public static let statusKey = "status"

    public static func status(from notification: Notification) -> RestrictionAuthorizationStatus? {
        (notification.userInfo?[statusKey] as? String).flatMap(RestrictionAuthorizationStatus.init(rawValue:))
    }
}

/// Counts of an on-device selection (`FamilyActivitySelection`), the only thing about it that ever leaves the
/// phone. Opaque tokens are never readable by the app, let alone sent anywhere (§12).
public struct SelectionSummary: Codable, Equatable, Sendable {
    public var categoryCount: Int
    public var applicationCount: Int
    public var webDomainCount: Int

    public init(categoryCount: Int, applicationCount: Int, webDomainCount: Int) {
        self.categoryCount = categoryCount
        self.applicationCount = applicationCount
        self.webDomainCount = webDomainCount
    }

    public static let empty = SelectionSummary(categoryCount: 0, applicationCount: 0, webDomainCount: 0)

    public var total: Int { categoryCount + applicationCount + webDomainCount }
    public var isEmpty: Bool { total == 0 }

    /// The `/device/state` representation.
    public var counts: SelectionCounts {
        SelectionCounts(categories: categoryCount, applications: applicationCount, webDomains: webDomainCount)
    }
}

/// Builds the DeviceActivity schedule for a break: `intervalStart` = `startedAt` floored to the minute,
/// `intervalEnd` = max(`plannedEndsAt`, `startedAt` + 15 min) rounded UP to the minute so Apple accepts it and
/// the interval never ends before the true end; `plannedEnd` keeps the exact `plannedEndsAt`.
public enum BreakActivitySchedule {
    public static let minimumIntervalMinutes = 15

    /// `date` floored to the start of its minute.
    public static func floorToMinute(_ date: Date) -> Date {
        Date(timeIntervalSince1970: (date.timeIntervalSince1970 / 60).rounded(.down) * 60)
    }

    /// `date` rounded up to the next whole minute (unchanged when already on one).
    public static func ceilToMinute(_ date: Date) -> Date {
        Date(timeIntervalSince1970: (date.timeIntervalSince1970 / 60).rounded(.up) * 60)
    }

    public static func make(clientBreakId: String, shiftId: String, startedAt: Date, plannedEndsAt: Date, timeZone: TimeZone) -> ActivityPlan {
        let flooredStart = floorToMinute(startedAt)
        let minimumEnd = flooredStart.addingTimeInterval(TimeInterval(minimumIntervalMinutes * 60))
        let end = ceilToMinute(max(plannedEndsAt, minimumEnd))
        return ActivityPlan(
            name: ActivityNaming.breakActivity(clientBreakId: clientBreakId),
            shiftId: shiftId,
            startComponents: deviceComponents(for: flooredStart, in: timeZone),
            endComponents: deviceComponents(for: end, in: timeZone),
            warningMinutes: 0,
            kind: .break,
            plannedEnd: plannedEndsAt
        )
    }
}
