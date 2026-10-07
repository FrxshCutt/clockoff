import Foundation

/// Small flags the app and its extensions pass to each other through the App Group `UserDefaults` suite.
/// Operational only: never anything about which apps were shielded or opened (§12).
public final class SharedFlags {
    public enum Keys {
        public static let openStatusRequested = "clockoff.flags.openStatusRequested"
        public static let shiftStartingSoon = "clockoff.flags.shiftStartingSoon"
        public static let selectionIncomplete = "clockoff.flags.selectionIncomplete"
        public static let lastMonitorCallback = "clockoff.flags.lastMonitorCallback"
    }

    /// Written by the monitor extension at `intervalWillStartWarning`.
    public struct ShiftStartingSoon: Codable, Equatable, Sendable {
        public var activityName: String
        public var shiftId: String
        public var at: Date

        public init(activityName: String, shiftId: String, at: Date) {
            self.activityName = activityName
            self.shiftId = shiftId
            self.at = at
        }
    }

    /// The last DeviceActivity callback the monitor extension handled (diagnostics for the app).
    public struct MonitorCallback: Codable, Equatable, Sendable {
        public var kind: String
        public var activityName: String
        public var at: Date
        public var outcome: String

        public init(kind: String, activityName: String, at: Date, outcome: String) {
            self.kind = kind
            self.activityName = activityName
            self.at = at
            self.outcome = outcome
        }
    }

    private let store: KeyValueStore

    public init(store: KeyValueStore) {
        self.store = store
    }

    /// Flags in the App Group suite, or nil when the suite cannot be opened (App Group entitlement missing).
    public static func appGroup(identifier: String = AppGroup.identifier) -> SharedFlags? {
        UserDefaultsKeyValueStore(suiteName: identifier).map(SharedFlags.init)
    }

    /// Set by the ShieldAction extension when the employee taps "Open ClockOff" on the shield; the app reads
    /// and clears it on its next foreground to show the status screen.
    public var openStatusRequested: Bool {
        get { store.bool(forKey: Keys.openStatusRequested) }
        set { store.set(newValue, forKey: Keys.openStatusRequested) }
    }

    /// Returns the flag and clears it in one step.
    @discardableResult
    public func consumeOpenStatusRequest() -> Bool {
        let requested = openStatusRequested
        if requested { store.removeValue(forKey: Keys.openStatusRequested) }
        return requested
    }

    public var shiftStartingSoon: ShiftStartingSoon? {
        get { store.decodable(ShiftStartingSoon.self, forKey: Keys.shiftStartingSoon) }
        set { try? store.setEncodable(newValue, forKey: Keys.shiftStartingSoon) }
    }

    /// True when a RELAX_CATEGORIES break had to fall back to KEEP_RESTRICTIONS because no `breakKept`
    /// selection exists. The app shows "Selection incomplete" and offers the second picker.
    public var selectionIncomplete: Bool {
        get { store.bool(forKey: Keys.selectionIncomplete) }
        set { store.set(newValue, forKey: Keys.selectionIncomplete) }
    }

    public var lastMonitorCallback: MonitorCallback? {
        get { store.decodable(MonitorCallback.self, forKey: Keys.lastMonitorCallback) }
        set { try? store.setEncodable(newValue, forKey: Keys.lastMonitorCallback) }
    }

    public func clearAll() {
        store.removeValue(forKey: Keys.openStatusRequested)
        store.removeValue(forKey: Keys.shiftStartingSoon)
        store.removeValue(forKey: Keys.selectionIncomplete)
        store.removeValue(forKey: Keys.lastMonitorCallback)
    }
}
