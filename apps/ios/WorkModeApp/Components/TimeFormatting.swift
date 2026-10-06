import Foundation

/// Presentation of UTC instants in the device's timezone (the only place local time appears).
struct TimeFormatting {
    let timeZone: TimeZone
    let now: Date

    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar
    }

    /// "09:00" / "9:00 AM" per the user's locale.
    func clock(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.timeZone = timeZone
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    /// "Today", "Tomorrow" or "Thu 8 Oct".
    func day(_ date: Date) -> String {
        if calendar.isDate(date, inSameDayAs: now) { return "Today" }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(date, inSameDayAs: tomorrow) {
            return "Tomorrow"
        }
        let formatter = DateFormatter()
        formatter.timeZone = timeZone
        formatter.setLocalizedDateFormatFromTemplate("EEEdMMM")
        return formatter.string(from: date)
    }

    func dayAndClock(_ date: Date) -> String {
        "\(day(date).lowercasedIfRelative) at \(clock(date))"
    }

    func range(_ start: Date, _ end: Date) -> String {
        "\(clock(start)) – \(clock(end))"
    }

    /// "just now" within a minute either side (sub-second clock jitter otherwise reads "in 0 seconds"),
    /// then "5 minutes ago", "2 hours ago", …
    func relative(_ date: Date) -> String {
        if abs(date.timeIntervalSince(now)) < 60 { return "just now" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter.localizedString(for: min(date, now), relativeTo: now)
    }

    func dateTime(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.timeZone = timeZone
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    func isSameDay(_ a: Date, _ b: Date) -> Bool {
        calendar.isDate(a, inSameDayAs: b)
    }

    func startOfDay(_ date: Date) -> Date {
        calendar.startOfDay(for: date)
    }

    static func duration(_ seconds: TimeInterval) -> String {
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = [.hour, .minute]
        formatter.unitsStyle = .abbreviated
        return formatter.string(from: seconds) ?? ""
    }
}

private extension String {
    /// "Today" → "today" inside a sentence; weekday names keep their capital.
    var lowercasedIfRelative: String {
        self == "Today" || self == "Tomorrow" ? lowercased() : self
    }
}
