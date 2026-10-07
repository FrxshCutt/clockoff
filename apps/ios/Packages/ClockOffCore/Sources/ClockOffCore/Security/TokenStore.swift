import Foundation
import Security

/// Persistent storage for the device's access/refresh token pair.
public protocol TokenStore: AnyObject {
    func loadTokens() throws -> TokenPair?
    func saveTokens(_ tokens: TokenPair) throws
    func deleteTokens() throws
}

public struct KeychainError: Error, Equatable, LocalizedError {
    public let status: OSStatus

    public init(status: OSStatus) {
        self.status = status
    }

    public var errorDescription: String? {
        let message = SecCopyErrorMessageString(status, nil) as String? ?? "Unknown error"
        return "Keychain error \(status): \(message)"
    }

    /// errSecMissingEntitlement: the process has no keychain access group (e.g. an unsigned simulator build).
    public var isMissingEntitlement: Bool { status == errSecMissingEntitlement }
}

/// Keychain-backed token store: one generic-password item holding the JSON-encoded `TokenPair`, so the
/// access and refresh tokens are always replaced together.
///
/// Accessibility is `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: readable by background refresh after
/// the first unlock, and never restored to another phone from a backup (a refresh token is bound to one
/// `Device` row; a copy on a second phone would trip the server's reuse detection and sign both out).
public final class KeychainTokenStore: TokenStore {
    public static let defaultService = "online.clockoff.app.auth"
    private static let account = "device-token-pair"

    private let service: String
    private let accessGroup: String?

    public init(service: String = KeychainTokenStore.defaultService, accessGroup: String? = nil) {
        self.service = service
        self.accessGroup = accessGroup
    }

    public func loadTokens() throws -> TokenPair? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let data = item as? Data else { return nil }
            return try JSONDecoder.clockOff.decode(TokenPair.self, from: data)
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainError(status: status)
        }
    }

    public func saveTokens(_ tokens: TokenPair) throws {
        let data = try JSONEncoder.clockOff.encode(tokens)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updateStatus = SecItemUpdate(baseQuery() as CFDictionary, attributes as CFDictionary)
        switch updateStatus {
        case errSecSuccess:
            return
        case errSecItemNotFound:
            var add = baseQuery()
            add.merge(attributes) { _, new in new }
            let addStatus = SecItemAdd(add as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw KeychainError(status: addStatus) }
        default:
            throw KeychainError(status: updateStatus)
        }
    }

    public func deleteTokens() throws {
        let status = SecItemDelete(baseQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }

    private func baseQuery() -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: KeychainTokenStore.account,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }
}

/// Wraps the persistent store (Keychain) so a token pair is never lost because persisting it failed.
///
/// Refresh tokens are single-use: once `/auth/refresh` has rotated the pair, the old refresh token is dead and
/// presenting it again is treated by the server as reuse, which revokes the device's session. So when the base
/// store refuses a save, the pair is kept in memory, served by `loadTokens()` and the save is retried on every
/// later access, instead of surfacing an error and leaving the stale pair in the Keychain. `deleteTokens()`
/// always clears the in-memory pair too. Every component (APIClient, TokenRefresher, sign-out) must share the
/// same instance.
public final class ResilientTokenStore: TokenStore {
    private let base: TokenStore
    private let lock = NSLock()
    private var unpersisted: TokenPair?

    public init(base: TokenStore) {
        self.base = base
    }

    /// True while a pair is held in memory only (the base store refused it).
    public var hasUnpersistedTokens: Bool {
        lock.lock()
        defer { lock.unlock() }
        return unpersisted != nil
    }

    public func loadTokens() throws -> TokenPair? {
        lock.lock()
        defer { lock.unlock() }
        if let pending = unpersisted {
            if (try? base.saveTokens(pending)) != nil {
                unpersisted = nil
            }
            return pending
        }
        return try base.loadTokens()
    }

    /// Never throws: a pair the base store refuses is kept in memory (see the type documentation).
    public func saveTokens(_ tokens: TokenPair) throws {
        lock.lock()
        defer { lock.unlock() }
        do {
            try base.saveTokens(tokens)
            unpersisted = nil
        } catch {
            unpersisted = tokens
            ClockOffLog.storage.error("token pair could not be persisted; keeping it in memory: \(String(describing: error), privacy: .public)")
        }
    }

    public func deleteTokens() throws {
        lock.lock()
        defer { lock.unlock() }
        unpersisted = nil
        try base.deleteTokens()
    }
}

/// Process-local token store for tests and previews.
public final class InMemoryTokenStore: TokenStore {
    private let lock = NSLock()
    private var tokens: TokenPair?

    public init(tokens: TokenPair? = nil) {
        self.tokens = tokens
    }

    public func loadTokens() throws -> TokenPair? {
        lock.lock()
        defer { lock.unlock() }
        return tokens
    }

    public func saveTokens(_ tokens: TokenPair) throws {
        lock.lock()
        defer { lock.unlock() }
        self.tokens = tokens
    }

    public func deleteTokens() throws {
        lock.lock()
        defer { lock.unlock() }
        tokens = nil
    }
}
