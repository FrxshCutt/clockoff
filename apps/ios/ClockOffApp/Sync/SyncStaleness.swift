import Foundation

/// The "sync delayed" banner: shown when the last successful sync is more than an hour old. Separate from the
/// Home card's SYNC DELAYED state (`UIWorkStateBuilder`, 6 h, off shift only) — the banner warns earlier and in
/// every state, because changes a manager makes will not reach the phone until it is online again.
enum SyncStaleness {
    static let bannerThreshold: TimeInterval = 60 * 60

    static func isStale(lastSyncAt: Date?, now: Date) -> Bool {
        guard let lastSyncAt else { return true }
        return now.timeIntervalSince(lastSyncAt) > bannerThreshold
    }

    /// "Last synced 2h ago · changes will apply when online", or nil when the sync is fresh.
    static func banner(lastSyncAt: Date?, now: Date) -> String? {
        guard isStale(lastSyncAt: lastSyncAt, now: now) else { return nil }
        guard let lastSyncAt else { return "Not synced yet · changes will apply when online" }
        return "Last synced \(compactAge(from: lastSyncAt, to: now)) ago · changes will apply when online"
    }

    /// "35m", "2h", "3d".
    static func compactAge(from earlier: Date, to now: Date) -> String {
        let seconds = max(0, now.timeIntervalSince(earlier))
        let minutes = Int(seconds / 60)
        if minutes < 60 { return "\(max(1, minutes))m" }
        let hours = minutes / 60
        if hours < 48 { return "\(hours)h" }
        return "\(hours / 24)d"
    }
}
