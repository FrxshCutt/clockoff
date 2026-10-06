import Foundation
import WorkModeCore

/// Small operational facts about syncing that the extensions never need, kept in the App Group `UserDefaults`
/// suite rather than `state.json`: whether DeviceActivity registration still has to be retried, and when the
/// server was last reached. Operational only (§12).
final class SyncMetadataStore {
    enum Keys {
        static let activitiesNeedReschedule = "wm.sync.activitiesNeedReschedule"
        static let lastServerContactAt = "wm.sync.lastServerContactAt"
        static let lastScheduleChangeNoticeVersion = "wm.sync.lastScheduleChangeNoticeVersion"
    }

    private struct DateBox: Codable {
        var at: Date
    }

    private let store: KeyValueStore

    init(store: KeyValueStore) {
        self.store = store
    }

    /// True when `plans.json` was written but `RestrictionProvider.scheduleActivities` failed: the next sync must
    /// register the activities again even though the plan did not change.
    var activitiesNeedReschedule: Bool {
        get { store.bool(forKey: Keys.activitiesNeedReschedule) }
        set { store.set(newValue, forKey: Keys.activitiesNeedReschedule) }
    }

    /// The last instant any request to the API succeeded (Settings › Connection "server reachability").
    var lastServerContactAt: Date? {
        get { store.decodable(DateBox.self, forKey: Keys.lastServerContactAt)?.at }
        set { try? store.setEncodable(newValue.map(DateBox.init), forKey: Keys.lastServerContactAt) }
    }

    /// The schedule version the "Schedule changed" notification was last posted for (never twice per version).
    var lastScheduleChangeNoticeVersion: Int? {
        get { store.string(forKey: Keys.lastScheduleChangeNoticeVersion).flatMap(Int.init) }
        set { store.set(newValue.map(String.init), forKey: Keys.lastScheduleChangeNoticeVersion) }
    }

    func clear() {
        store.removeValue(forKey: Keys.activitiesNeedReschedule)
        store.removeValue(forKey: Keys.lastServerContactAt)
        store.removeValue(forKey: Keys.lastScheduleChangeNoticeVersion)
    }
}
