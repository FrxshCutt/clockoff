import UIKit
import WorkModeCore

/// UIKit entry points SwiftUI does not cover: background refresh registration and remote notifications.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        guard !AppRuntime.isRunningUnitTests else { return true }
        BackgroundRefresh.register {
            let outcome = await DependencyContainer.shared.syncCoordinator.sync(reason: .backgroundRefresh)
            return outcome.succeeded
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let container = DependencyContainer.shared
        let request = PushTokenRequest(token: PushTokenRequest.hexString(from: deviceToken), environment: container.configuration.pushEnvironment)
        Task {
            guard container.api.hasCredentials() else { return }
            do {
                try await container.api.registerPushToken(request)
            } catch {
                WorkModeLog.app.error("push token registration failed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        WorkModeLog.app.info("remote notifications unavailable: \(String(describing: error), privacy: .public)")
    }

    /// Silent push from the server ("something changed, sync"). Payloads carry no data beyond that hint.
    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        Task {
            let outcome = await DependencyContainer.shared.syncCoordinator.sync(reason: .silentPush)
            completionHandler(outcome.succeeded ? .newData : .failed)
        }
    }
}
