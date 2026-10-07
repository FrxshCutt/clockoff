import Foundation
import ManagedSettings
import ManagedSettingsUI
import UIKit
import ClockOffCore

/// Renders the neutral card shown over a shielded app during a shift. The copy comes from `plans.json` in the
/// App Group (`ShieldCopy`): the employer's name, the policy's shield message or "Work Mode is active until
/// HH:mm" in the device's time zone. Nothing about the shielded app is read, stored or sent (§12).
///
/// "Open ClockOff" cannot open the app itself; the ShieldAction extension records the tap and the app shows
/// its status screen on its next foreground.
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
        // plans.json is small and written by the app; state.json (shifts, outbox) is deliberately not read here.
        let plans = AppGroupFileStore.appGroup().flatMap { PlansStore(fileStore: $0).read() }
        let copy = ShieldCopy.make(plans: plans, now: Date(), timeZone: .current)
        return ShieldConfiguration(
            backgroundBlurStyle: .systemMaterial,
            backgroundColor: nil,
            icon: UIImage(named: "ShieldIcon"),
            title: ShieldConfiguration.Label(text: copy.title, color: .label),
            subtitle: ShieldConfiguration.Label(text: copy.subtitle, color: .secondaryLabel),
            primaryButtonLabel: ShieldConfiguration.Label(text: ShieldCopy.primaryButtonTitle, color: .white),
            primaryButtonBackgroundColor: .systemIndigo,
            secondaryButtonLabel: ShieldConfiguration.Label(text: ShieldCopy.secondaryButtonTitle, color: .systemIndigo)
        )
    }
}
