import Foundation
import WorkModeCore

/// Builds `POST /device/state` bodies from local state. Only §12 operational fields.
enum DeviceStateReportBuilder {
    static func make(
        provider: AppRestrictionProvider,
        cache: CachedState,
        engineState: WorkModeState,
        deviceInfo: DeviceInfoProviding,
        now: Date
    ) -> DeviceStateReport {
        let permission = provider.authorizationStatus.permissionState(previous: cache.lastPermissionState)
        let hasSelection = provider.hasSelection()
        let counts = provider.selectionCounts()
        // Acknowledge the policy and schedule versions held in the cache: enforcement (engine, plans,
        // shields) always runs from the cache, so these are the versions the device is acting on.
        return DeviceStateReport(
            permissionState: permission,
            selectionState: hasSelection ? .configured : .none,
            selectionCounts: hasSelection ? counts : nil,
            restrictionEngineState: engineState,
            appVersion: deviceInfo.appVersion,
            osVersion: deviceInfo.osVersion,
            policyVersionApplied: cache.policyVersion,
            scheduleVersionApplied: cache.scheduleVersion,
            localTime: now,
            timezone: deviceInfo.timeZone.identifier
        )
    }
}
