import XCTest
@testable import WorkModeCore

/// A token store whose persistence can be made to fail, like a Keychain that is locked or broken.
private final class FlakyTokenStore: TokenStore, @unchecked Sendable {
    struct Failure: Error {}

    private let lock = NSLock()
    private var tokens: TokenPair?
    private var _failLoads = false
    private var _failSaves = false
    private var _saveAttempts = 0

    init(tokens: TokenPair? = nil) {
        self.tokens = tokens
    }

    var failLoads: Bool {
        get { locked { _failLoads } }
        set { locked { _failLoads = newValue } }
    }

    var failSaves: Bool {
        get { locked { _failSaves } }
        set { locked { _failSaves = newValue } }
    }

    var saveAttempts: Int { locked { _saveAttempts } }
    var persisted: TokenPair? { locked { tokens } }

    func loadTokens() throws -> TokenPair? {
        try locked {
            if _failLoads { throw Failure() }
            return tokens
        }
    }

    func saveTokens(_ tokens: TokenPair) throws {
        try locked {
            _saveAttempts += 1
            if _failSaves { throw Failure() }
            self.tokens = tokens
        }
    }

    func deleteTokens() throws {
        locked { tokens = nil }
    }

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }
}

/// Counts refresh calls and holds each one open until `release()`.
private actor GatedRefresh {
    private(set) var calls = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var isOpen = false
    private let result: TokenPair

    init(result: TokenPair) {
        self.result = result
    }

    func perform() async -> TokenPair {
        calls += 1
        if !isOpen {
            await withCheckedContinuation { waiters.append($0) }
        }
        return result
    }

    func release() {
        isOpen = true
        waiters.forEach { $0.resume() }
        waiters = []
    }
}

private func pair(_ suffix: String) -> TokenPair {
    TokenPair(
        accessToken: "access-\(suffix)",
        refreshToken: "refresh-\(suffix)-0123456789abcdef",
        accessTokenExpiresAt: Date(timeIntervalSince1970: 1_800_000_000),
        refreshTokenExpiresAt: Date(timeIntervalSince1970: 1_900_000_000)
    )
}

final class TokenRefresherTests: XCTestCase {
    func testConcurrentRefreshesShareOneInFlightCall() async throws {
        let store = InMemoryTokenStore(tokens: pair("old"))
        let gate = GatedRefresh(result: pair("new"))
        let refresher = TokenRefresher(tokenStore: store) { refreshToken in
            XCTAssertEqual(refreshToken, pair("old").refreshToken)
            return await gate.perform()
        }

        let results = try await withThrowingTaskGroup(of: String.self) { group -> [String] in
            for _ in 0..<8 {
                group.addTask { try await refresher.refreshedAccessToken(rejected: "access-old") }
            }
            // Let every caller reach the refresher while the first refresh is still held open.
            while await gate.calls == 0 { await Task.yield() }
            try await Task.sleep(nanoseconds: 50_000_000)
            await gate.release()
            var tokens: [String] = []
            for try await token in group { tokens.append(token) }
            return tokens
        }

        XCTAssertEqual(results, Array(repeating: "access-new", count: 8))
        let calls = await gate.calls
        XCTAssertEqual(calls, 1, "a single refresh is in flight however many requests hit a 401")
        XCTAssertEqual(try store.loadTokens(), pair("new"))
    }

    func testStaleRejectionReturnsTheAlreadyRefreshedTokenWithoutCallingTheServer() async throws {
        let store = InMemoryTokenStore(tokens: pair("new"))
        let gate = GatedRefresh(result: pair("newer"))
        await gate.release()
        let refresher = TokenRefresher(tokenStore: store) { _ in await gate.perform() }

        // A request sent with the old token comes back 401 after another request already refreshed.
        let token = try await refresher.refreshedAccessToken(rejected: "access-old")
        XCTAssertEqual(token, "access-new")
        let calls = await gate.calls
        XCTAssertEqual(calls, 0)

        // Once the new token is rejected too, the next refresh really happens (no stale in-flight task).
        let next = try await refresher.refreshedAccessToken(rejected: "access-new")
        XCTAssertEqual(next, "access-newer")
        let callsAfter = await gate.calls
        XCTAssertEqual(callsAfter, 1)
    }

