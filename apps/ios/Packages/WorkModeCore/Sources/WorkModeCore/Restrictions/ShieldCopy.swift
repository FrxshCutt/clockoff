import Foundation

/// The words on the shield screen (ShieldConfiguration extension), derived from `plans.json` only — never from
/// the shielded app or anything about how the phone is used (§12). Pure, so the extension stays tiny and the
/// copy is unit-tested here.
public struct ShieldCopy: Equatable, Sendable {
    public static let defaultTitle = "ClockOff"
    public static let defaultSubtitle = "This app is paused while you're on shift."
    public static let primaryButtonTitle = "OK"
    public static let secondaryButtonTitle = "Open ClockOff"

    /// The employer's name when known, else "ClockOff".
    public var title: String
    /// The policy's shield message, else "Work Mode is active until HH:mm", else the default line.
    public var subtitle: String

    public init(title: String, subtitle: String) {
        self.title = title
        self.subtitle = subtitle
    }

    public static func make(plans: PlansFile?, now: Date, timeZone: TimeZone, locale: Locale = .current) -> ShieldCopy {
        let title = plans?.organisationName.flatMap { $0.isEmpty ? nil : $0 } ?? defaultTitle
        guard let plans else { return ShieldCopy(title: title, subtitle: defaultSubtitle) }

        let covering = plans.shiftEntries(covering: now)
        let message = (covering.map(\.plan) + plans.entries.values.map(\.plan))
            .compactMap(\.shieldMessage)
            .first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        if let message { return ShieldCopy(title: title, subtitle: message) }

        if let end = covering.first?.plannedEnd {
            return ShieldCopy(title: title, subtitle: "Work Mode is active until \(clock(end, timeZone: timeZone, locale: locale)).")
        }
        return ShieldCopy(title: title, subtitle: defaultSubtitle)
    }

    /// Short local time, e.g. "17:00" or "5:00 PM" per `locale`.
    public static func clock(_ date: Date, timeZone: TimeZone, locale: Locale = .current) -> String {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = timeZone
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
}
