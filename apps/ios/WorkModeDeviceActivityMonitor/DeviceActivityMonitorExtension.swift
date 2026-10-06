import DeviceActivity
import Foundation
import os
import WorkModeCore

/// DeviceActivityMonitor extension. iOS wakes it at the boundaries of the schedules the app registered
/// (`ActivityPlan` → `DeviceActivitySchedule`), even when the app is not running or after a reboot.
///
/// This stage only logs and confirms the matching `plans.json` entry is readable from the App Group. The
/// Screen Time stage adds the enforcement: apply/clear `ManagedSettingsStore(named: .workMode)` per the
/// entry, record `CachedState.engineState` and queue WORK_MODE_* events via `WorkModeEvents` + `EventOutbox`.
/// Keep it light: extensions have a small memory budget, so only Foundation + WorkModeCore are linked.
final class DeviceActivityMonitorExtension: DeviceActivityMonitor {
    private let logger = Logger(subsystem: WorkModeLog.subsystem, category: "devicemonitor")

    override func intervalDidStart(for activity: DeviceActivityName) {
        super.intervalDidStart(for: activity)
        logger.info("intervalDidStart \(activity.rawValue, privacy: .public) plan=\(self.planSummary(activity), privacy: .public)")
    }

    override func intervalDidEnd(for activity: DeviceActivityName) {
        super.intervalDidEnd(for: activity)
        logger.info("intervalDidEnd \(activity.rawValue, privacy: .public) plan=\(self.planSummary(activity), privacy: .public)")
    }

    override func intervalWillStartWarning(for activity: DeviceActivityName) {
        super.intervalWillStartWarning(for: activity)
        logger.info("intervalWillStartWarning \(activity.rawValue, privacy: .public)")
    }

    override func intervalWillEndWarning(for activity: DeviceActivityName) {
        super.intervalWillEndWarning(for: activity)
        logger.info("intervalWillEndWarning \(activity.rawValue, privacy: .public)")
    }

    private func planSummary(_ activity: DeviceActivityName) -> String {
        guard let store = AppGroupFileStore.appGroup() else { return "app-group-unavailable" }
        guard let entry = PlansStore(fileStore: store).entry(forActivityNamed: activity.rawValue) else { return "none" }
        return "\(entry.activity.kind.rawValue) shift=\(entry.shiftId) categories=\(entry.plan.categories.count)"
    }
}