    func testAuthenticationFailureDeletesTokens() async throws {
        let store = InMemoryTokenStore(tokens: pair("old"))
        let refresher = TokenRefresher(tokenStore: store) { _ in
            throw APIError(code: .tokenReused, message: "reused", status: 401)
        }
        do {
            _ = try await refresher.refreshedTokens(rejected: nil)
            XCTFail("expected TOKEN_REUSED")
        } catch let error as APIError {
            XCTAssertEqual(error.code, .tokenReused)
        }
        XCTAssertNil(try store.loadTokens())
    }

    func testTransientRefreshFailureKeepsTokens() async throws {
        let store = InMemoryTokenStore(tokens: pair("old"))
        let refresher = TokenRefresher(tokenStore: store) { _ in
            throw APIError(code: .internalError, message: "boom", status: 503)
        }
        _ = try? await refresher.refreshedTokens(rejected: nil)
        XCTAssertEqual(try store.loadTokens(), pair("old"))
    }

    func testUnreadableStoreIsCredentialsUnavailableNotSignedOut() async throws {
        let store = FlakyTokenStore(tokens: pair("old"))
        store.failLoads = true
        let refresher = TokenRefresher(tokenStore: store) { _ in pair("new") }
        do {
            _ = try await refresher.accessToken()
            XCTFail("expected CREDENTIALS_UNAVAILABLE")
        } catch let error as APIError {
            XCTAssertEqual(error.code, .credentialsUnavailable)
            XCTAssertFalse(error.isAuthenticationFailure, "an unreadable Keychain must not end the session")
        }
        store.failLoads = false
        XCTAssertEqual(store.persisted, pair("old"), "nothing was deleted")
    }

    func testMissingTokensAreNotSignedIn() async throws {
        let refresher = TokenRefresher(tokenStore: InMemoryTokenStore()) { _ in pair("new") }
        do {
            _ = try await refresher.accessToken()
            XCTFail("expected NOT_SIGNED_IN")
        } catch let error as APIError {
            XCTAssertEqual(error.code, .notSignedIn)
            XCTAssertTrue(error.isAuthenticationFailure)
        }
    }

    func testRotatedPairIsNotLostWhenTheKeychainRefusesIt() async throws {
        let keychain = FlakyTokenStore(tokens: pair("old"))
        let store = ResilientTokenStore(base: keychain)
        let presented = LockedStrings()
        let refresher = TokenRefresher(tokenStore: store) { refreshToken in
            presented.append(refreshToken)
            return presented.count == 1 ? pair("new") : pair("newer")
        }

        keychain.failSaves = true
        let first = try await refresher.refreshedAccessToken(rejected: "access-old")
        XCTAssertEqual(first, "access-new")
        XCTAssertTrue(store.hasUnpersistedTokens)
        XCTAssertEqual(keychain.persisted, pair("old"), "the Keychain still holds the rotated-out pair")

        // The next refresh must present the NEW refresh token (the old one would be reported as reuse).
        let second = try await refresher.refreshedAccessToken(rejected: "access-new")
        XCTAssertEqual(second, "access-newer")
        XCTAssertEqual(presented.values, [pair("old").refreshToken, pair("new").refreshToken])
    }
}

final class ResilientTokenStoreTests: XCTestCase {
    func testSaveFailureKeepsThePairInMemoryAndRetriesOnLoad() throws {
        let keychain = FlakyTokenStore()
        let store = ResilientTokenStore(base: keychain)
        keychain.failSaves = true
        XCTAssertNoThrow(try store.saveTokens(pair("a")))
        XCTAssertTrue(store.hasUnpersistedTokens)
        XCTAssertEqual(try store.loadTokens(), pair("a"))
        XCTAssertNil(keychain.persisted)

        keychain.failSaves = false
        XCTAssertEqual(try store.loadTokens(), pair("a"), "served from memory while the save is retried")
        XCTAssertEqual(keychain.persisted, pair("a"), "the retry persisted it")
        XCTAssertFalse(store.hasUnpersistedTokens)
    }

