import Foundation
import ManagedSettings
import os
import WorkModeCore

/// Handles taps on the shield's buttons. "OK" closes the shielded app. "Open ClockOff" cannot launch the app
/// from here; it sets the App Group flag `openStatusRequested`, which the app consumes on its next foreground
/// to show the status screen, then closes the shielded app. Nothing about which app was shielded or tapped is
/// recorded or sent anywhere (§12).
final class ShieldActionExtension: ShieldActionDelegate {
    private let logger = Logger(subsystem: WorkModeLog.subsystem, category: "shieldaction")

    override func handle(action: ShieldAction, for application: ApplicationToken, completionHandler: @escaping (ShieldActionResponse) -> Void) {
        completionHandler(response(for: action))
    }

    override func handle(action: ShieldAction, for webDomain: WebDomainToken, completionHandler: @escaping (ShieldActionResponse) -> Void) {
        completionHandler(response(for: action))
    }

    override func handle(action: ShieldAction, for category: ActivityCategoryToken, completionHandler: @escaping (ShieldActionResponse) -> Void) {
        completionHandler(response(for: action))
    }

    private func response(for action: ShieldAction) -> ShieldActionResponse {
        switch action {
        case .primaryButtonPressed:
            return .close
        case .secondaryButtonPressed:
            if let flags = SharedFlags.appGroup() {
                flags.openStatusRequested = true
            } else {
                logger.error("App Group unavailable: cannot record the status request")
            }
            return .close
        default:
            // Work Mode's shield has no submenu. Newer SDKs add submenu actions (absent from older SDKs such as
            // the Xcode 26.3 CI image), so they are handled here rather than by name: any of them closes.
            logger.info("other shield action")
            return .close
        }
    }
}
