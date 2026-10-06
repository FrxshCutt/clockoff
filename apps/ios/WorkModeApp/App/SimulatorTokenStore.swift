// DEVELOPMENT ONLY — Debug builds running in the iOS Simulator.
//
// `make build` / `make test` produce unsigned simulator builds (CODE_SIGNING_ALLOWED=NO), and an unsigned app
// has no keychain access group: every Keychain call fails with errSecMissingEntitlement (-34018), so the
// simulator could never finish joining. This store uses the Keychain whenever it works and, only for that
// specific error, keeps the token pair in a protected file in the app's own (non-shared) container instead.
// It is compiled only for `DEBUG && targetEnvironment(simulator)`: device and Release builds always use
// `KeychainTokenStore` directly and cannot reach this code.
#if DEBUG && targetEnvironment(simulator)
import Foundation
import WorkModeCore

final class SimulatorTokenStore: TokenStore {
    private let primary: TokenStore
    private let fileURL: URL
    private let lock = NSLock()
    private var usingFallback = false

    /// - Parameters:
    ///   - primary: the Keychain store (injectable for tests).
    ///   - directory: where the fallback file lives (default: Application Support/WorkModeDevelopment).
    init(primary: TokenStore = KeychainTokenStore(), directory: URL? = nil) {
        self.primary = primary
        let base = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("WorkModeDevelopment", isDirectory: true)
        fileURL = base.appendingPathComponent("simulator-tokens.json", isDirectory: false)
    }

    /// True once the Keychain reported a missing entitlement and the file is in use.
    var isUsingFallback: Bool {
        lock.lock()
        defer { lock.unlock() }
        return usingFallback
    }

    func loadTokens() throws -> TokenPair? {
        try withFallback(primary: { try primary.loadTokens() }, fallback: {
            guard FileManager.default.fileExists(atPath: fileURL.path) else { return nil }
            return try JSONDecoder.workMode.decode(TokenPair.self, from: Data(contentsOf: fileURL))
        })
    }

    func saveTokens(_ tokens: TokenPair) throws {
        try withFallback(primary: { try primary.saveTokens(tokens) }, fallback: {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder.workMode.encode(tokens).write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        })
    }

    func deleteTokens() throws {
        try withFallback(primary: { try primary.deleteTokens() }, fallback: {
            if FileManager.default.fileExists(atPath: fileURL.path) {
                try FileManager.default.removeItem(at: fileURL)
            }
        })
    }

    private func withFallback<T>(primary operation: () throws -> T, fallback: () throws -> T) throws -> T {
        if !isUsingFallback {
            do {
                return try operation()
            } catch let error as KeychainError where error.isMissingEntitlement {
                lock.lock()
                usingFallback = true
                lock.unlock()
                WorkModeLog.app.error("Keychain unavailable in this unsigned simulator build; using the development token file")
            }
        }
        return try fallback()
    }
}
#endif
