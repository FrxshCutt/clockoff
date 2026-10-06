import Foundation
import WorkModeCore

/// Decides which break session the cache keeps after `GET /sync`. The server is authoritative, except for a
/// break the phone started or ended while offline and has not managed to replay yet: that one must survive
/// the sync, or the relaxation (or its end) would be undone until the replay succeeds.
enum BreakSessionMerge {
    static func merge(local: BreakSession?, remote: BreakSession?, queued: [QueuedBreakRecord]) -> BreakSession? {
        guard let local else { return remote }
        let pending = queued.contains { $0.clientBreakId.lowercased() == local.clientBreakId.lowercased() }
        return pending ? local : remote
    }
}
