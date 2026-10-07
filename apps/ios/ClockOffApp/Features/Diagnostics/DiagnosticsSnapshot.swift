// DEBUG ONLY — the Diagnostics screen (Settings → tap "App version" five times).
//
// Nothing in this file exists in a Release build: `make build-release` (Scripts/verify-release.sh) fails when a
// Release binary contains `DiagnosticsReport.title` or the `DiagnosticsSnapshot` type.
#if DEBUG
import Foundation
import ClockOffCore

/// Everything the Diagnostics screen shows, as plain values gathered at one instant (`DiagnosticsDataSource`).
/// Counts, states, activity names and timestamps only: never Screen Time tokens, app names or category names.
/// `DiagnosticsReport` turns it into the on-screen sections and the copied plain-text report.
struct DiagnosticsSnapshot: Equatable {
    /// Which restriction provider gathered the Screen Time parts.
    enum ProviderKind: Equatable {
        /// `AppleScreenTimeRestrictionProvider`: FamilyControls / DeviceActivity / ManagedSettings.
        case screenTime
        /// `MockRestrictionProvider` (simulator Debug builds): everything Screen Time is simulated.
        case simulated
        /// A provider that cannot be inspected (tests with a stub provider).
        case unavailable
    }

    struct Authorization: Equatable {
        /// Live `AuthorizationCenter.shared.authorizationStatus` (or the mock's).
        var familyControls: RestrictionAuthorizationStatus
        /// What the next `/device/state` reports (a denial after an approval is REVOKED).
        var reportedPermission: PermissionState
        var provider: ProviderKind
    }

    struct Selection: Equatable {
        /// The work selection's counts; nil when no (non-empty) selection is saved.
        var work: SelectionCounts?
        /// The "kept blocked on breaks" subset; nil when none is saved.
        var breakKept: SelectionCounts?
        /// True when the Break Policy relaxes only some categories, so `breakKept` is needed.
        var breakKeptRequired: Bool
    }

    /// What one `WorkModeController.reconcile()` decided, without the plan (which names categories).
    struct Reconcile: Equatable {
        enum Action: String, Equatable {
            case applyWork = "apply work shields"
            case applyBreak = "apply break relaxation"
            case clear = "clear shields"
            case leaveUnchanged = "leave unchanged"
        }

        var action: Action?
        var isChange: Bool
        var decisionReason: String?
        var appliedState: WorkModeState?
        var closedBreak: Bool
    }

    struct Engine: Equatable {
        var isJoined: Bool
        /// What the app shows (`WorkModeController.state`).
        var screenState: UIWorkState
        /// What the on-device engine computed on the last reconcile (nil before the first one).
        var expected: ExpectedState?
        /// `RestrictionProvider.currentEngineState()`: what the provider reads back from the shield stores.
        var providerState: RestrictionEngineState
        var lastReconcile: Reconcile?
        var lastReconcileAt: Date?
    }

    /// One DeviceActivity registered with iOS (`DeviceActivityCenter().activities` + `schedule(for:)`).
    struct RegisteredActivity: Equatable {
        var name: String
        var start: Date?
        var end: Date?
        var repeats: Bool
        var warningMinutes: Int?
    }

    /// One entry of plans.json (what the monitor extension does when that activity fires).
    struct PlannedActivity: Equatable {
        var name: String
        var kind: ActivityPlan.Kind
        var start: Date?
        /// The true end (`plannedEnd`; a short break's registered interval is stretched to 15 minutes).
        var end: Date?
    }

    struct Schedules: Equatable {
        /// Nil when the provider cannot be inspected.
        var registered: [RegisteredActivity]?
        /// Nil when plans.json does not exist (or does not decode).
        var planned: [PlannedActivity]?
        /// `SyncMetadataStore.activitiesNeedReschedule`: the last registration failed and the next sync retries.
        var needsReschedule: Bool
    }

    /// `ShieldSettings.ActivityCategoryPolicy`, reduced to counts.
    enum CategoryPolicy: Equatable {
        case none
        case specific(categories: Int, exceptions: Int)
        case all(exceptions: Int)
    }

