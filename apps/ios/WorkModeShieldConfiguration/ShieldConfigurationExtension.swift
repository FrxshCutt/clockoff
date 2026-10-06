import Foundation
import ManagedSettings
import ManagedSettingsUI
import UIKit
import WorkModeCore

/// Renders the screen shown when the employee opens a shielded app during a shift. Reads the employer
/// name and shield message from `plans.json` in the App Group; falls back to neutral copy.
final class ShieldConfigurationExtension: ShieldConfigurationDataSource {
    override func configuration(shielding application: Application) -> ShieldConfiguration {
        makeConfiguration()
    }

    override func configuration(shielding application: Application, in category: ActivityCategory) -> ShieldConfiguration {
        makeConfiguration()
    }

    override func configuration(shielding webDomain: WebDomain) -> ShieldConfiguration {
        makeConfiguration()
    }

    override func configuration(shielding webDomain: WebDomain, in category: ActivityCategory) -> ShieldConfiguration {
        makeConfiguration()
    }

    private func makeConfiguration() -> ShieldConfiguration {
        let plans = AppGroupFileStore.appGroup().flatMap { PlansStore(fileStore: $0).read() }
        let message = plans?.entries.values.compactMap(\.plan.shieldMessage).first
            ?? "This app is paused while you're on shift."
        let title = plans?.organisationName.map { "Work Mode · \($0)" } ?? "Work Mode"
        return ShieldConfiguration(
            backgroundBlurStyle: .systemMaterial,
            title: ShieldConfiguration.Label(text: title, color: .label),
            subtitle: ShieldConfiguration.Label(text: message, color: .secondaryLabel),
            primaryButtonLabel: ShieldConfiguration.Label(text: "OK", color: .white),
            primaryButtonBackgroundColor: .systemIndigo
        )
    }
}