    func testDeleteClearsMemoryAndBase() throws {
        let keychain = FlakyTokenStore(tokens: pair("a"))
        let store = ResilientTokenStore(base: keychain)
        keychain.failSaves = true
        try store.saveTokens(pair("b"))
        try store.deleteTokens()
        XCTAssertFalse(store.hasUnpersistedTokens)
        XCTAssertNil(try store.loadTokens())
        XCTAssertNil(keychain.persisted)
    }

    func testPassesThroughWhenTheBaseWorks() throws {
        let keychain = FlakyTokenStore()
        let store = ResilientTokenStore(base: keychain)
        try store.saveTokens(pair("a"))
        XCTAssertEqual(keychain.persisted, pair("a"))
        XCTAssertFalse(store.hasUnpersistedTokens)
        keychain.failLoads = true
        XCTAssertThrowsError(try store.loadTokens(), "a read failure is surfaced, not hidden as 'no tokens'")
    }
}

final class CredentialsUnavailableAPIClientTests: XCTestCase {
    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    func testUnreadableKeychainIsNotTreatedAsSignedOut() async throws {
        let store = FlakyTokenStore(tokens: pair("old"))
        store.failLoads = true
        let client = APIClient(
            configuration: APIClientConfiguration(baseURL: URL(string: "https://api.example.test")!),
            tokenStore: store,
            session: StubURLProtocol.makeSession()
        )
        let lost = LockedStrings()
        client.onAuthenticationLost = { lost.append("lost") }
        StubURLProtocol.install { _ in .response(status: 200, json: Fixture.syncJSON) }

        XCTAssertTrue(client.hasCredentials(), "unreadable is not absent: a joined phone stays joined")
        do {
            _ = try await client.sync()
            XCTFail("expected CREDENTIALS_UNAVAILABLE")
        } catch let error as APIError {
            XCTAssertEqual(error.code, .credentialsUnavailable)
            XCTAssertFalse(error.isAuthenticationFailure)
        }
        XCTAssertTrue(StubURLProtocol.recorded.isEmpty, "no request without a token")
        XCTAssertTrue(lost.values.isEmpty)
        store.failLoads = false
        XCTAssertEqual(store.persisted, pair("old"))
    }

    func testPermanentRejectionClassification() {
        XCTAssertTrue(APIError(code: .validationError, message: "", status: 400).isPermanentRejection)
        XCTAssertTrue(APIError(code: .payloadTooLarge, message: "", status: 413).isPermanentRejection)
        XCTAssertTrue(APIError.isPermanentRejection(APIError(code: .unknownEventType, message: "", status: 400)))
        XCTAssertFalse(APIError(code: .unauthenticated, message: "", status: 401).isPermanentRejection)
        XCTAssertFalse(APIError(code: .rateLimited, message: "", status: 429).isPermanentRejection)
        XCTAssertFalse(APIError(code: .internalError, message: "", status: 500).isPermanentRejection)
        XCTAssertFalse(APIError.network(URLError(.timedOut)).isPermanentRejection)
        XCTAssertFalse(APIError.isPermanentRejection(URLError(.badURL)))
    }
}

/// Thread-safe string log for `@Sendable` closures.
final class LockedStrings: @unchecked Sendable {
    private let lock = NSLock()
    private var _values: [String] = []

    var values: [String] {
        lock.lock()
        defer { lock.unlock() }
        return _values
    }

    var count: Int { values.count }

    func append(_ value: String) {
        lock.lock()
        defer { lock.unlock() }
        _values.append(value)
    }
}
