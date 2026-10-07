import Foundation
import ClockOffCore

/// One local notification to schedule. Identifiers are deterministic (`clockoff.shift-<id>-start`, …) so a re-plan
/// replaces the previous request for the same moment instead of duplicating it.
struct PlannedNotification: Equatable, Identifiable, Sendable {
    let id: String
    let title: String
    let body: String
    let fireAt: Date
}

/// Pure planner: turns the cached schedule into the local notifications the employee should receive alongside
/// the DeviceActivity schedules. Never per phone interaction — only shift and break boundaries (§12).
enum NotificationPlanner {
    static let identifierPrefix = "clockoff."
    /// iOS keeps at most 64 pending requests per app; leave room for the immediate ones.
    static let maxPending = 60
    static let breakEndingWarning: TimeInterval = 2 * 60
    static let horizon: TimeInterval = 7 * 24 * 60 * 60

    static let scheduleChangedIdentifier = identifierPrefix + "schedule-changed"
    static let permissionAttentionIdentifier = identifierPrefix + "permission-attention"

    static func shiftWarning(shiftId: String) -> String { "\(identifierPrefix)shift-\(shiftId)-warning" }
    static func shiftStart(shiftId: String) -> String { "\(identifierPrefix)shift-\(shiftId)-start" }
    static func shiftEnd(shiftId: String) -> String { "\(identifierPrefix)shift-\(shiftId)-end" }
    static func breakEnding(clientBreakId: String) -> String { "\(identifierPrefix)break-\(clientBreakId)-ending" }
    static func breakEnded(clientBreakId: String) -> String { "\(identifierPrefix)break-\(clientBreakId)-ended" }

    static func isOurs(_ identifier: String) -> Bool {
        identifier.hasPrefix(identifierPrefix)
    }

    /// Notifications for the merged working intervals in the next 7 days plus the running break, future ones
    /// only, soonest first, capped at `maxPending`. Nothing is planned without a Work Policy (nothing would be
    /// enforced) or before the phone is joined.
    static func plan(cache: CachedState, now: Date, timeZone: TimeZone) -> [PlannedNotification] {
        guard cache.isJoined, let policy = cache.policy else { return [] }
        let time = TimeFormatting(timeZone: timeZone, now: now)
        let warningMinutes = policy.restrictionConfig.preShiftWarningMinutes
        var planned: [PlannedNotification] = []

        let windowEnd = now.addingTimeInterval(horizon)
        let intervals = WorkModeEngine.mergeShiftIntervals(cache.shifts).filter { $0.endsAt > now && $0.startsAt < windowEnd }
        for interval in intervals {
            guard let shiftId = interval.shiftIds.first else { continue }
            if warningMinutes > 0 {
                let warningAt = interval.startsAt.addingTimeInterval(-TimeInterval(warningMinutes * 60))
                if warningAt > now {
                    planned.append(PlannedNotification(
                        id: shiftWarning(shiftId: shiftId),
                        title: "Shift begins soon",
                        body: "Work Mode turns on at \(time.clock(interval.startsAt)).",
                        fireAt: warningAt
                    ))
                }
            }
            if interval.startsAt > now {
                planned.append(PlannedNotification(
                    id: shiftStart(shiftId: shiftId),
                    title: "Work Mode activated",
                    body: "Distracting apps are blocked until \(time.clock(interval.endsAt)).",
                    fireAt: interval.startsAt
                ))
            }
            planned.append(PlannedNotification(
                id: shiftEnd(shiftId: shiftId),
                title: "Work Mode ended",
                body: "Your apps work as normal again.",
                fireAt: interval.endsAt
            ))
        }

        if let session = cache.activeBreakSession, session.status == .active, session.endedAt == nil {
            let shiftEnd = WorkModeEngine.normaliseShifts(cache.shifts).first { $0.id == session.shiftId }?.endsAt
            let effectiveEnd = shiftEnd.map { min($0, session.plannedEndsAt) } ?? session.plannedEndsAt
            // When the shift end cuts the break short, the shift's own "Work Mode ended" notification covers it.
            if effectiveEnd == session.plannedEndsAt, effectiveEnd > now {
                let clientBreakId = session.clientBreakId.isEmpty ? session.id : session.clientBreakId
                let endingAt = effectiveEnd.addingTimeInterval(-breakEndingWarning)
                if endingAt > now {
                    planned.append(PlannedNotification(
                        id: breakEnding(clientBreakId: clientBreakId),
                        title: "Break ending soon",
                        body: "Work Mode resumes at \(time.clock(effectiveEnd)).",
                        fireAt: endingAt
                    ))
                }
                planned.append(PlannedNotification(
                    id: breakEnded(clientBreakId: clientBreakId),
                    title: "Break ended",
                    body: "Work Mode is active again.",
                    fireAt: effectiveEnd
                ))
            }
        }

        return Array(planned.sorted { $0.fireAt == $1.fireAt ? $0.id < $1.id : $0.fireAt < $1.fireAt }.prefix(maxPending))
    }

    /// Immediate notice after a sync changed the schedule.
    static func scheduleChanged() -> (title: String, body: String) {
        ("Schedule changed", "Your shifts were updated. Open ClockOff to see the new schedule.")
    }

    /// Immediate notice when Screen Time access is lost.
    static func permissionAttention() -> (title: String, body: String) {
        ("ClockOff needs attention", "Screen Time access is off, so apps can't be blocked during your shifts. Open ClockOff to fix it.")
    }
}
