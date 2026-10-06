import Foundation
import WorkModeCore

/// One day of the Schedule tab.
struct ScheduleDaySection: Equatable, Identifiable {
    /// Start of the day in the device's zone.
    let id: Date
    let title: String
    let shifts: [ScheduleShiftRow]
}

/// One shift as the Schedule tab shows it (informational only).
struct ScheduleShiftRow: Equatable, Identifiable {
    enum Status: Equatable {
        case ended
        case inProgress
        case upcoming
    }

    let id: String
    /// "09:00 – 17:00"
    let timeRange: String
    /// "+1" when the shift ends on the next calendar day.
    let overnightSuffix: String?
    let duration: String
    let location: String?
    let status: Status
    /// Scheduled breaks, e.g. "10:30 – 10:45 · 15 min".
    let breaks: [String]
    /// Shown when the shift was created in another zone.
    let timezoneNote: String?
}

/// Pure grouping of the cached shifts for the Schedule tab: today plus the next 14 days, by day, in the phone's zone.
enum ScheduleViewModel {
    static let windowDays = 14

    static func sections(shifts: [Shift], now: Date, timeZone: TimeZone) -> [ScheduleDaySection] {
        let time = TimeFormatting(timeZone: timeZone, now: now)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let startOfToday = calendar.startOfDay(for: now)
        guard let windowEnd = calendar.date(byAdding: .day, value: windowDays + 1, to: startOfToday) else { return [] }

        let visible = shifts
            .filter { $0.isEffective && $0.endsAt > startOfToday && $0.startsAt < windowEnd }
            .sorted { $0.startsAt == $1.startsAt ? $0.id < $1.id : $0.startsAt < $1.startsAt }

        var grouped: [Date: [ScheduleShiftRow]] = [:]
        for shift in visible {
            // A shift that started before today and is still running belongs to today.
            let day = calendar.startOfDay(for: max(shift.startsAt, startOfToday))
            grouped[day, default: []].append(row(for: shift, now: now, time: time, timeZone: timeZone))
        }
        var sections = grouped.keys.sorted().map { day in
            ScheduleDaySection(id: day, title: time.day(day), shifts: grouped[day] ?? [])
        }
        if sections.first?.id != startOfToday {
            sections.insert(ScheduleDaySection(id: startOfToday, title: time.day(startOfToday), shifts: []), at: 0)
        }
        return sections
    }

    static func row(for shift: Shift, now: Date, time: TimeFormatting, timeZone: TimeZone) -> ScheduleShiftRow {
        let status: ScheduleShiftRow.Status
        if shift.endsAt <= now {
            status = .ended
        } else if shift.startsAt <= now {
            status = .inProgress
        } else {
            status = .upcoming
        }
        let breaks = shift.scheduledBreaks
            .sorted { $0.startsAt < $1.startsAt }
            .map { "\(time.range($0.startsAt, $0.endsAt)) · \($0.durationMinutes) min" }
        return ScheduleShiftRow(
            id: shift.id,
            timeRange: time.range(shift.startsAt, shift.endsAt),
            overnightSuffix: time.isSameDay(shift.startsAt, shift.endsAt) ? nil : "+1",
            duration: TimeFormatting.duration(shift.endsAt.timeIntervalSince(shift.startsAt)),
            location: shift.location?.name,
            status: status,
            breaks: breaks,
            timezoneNote: shift.timezone == timeZone.identifier ? nil : "Scheduled in \(shift.timezone); shown in your phone's time."
        )
    }
}
