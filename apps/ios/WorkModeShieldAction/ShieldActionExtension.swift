import Foundation
import ManagedSettings
import os
import WorkModeCore

/// Handles taps on the shield's buttons. The only button closes the shielded app; nothing about which
/// app was shielded or tapped is recorded or sent anywhere (§12).
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
            return .defer
        case .firstSecondarySubmenuItemPressed, .secondSecondarySubmenuItemPressed, .thirdSecondarySubmenuItemPressed:
            // Work Mode's shield has no submenu; treat any submenu tap like the primary button.
            return .close
        @unknown default:
            logger.info("unknown shield action")
            return .close
        }
    }
}
