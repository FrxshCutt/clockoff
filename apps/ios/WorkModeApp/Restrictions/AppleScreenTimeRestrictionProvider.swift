import DeviceActivity
import FamilyControls
import Foundation
import ManagedSettings
import WorkModeCore

extension ManagedSettingsStore.Name {
    /// The named store holding Work Mode's shields (shared with the DeviceActivityMonitor extension).
    static let workMode = Self("com.workmode.shields")
}

/// Screen Time implementation of `RestrictionProvider` (FamilyControls / ManagedSettings / DeviceActivity).
///
/// Status of this stage: authorisation, clearing shields and stopping monitoring use the real Apple APIs.
/// Applying shields and registering DeviceActivity schedules need the employee's `FamilyActivitySelection`
/// (picker + persistence), which the Screen Time stage adds; until then those calls throw
/// `RestrictionProviderError.notImplemented` so nothing claims to be enforced when it is not.
final class AppleScreenTimeRestrictionProvider: RestrictionProvider, SelectionCountsProviding {
    private let store = ManagedSettingsStore(named: .workMode)
    private let activityCenter = DeviceActivityCenter()

    var authorizationStatus: RestrictionAuthorizationStatus {
        switch AuthorizationCenter.shared.authorizationStatus {
        case .notDetermined:
            return .notDetermined
        case .approved, .approvedWithDataAccess:
            return .approved
        case .denied:
            return .denied
        @unknown default:
            return .notDetermined
        }
    }

    func requestAuthorization() async throws {
        try await AuthorizationCenter.shared.requestAuthorization(for: .individual)
    }

    func hasSelection() -> Bool {
        // No FamilyActivitySelection is persisted yet (Screen Time stage).
        false
    }

    func selectionCounts() -> SelectionCounts {
        .zero
    }

    func applyWorkRestrictions(plan: RestrictionPlan) throws {
        throw RestrictionProviderError.notImplemented("Applying Screen Time shields")
    }

    func applyBreakRestrictions(plan: RestrictionPlan, behaviour: BreakBehaviour) throws {
        throw RestrictionProviderError.notImplemented("Relaxing Screen Time shields for breaks")
    }

    func clearRestrictions() throws {
        store.clearAllSettings()
    }

    func scheduleActivities(_ plans: [ActivityPlan]) throws {
        throw RestrictionProviderError.notImplemented("Scheduling shifts with DeviceActivity")
    }

    func cancelAllActivities() {
        activityCenter.stopMonitoring()
    }

    func currentEngineState() -> RestrictionEngineState {
        switch authorizationStatus {
        case .approved:
            return RestrictionEngineState(state: .unknown, source: .provider)
        case .notDetermined, .denied:
            return RestrictionEngineState(state: .permissionError, source: .provider)
        }
    }
}
