import DeviceActivity
import Foundation
import os
import ClockOffCore
import ClockOffScreenTime

/// DeviceActivityMonitor extension. iOS wakes it at the boundaries of the schedules the app registered
/// (`shift-<id>-v<version>`, `break-<clientBreakId>`), even when the app is not running or after a reboot.
///
/// Every decision lives in `MonitorEventHandler` (ClockOffCore, unit-tested in the simulator); this class only
/// wires it to the App Group files and the real ManagedSettings stores. It links Foundation, DeviceActivity,
/// ClockOffCore and the thin ClockOffScreenTime adapter (ManagedSettings + FamilyControls, needed to decode the
/// selection tokens) — no UIKit, no networking — because extensions have a small memory budget.
final class DeviceActivityMonitorExtension: DeviceActivityMonitor {
    private let logger = Logger(subsystem: ClockOffLog.subsystem, category: "devicemonitor")

    private lazy var handler: MonitorEventHandler? = {
        guard let fileStore = AppGroupFileStore.appGroup() else {
            logger.error("App Group container unavailable: cannot enforce")
            return nil
        }
        let flags = SharedFlags.appGroup()
        let cache = StateCache(fileStore: fileStore)
        return MonitorEventHandler(
            cache: cache,
            plans: PlansStore(fileStore: fileStore),
            applier: .screenTime(fileStore: fileStore, flags: flags),
            flags: flags,
            timeZone: .current,
            // The extension trusts the last permission state the app recorded; a revocation drops the shields
            // on iOS's side regardless, and the app re-reports on its next sync.
            permissionApproved: { cache.load()?.lastPermissionState?.isApproved ?? true }
        )
    }()

    override func intervalDidStart(for activity: DeviceActivityName) {
        super.intervalDidStart(for: activity)
        handle("intervalDidStart", activity) { $0.intervalDidStart(activityName: activity.rawValue) }
    }

    override func intervalDidEnd(for activity: DeviceActivityName) {
        super.intervalDidEnd(for: activity)
        handle("intervalDidEnd", activity) { $0.intervalDidEnd(activityName: activity.rawValue) }
    }

    override func intervalWillStartWarning(for activity: DeviceActivityName) {
        super.intervalWillStartWarning(for: activity)
        handle("intervalWillStartWarning", activity) { $0.intervalWillStartWarning(activityName: activity.rawValue) }
    }

    override func intervalWillEndWarning(for activity: DeviceActivityName) {
        super.intervalWillEndWarning(for: activity)
        // SHIFT_ENDING is a display state; the shields do not change until the interval ends.
        logger.info("intervalWillEndWarning \(activity.rawValue, privacy: .public)")
    }

    private func handle(_ callback: String, _ activity: DeviceActivityName, _ body: (MonitorEventHandler) -> MonitorEventHandler.Outcome) {
        guard let handler else {
            logger.error("\(callback, privacy: .public) \(activity.rawValue, privacy: .public): no handler")
            return
        }
        let outcome = body(handler)
        logger.info("\(callback, privacy: .public) \(activity.rawValue, privacy: .public): \(outcome.note, privacy: .public) state=\(outcome.engineState?.rawValue ?? "-", privacy: .public) events=\(outcome.queuedEvents.map(\.rawValue).joined(separator: ","), privacy: .public)")
    }
}
