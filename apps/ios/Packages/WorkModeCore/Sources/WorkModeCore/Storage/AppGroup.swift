import Foundation

/// Identifiers shared by the app and its extensions. Must match the entitlements files and
/// `Config/Signing.xcconfig` (`CLOCKOFF_APP_GROUP`).
public enum AppGroup {
    public static let identifier = "group.online.clockoff.app.shared"
}

/// Small key/value store for flags and scalars shared between the app and extensions.
public protocol KeyValueStore: AnyObject {
    func data(forKey key: String) -> Data?
    func set(_ data: Data?, forKey key: String)
    func removeValue(forKey key: String)
}

extension KeyValueStore {
    public func string(forKey key: String) -> String? {
        data(forKey: key).flatMap { String(data: $0, encoding: .utf8) }
    }

    public func set(_ string: String?, forKey key: String) {
        set(string.map { Data($0.utf8) }, forKey: key)
    }

    public func bool(forKey key: String) -> Bool {
        string(forKey: key) == "1"
    }

    public func set(_ flag: Bool, forKey key: String) {
        set(flag ? "1" : "0", forKey: key)
    }

    public func decodable<T: Decodable>(_ type: T.Type, forKey key: String) -> T? {
        guard let data = data(forKey: key) else { return nil }
        return try? JSONDecoder.workMode.decode(T.self, from: data)
    }

    public func setEncodable<T: Encodable>(_ value: T?, forKey key: String) throws {
        guard let value else {
            removeValue(forKey: key)
            return
        }
        set(try JSONEncoder.workMode.encode(value), forKey: key)
    }
}

/// `UserDefaults(suiteName:)` backed store; with the App Group suite it is shared with the extensions.
public final class UserDefaultsKeyValueStore: KeyValueStore {
    private let defaults: UserDefaults

    public init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    /// Nil when the suite cannot be opened (e.g. App Group entitlement missing).
    public convenience init?(suiteName: String) {
        guard let defaults = UserDefaults(suiteName: suiteName) else { return nil }
        self.init(defaults: defaults)
    }

    public func data(forKey key: String) -> Data? {
        defaults.data(forKey: key)
    }

    public func set(_ data: Data?, forKey key: String) {
        if let data {
            defaults.set(data, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }

    public func removeValue(forKey key: String) {
        defaults.removeObject(forKey: key)
    }
}

/// Process-local store for tests and previews.
public final class InMemoryKeyValueStore: KeyValueStore {
    private let lock = NSLock()
    private var values: [String: Data] = [:]

    public init() {}

    public func data(forKey key: String) -> Data? {
        lock.lock()
        defer { lock.unlock() }
        return values[key]
    }

    public func set(_ data: Data?, forKey key: String) {
        lock.lock()
        defer { lock.unlock() }
        values[key] = data
    }

    public func removeValue(forKey key: String) {
        set(nil, forKey: key)
    }
}