    /// One named `ManagedSettingsStore`: which shield sets are non-nil and how many tokens each holds.
    struct ShieldStore: Equatable {
        var role: ShieldStoreRole
        var applications: Int?
        var applicationCategories: CategoryPolicy?
        var webDomains: Int?
        var webDomainCategories: CategoryPolicy?

        static func empty(_ role: ShieldStoreRole) -> ShieldStore {
            ShieldStore(role: role, applications: nil, applicationCategories: nil, webDomains: nil, webDomainCategories: nil)
        }

        /// Same rule as `ManagedSettingsShieldStore.isShielding` (which `currentEngineState()` relies on): a
        /// non-empty token set, or any non-nil category policy, counts as shielding.
        var isShielding: Bool {
            if let applications, applications > 0 { return true }
            if let webDomains, webDomains > 0 { return true }
            return applicationCategories != nil || webDomainCategories != nil
        }
    }

    struct AppGroupContents: Equatable {
        /// False: the per-process fallback directory (the extensions cannot see it — entitlement problem).
        var isSharedContainer: Bool
        var plansFileModifiedAt: Date?
        var plansGeneratedAt: Date?
        var stateFileModifiedAt: Date?
        /// `state.json` → `engineState` (the monitor extension writes it at interval boundaries).
        var recordedEngineState: RestrictionEngineState?
        /// `SharedFlags.lastMonitorCallback`: the last DeviceActivity callback the extension handled.
        var lastMonitorCallback: SharedFlags.MonitorCallback?
        var outboxCount: Int
        var queuedBreakCount: Int
        var selectionIncomplete: Bool
    }

    struct Sync: Equatable {
        var lastSyncAt: Date?
        var lastServerContactAt: Date?
        var lastSyncErrorCode: String?
        var policyVersion: String?
        var scheduleVersion: Int?
        /// device − server, from the last `/device/state` response.
        var clockSkewSeconds: Int?
        var lastCheckInAt: Date?
        /// Host (and port) of the API the app talks to.
        var apiHost: String
    }

    var capturedAt: Date
    var timeZone: TimeZone
    var appVersion: String
    var authorization: Authorization
    var selection: Selection
    var engine: Engine
    var schedules: Schedules
    /// Nil when the provider cannot be inspected.
    var shieldStores: [ShieldStore]?
    var appGroup: AppGroupContents
    var sync: Sync
}

extension DiagnosticsSnapshot.Reconcile {
    /// Reduces `WorkModeController.ReconcileOutcome`; its `note` is not used because it can print the plan.
    init(outcome: WorkModeController.ReconcileOutcome) {
        let action: Action?
        switch outcome.decision?.action {
        case .applyWork?: action = .applyWork
        case .applyBreak?: action = .applyBreak
        case .clear?: action = .clear
        case .leaveUnchanged?: action = .leaveUnchanged
        case nil: action = nil
        }
        self.init(action: action, isChange: outcome.decision?.isChange ?? false, decisionReason: outcome.decision?.reason,
                  appliedState: outcome.appliedState, closedBreak: outcome.closedBreak)
    }
}

/// Settings → "App version": five taps, each within `maximumGap` of the previous one, open Diagnostics.
struct DiagnosticsUnlock: Equatable {
    static let requiredTaps = 5
    static let maximumGap: TimeInterval = 1.5

    private(set) var count = 0
    private var lastTapAt: Date?

    /// Records a tap; true on the tap that completes the sequence (the count then starts again).
    mutating func registerTap(at instant: Date) -> Bool {
        if let lastTapAt, instant.timeIntervalSince(lastTapAt) <= DiagnosticsUnlock.maximumGap, instant >= lastTapAt {
            count += 1
        } else {
            count = 1
        }
        lastTapAt = instant
        guard count >= DiagnosticsUnlock.requiredTaps else { return false }
        count = 0
        lastTapAt = nil
        return true
    }
}
#endif
