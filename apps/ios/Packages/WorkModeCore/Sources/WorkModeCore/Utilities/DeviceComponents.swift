import Foundation

/// Wall-clock `DateComponents` for an absolute instant in `timeZone`, for `DeviceActivitySchedule`.
///
/// DeviceActivity schedules are expressed in calendar components, not instants. Work Mode stores every
/// instant in UTC and converts only here, at the edge, using the zone the device is in *now*. The result
/// carries a Gregorian calendar and the zone, plus year/month/day/hour/minute/second, so it identifies one
/// specific (non-repeating) moment:
///   - overnight shifts: the end components simply fall on the next calendar day;
///   - spring-forward: instants inside the skipped hour cannot occur, the components of the real instant
///     are returned (e.g. 01:00Z on the Europe/London change day is 02:00 BST);
///   - fall-back: two instants an hour apart share the same wall clock (01:30 BST and 01:30 GMT). The
///     components are identical, and resolving them picks the first occurrence — callers that need the
///     exact instant keep the UTC `Date` alongside (see `ActivityPlan.plannedEnd`).
public func deviceComponents(for date: Date, in timeZone: TimeZone) -> DateComponents {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    var components = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
    components.calendar = calendar
    components.timeZone = timeZone
    return components
}

extension DateComponents {
    /// Resolves components produced by `deviceComponents(for:in:)` back to an instant (first occurrence
    /// for an ambiguous fall-back wall-clock time). Nil when the components are incomplete.
    public func resolvedDate() -> Date? {
        var calendar = self.calendar ?? Calendar(identifier: .gregorian)
        if let timeZone { calendar.timeZone = timeZone }
        return calendar.date(from: self)
    }
}
