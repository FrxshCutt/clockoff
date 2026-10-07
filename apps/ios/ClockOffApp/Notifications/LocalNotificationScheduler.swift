import Foundation
import UserNotifications
import ClockOffCore

/// Local notifications (UNUserNotificationCenter). Only ClockOff's own identifiers (`clockoff.*`) are ever touched.
protocol LocalNotificationScheduling: AnyObject, Sendable {
    /// Asks for permission (alerts + sounds). Returns true when granted. Called once, after Screen Time is allowed.
    func requestPermission() async -> Bool
    /// Replaces every pending ClockOff request with `planned` (deterministic ids, so this never duplicates).
    func replacePlanned(_ planned: [PlannedNotification], timeZone: TimeZone) async
    /// Delivers a notification now (schedule changed, permission needs attention).
    func postNow(id: String, title: String, body: String) async
    /// Removes every pending and delivered ClockOff notification (leave workplace, sign out).
    func cancelAll() async
}

final class UserNotificationScheduler: LocalNotificationScheduling, @unchecked Sendable {
    private let center = UNUserNotificationCenter.current()

    init() {}

    func requestPermission() async -> Bool {
        do {
            return try await center.requestAuthorization(options: [.alert, .sound])
        } catch {
            ClockOffLog.app.info("notification permission request failed: \(String(describing: error), privacy: .public)")
            return false
        }
    }

    func replacePlanned(_ planned: [PlannedNotification], timeZone: TimeZone) async {
        guard await isAuthorized() else { return }
        let pending = await center.pendingNotificationRequests().map(\.identifier).filter(NotificationPlanner.isOurs)
        if !pending.isEmpty { center.removePendingNotificationRequests(withIdentifiers: pending) }
        for item in planned {
            let content = UNMutableNotificationContent()
            content.title = item.title
            content.body = item.body
            content.sound = .default
            var components = deviceComponents(for: item.fireAt, in: timeZone)
            components.calendar = nil
            let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
            do {
                try await center.add(UNNotificationRequest(identifier: item.id, content: content, trigger: trigger))
            } catch {
                ClockOffLog.app.error("scheduling \(item.id, privacy: .public) failed: \(String(describing: error), privacy: .public)")
            }
        }
        ClockOffLog.app.info("local notifications planned: \(planned.count)")
    }

    func postNow(id: String, title: String, body: String) async {
        guard await isAuthorized() else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        do {
            try await center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
        } catch {
            ClockOffLog.app.error("posting \(id, privacy: .public) failed: \(String(describing: error), privacy: .public)")
        }
    }

    func cancelAll() async {
        let pending = await center.pendingNotificationRequests().map(\.identifier).filter(NotificationPlanner.isOurs)
        if !pending.isEmpty { center.removePendingNotificationRequests(withIdentifiers: pending) }
        let delivered = await center.deliveredNotifications().map(\.request.identifier).filter(NotificationPlanner.isOurs)
        if !delivered.isEmpty { center.removeDeliveredNotifications(withIdentifiers: delivered) }
    }

    private func isAuthorized() async -> Bool {
        switch await center.notificationSettings().authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            return true
        case .notDetermined, .denied:
            return false
        @unknown default:
            return false
        }
    }
}
