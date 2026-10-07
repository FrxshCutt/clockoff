import BackgroundTasks
import Foundation
import ClockOffCore

/// `BGAppRefreshTask` registration (identifier in Info.plist `BGTaskSchedulerPermittedIdentifiers`).
/// iOS decides when refreshes actually run; DeviceActivity schedules — not this — are what enforce shifts
/// on time. Refresh only keeps the schedule and policy fresh.
enum BackgroundRefresh {
    static let identifier = "online.clockoff.app.refresh"
    static let interval: TimeInterval = 15 * 60

    /// Must be called before `application(_:didFinishLaunchingWithOptions:)` returns.
    static func register(perform: @escaping () async -> Bool) {
        let registered = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
            guard let refresh = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            schedule()
            let work = Task {
                let success = await perform()
                refresh.setTaskCompleted(success: success)
            }
            refresh.expirationHandler = {
                work.cancel()
            }
        }
        if !registered {
            ClockOffLog.app.error("BGTaskScheduler refused \(identifier, privacy: .public): check Info.plist")
        }
    }

    /// Requests the next refresh no earlier than 15 minutes from now.
    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: interval)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            // Expected in the Simulator (BGTaskSchedulerErrorDomain code 1, unavailable).
            ClockOffLog.app.info("background refresh not scheduled: \(String(describing: error), privacy: .public)")
        }
    }
}
