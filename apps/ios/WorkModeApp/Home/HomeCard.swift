import Foundation
import WorkModeCore

/// The single state card on Home. Derived from the on-device engine output plus local health signals.
struct HomeCard: Equatable {
    enum Kind: Equatable {
        case offShift
        case startingSoon
        case workModeActive
        case breakActive
        case pausedByManager
        case actionRequired
        case syncDelayed
    }

    let kind: Kind
    let title: String
    let message: String
    let systemImage: String

    /// No successful sync for this long while nothing else needs saying → SYNC DELAYED.
    static let staleSyncInterval: TimeInterval = 6 * 60 * 60

    static func make(
        expected: ExpectedState?,
        cache: CachedState,
        permission: PermissionState,
        hasSelection: Bool,
        now: Date,
        timeZone: TimeZone
    ) -> HomeCard {
        let time = TimeFormatting(timeZone: timeZone, now: now)

        if !permission.isApproved {
            return HomeCard(kind: .actionRequired, title: "ACTION REQUIRED",
                            message: "Screen Time access is off, so Work Mode can't block apps during your shifts. Finish setup to turn it back on.",
                            systemImage: "exclamationmark.triangle.fill")
        }
        if !hasSelection {
            return HomeCard(kind: .actionRequired, title: "ACTION REQUIRED",
                            message: "Choose the apps to block during your shifts.",
                            systemImage: "exclamationmark.triangle.fill")
        }
        guard let expected else {
            return syncDelayedCard(cache: cache, time: time)
        }

        switch expected.state {
        case .working, .shiftEnding:
            let end = expected.workingInterval?.endsAt ?? expected.activeShift?.endsAt
            var message = end.map { "Distracting apps are blocked until \(time.clock($0))." } ?? "Distracting apps are blocked during your shift."
            if expected.effectiveRestriction == .breakRelaxed {
                message = "Your manager has temporarily allowed some apps." + (end.map { " Work Mode ends at \(time.clock($0))." } ?? "")
            }
            return HomeCard(kind: .workModeActive, title: "WORK MODE ACTIVE", message: message, systemImage: "lock.shield.fill")
        case .onBreak:
            let end = expected.activeBreak?.endsAt
            return HomeCard(kind: .breakActive, title: "BREAK ACTIVE",
                            message: end.map { "Enjoy your break. Work Mode resumes at \(time.clock($0))." } ?? "Enjoy your break.",
                            systemImage: "cup.and.saucer.fill")
        case .shiftStartingSoon:
            let start = expected.workingInterval?.startsAt ?? expected.upcomingShift?.startsAt
            return HomeCard(kind: .startingSoon, title: "STARTING SOON",
                            message: start.map { "Your shift starts at \(time.clock($0)). Work Mode turns on automatically." } ?? "Your shift starts soon.",
                            systemImage: "clock.badge.exclamationmark.fill")
        case .managerOverride:
            return HomeCard(kind: .pausedByManager, title: "WORK MODE PAUSED",
                            message: "Your manager has paused Work Mode. Apps are not blocked right now.",
                            systemImage: "pause.circle.fill")
        case .permissionError:
            return HomeCard(kind: .actionRequired, title: "ACTION REQUIRED",
                            message: "Work Mode can't apply your workplace's settings. Check Screen Time access in Settings.",
                            systemImage: "exclamationmark.triangle.fill")
        case .syncError, .unknown:
            return syncDelayedCard(cache: cache, time: time)
        case .offShift:
            if isSyncStale(cache: cache, now: now) {
                return syncDelayedCard(cache: cache, time: time)
            }
            let next = expected.upcomingShift.map { "Next shift: \(time.dayAndClock($0.startsAt))." } ?? "No upcoming shifts."
            return HomeCard(kind: .offShift, title: "OFF SHIFT", message: "Your apps work as normal. \(next)", systemImage: "moon.zzz.fill")
        }
    }

    static func isSyncStale(cache: CachedState, now: Date) -> Bool {
        guard let last = cache.lastSyncAt else { return true }
        return now.timeIntervalSince(last) > staleSyncInterval
    }

    private static func syncDelayedCard(cache: CachedState, time: TimeFormatting) -> HomeCard {
        let last = cache.lastSyncAt.map { "Last synced \(time.relative($0))." } ?? "This phone hasn't synced yet."
        return HomeCard(kind: .syncDelayed, title: "SYNC DELAYED",
                        message: "\(last) Connect to the internet and pull down to refresh. Your saved schedule still applies.",
                        systemImage: "arrow.triangle.2.circlepath")
    }
}
