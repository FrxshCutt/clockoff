import XCTest
@testable import ClockOffApp
import ClockOffCore

/// Exercises the real Keychain where the test host has one. Unsigned simulator builds (`make test` runs with
/// CODE_SIGNING_ALLOWED=NO) may have no keychain access group; the test is skipped there rather than faked.
final class KeychainTokenStoreTests: XCTestCase {
    private let store = KeychainTokenStore(service: "online.clockoff.app.tests.\(UUID().uuidString)")

    override func tearDown() {
        try? store.deleteTokens()
        super.tearDown()
    }

    func testSaveReadReplaceDelete() throws {
        let first = TokenPair(accessToken: "access-1", refreshToken: "refresh-1-0123456789abcdef",
                              accessTokenExpiresAt: iso("2026-10-06T09:15:00Z"), refreshTokenExpiresAt: iso("2027-01-04T09:00:00Z"))
        do {
            try store.saveTokens(first)
        } catch let error as KeychainError where error.isMissingEntitlement {
            throw XCTSkip("No keychain access in this (unsigned) test host: \(error.localizedDescription)")
        }
        XCTAssertEqual(try store.loadTokens(), first)

        var second = first
        second.accessToken = "access-2"
        second.refreshToken = "refresh-2-0123456789abcdef"
        try store.saveTokens(second)
        XCTAssertEqual(try store.loadTokens(), second, "a save replaces both tokens together")

        try store.deleteTokens()
        XCTAssertNil(try store.loadTokens())
        XCTAssertNoThrow(try store.deleteTokens(), "deleting nothing is not an error")
    }
}

#if DEBUG && targetEnvironment(simulator)
final class SimulatorTokenStoreTests: XCTestCase {
    private final class MissingEntitlementKeychain: TokenStore {
        var calls = 0
        func loadTokens() throws -> TokenPair? { calls += 1; throw KeychainError(status: errSecMissingEntitlement) }
        func saveTokens(_ tokens: TokenPair) throws { calls += 1; throw KeychainError(status: errSecMissingEntitlement) }
        func deleteTokens() throws { calls += 1; throw KeychainError(status: errSecMissingEntitlement) }
    }

    private final class OtherFailureKeychain: TokenStore {
        func loadTokens() throws -> TokenPair? { throw KeychainError(status: errSecInteractionNotAllowed) }
        func saveTokens(_ tokens: TokenPair) throws { throw KeychainError(status: errSecInteractionNotAllowed) }
        func deleteTokens() throws { throw KeychainError(status: errSecInteractionNotAllowed) }
    }

    private let tokens = TokenPair(accessToken: "a", refreshToken: "r-0123456789abcdefghij",
                                   accessTokenExpiresAt: iso("2026-10-06T09:15:00Z"), refreshTokenExpiresAt: iso("2027-01-04T09:00:00Z"))

    private func temporaryDirectory() -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("SimulatorTokenStoreTests-\(UUID().uuidString)", isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    func testFallsBackToFileOnlyWhenTheKeychainEntitlementIsMissing() throws {
        let keychain = MissingEntitlementKeychain()
        let store = SimulatorTokenStore(primary: keychain, directory: temporaryDirectory())
        XCTAssertNil(try store.loadTokens())
        XCTAssertTrue(store.isUsingFallback)
        try store.saveTokens(tokens)
        XCTAssertEqual(try store.loadTokens(), tokens)
        try store.deleteTokens()
        XCTAssertNil(try store.loadTokens())
        XCTAssertEqual(keychain.calls, 1, "after the first missing-entitlement error the Keychain is not retried")
    }

    func testOtherKeychainErrorsAreNotMasked() {
        let store = SimulatorTokenStore(primary: OtherFailureKeychain(), directory: temporaryDirectory())
        XCTAssertThrowsError(try store.saveTokens(tokens)) { error in
            XCTAssertEqual((error as? KeychainError)?.status, errSecInteractionNotAllowed)
        }
        XCTAssertFalse(store.isUsingFallback)
    }

    func testUsesTheKeychainWhenItWorks() throws {
        let keychain = InMemoryTokenStore()
        let store = SimulatorTokenStore(primary: keychain, directory: temporaryDirectory())
        try store.saveTokens(tokens)
        XCTAssertEqual(try keychain.loadTokens(), tokens)
        XCTAssertFalse(store.isUsingFallback)
    }
}
#endif
