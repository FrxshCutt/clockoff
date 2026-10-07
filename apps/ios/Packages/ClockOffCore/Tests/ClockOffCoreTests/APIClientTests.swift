import XCTest
@testable import ClockOffCore

private struct RecordingSleeper: Sleeper {
    final class Box: @unchecked Sendable {
        private let lock = NSLock()
        private var _delays: [TimeInterval] = []
        var delays: [TimeInterval] {
            lock.lock()
            defer { lock.unlock() }
            return _delays
        }
        func append(_ d: TimeInterval) {
            lock.lock()
            defer { lock.unlock() }
            _delays.append(d)
        }
    }

    let box = Box()

    func sleep(seconds: TimeInterval) async throws {
        box.append(seconds)
    }
}

private final class RecordingLogger: APIRequestLogging, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var lines: [String] = []

    func logRequest(method: String, path: String, status: Int?, attempt: Int, duration: TimeInterval, errorCode: String?) {
        lock.lock()
        defer { lock.unlock() }
        lines.append("\(method) \(path) \(status.map(String.init) ?? "-") #\(attempt) \(errorCode ?? "")")
    }
}

final class APIClientTests: XCTestCase {
    private var tokenStore: InMemoryTokenStore!
    private var sleeper: RecordingSleeper!
    private var logger: RecordingLogger!
    private var client: APIClient!

    private static let syncPath = "/api/mobile/v1/sync"
    private static let refreshPath = "/api/mobile/v1/auth/refresh"
    private static let newTokensJSON = """
    {"accessToken":"access-new","refreshToken":"refresh-new-0123456789abcdef","accessTokenExpiresAt":"2026-10-06T09:15:00.000Z","refreshTokenExpiresAt":"2027-01-04T09:00:00.000Z"}
    """

    override func setUp() {
        super.setUp()
        tokenStore = InMemoryTokenStore(tokens: Fixture.tokens)
        sleeper = RecordingSleeper()
        logger = RecordingLogger()
        client = APIClient(
            // The mobile API root (API_BASE_URL), with a trailing slash: every path below must still be
            // /api/mobile/v1/<endpoint> with exactly one slash.
            configuration: APIClientConfiguration(baseURL: URL(string: "https://api.example.test/api/mobile/v1/")!, backoff: BackoffPolicy(maxRetries: 3, initialDelay: 0.5, maxDelay: 8)),
            tokenStore: tokenStore,
            session: StubURLProtocol.makeSession(),
            sleeper: sleeper,
            jitter: { 1.0 },
            logger: logger
        )
    }

    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    private func errorJSON(_ code: String, _ message: String = "message") -> String {
        #"{"error":{"code":"\#(code)","message":"\#(message)"}}"#
    }

    // MARK: Success

    func testSuccessSendsBearerTokenAndDecodes() async throws {
        StubURLProtocol.install { _ in .response(status: 200, json: Fixture.syncJSON) }
        let bundle = try await client.sync()
        XCTAssertEqual(bundle.scheduleVersion, 7)
        let request = try XCTUnwrap(StubURLProtocol.recorded.first)
        XCTAssertEqual(request.method, "GET")
        XCTAssertEqual(request.path, Self.syncPath)
        XCTAssertEqual(request.headers["Authorization"], "Bearer access-old")
        XCTAssertEqual(request.headers["Accept"], "application/json")
        XCTAssertEqual(StubURLProtocol.recorded.count, 1)
    }

    func testPublicEndpointsSendNoAuthorizationAndPostJSON() async throws {
        StubURLProtocol.install { _ in
            .response(status: 200, json: #"{"organisation":{"name":"Org"},"match":"SINGLE","employeePreview":{"id":"e","firstName":"Sam","lastName":"Patel","jobTitle":null,"locationName":null}}"#)
        }
        let result = try await client.joinLookup(JoinLookupRequest(companyCode: "BREW-4821", firstName: "Sam", lastName: "Patel"))
        XCTAssertEqual(result.match, .single)
        let request = try XCTUnwrap(StubURLProtocol.recorded.first)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.path, "/api/mobile/v1/join/lookup")
        XCTAssertNil(request.headers["Authorization"])
        XCTAssertEqual(request.headers["Content-Type"], "application/json")
        let body = try jsonObject(try XCTUnwrap(request.body))
        XCTAssertEqual(body["companyCode"] as? String, "BREW-4821")
        XCTAssertNil(body["inviteCode"])
    }

    func testJoinConfirmStoresTokens() async throws {
        try tokenStore.deleteTokens()
        XCTAssertFalse(client.hasCredentials())
        StubURLProtocol.install { _ in
            .response(status: 201, json: """
            {"accessToken":"a1","refreshToken":"r1-0123456789abcdefghij","accessTokenExpiresAt":"2026-10-06T09:15:00Z","refreshTokenExpiresAt":"2027-01-04T09:00:00Z",
             "deviceId":"d","employee":{"id":"e","firstName":"Sam","lastName":"Patel","jobTitle":null,"primaryLocation":null},
             "organisation":{"id":"o","name":"Org","timezone":"Europe/London"}}
            """)
        }
        let response = try await client.joinConfirm(JoinConfirmRequest(
            companyCode: "BREW-4821", employeeId: "e", firstName: "Sam", lastName: "Patel",
            device: MobileDeviceInfo(appVersion: "1.0.0", osVersion: "26.5", model: "iPhone")
        ))
        XCTAssertEqual(response.deviceId, "d")
        XCTAssertEqual(try tokenStore.loadTokens()?.accessToken, "a1")
        XCTAssertTrue(client.hasCredentials())
    }

    func testScheduleSendsISORangeQuery() async throws {
        StubURLProtocol.install { _ in
            .response(status: 200, json: #"{"from":"2026-10-05T00:00:00.000Z","to":"2026-10-07T00:00:00.000Z","shifts":[],"scheduleVersion":1,"serverTime":"2026-10-06T00:00:00.000Z"}"#)
        }
        _ = try await client.schedule(from: iso("2026-10-05T00:00:00Z"), to: iso("2026-10-07T00:00:00Z"))
        let request = try XCTUnwrap(StubURLProtocol.recorded.first)
        XCTAssertEqual(request.path, "/api/mobile/v1/schedule")
        XCTAssertEqual(request.query, ["from": "2026-10-05T00:00:00.000Z", "to": "2026-10-07T00:00:00.000Z"])
        // The log line carries the full server path but never the query.
        XCTAssertEqual(logger.lines, ["GET /api/mobile/v1/schedule 200 #1 "])
    }

    // MARK: Request URLs (API_BASE_URL is the mobile API root)

    private static let scheduleJSON = #"{"from":"2026-10-05T00:00:00.000Z","to":"2026-10-07T00:00:00.000Z","shifts":[],"scheduleVersion":1,"serverTime":"2026-10-06T00:00:00.000Z"}"#

    /// Runs sync, schedule (with a query) and push-token through a client on `apiRoot`; returns the full URLs.
    private func requestURLs(apiRoot: String) async throws -> [String] {
        let client = APIClient(
            configuration: APIClientConfiguration(baseURL: try XCTUnwrap(URL(string: apiRoot))),
            tokenStore: InMemoryTokenStore(tokens: Fixture.tokens),
            session: StubURLProtocol.makeSession(),
            sleeper: sleeper,
            jitter: { 1.0 },
            logger: logger
        )
        StubURLProtocol.install { request in
            if request.path.hasSuffix("/schedule") { return .response(status: 200, json: Self.scheduleJSON) }
            if request.path.hasSuffix("/push-token") { return .response(status: 200, json: #"{"ok":true}"#) }
            return .response(status: 200, json: Fixture.syncJSON)
        }
        _ = try await client.sync()
        _ = try await client.schedule(from: iso("2026-10-05T00:00:00Z"), to: iso("2026-10-07T00:00:00Z"))
        try await client.registerPushToken(PushTokenRequest(token: String(repeating: "ab", count: 32), environment: .production))
        return StubURLProtocol.recorded.map(\.url.absoluteString)
    }

    func testReleaseBaseTargetsTheFullMobileAPIURL() async throws {
        let urls = try await requestURLs(apiRoot: "https://app.clockoff.online/api/mobile/v1")
        XCTAssertEqual(urls, [
            "https://app.clockoff.online/api/mobile/v1/sync",
            "https://app.clockoff.online/api/mobile/v1/schedule?from=2026-10-05T00:00:00.000Z&to=2026-10-07T00:00:00.000Z",
            "https://app.clockoff.online/api/mobile/v1/device/push-token",
        ])
    }

    func testTrailingSlashBaseTargetsTheSameURLs() async throws {
        let urls = try await requestURLs(apiRoot: "https://app.clockoff.online/api/mobile/v1/")
        XCTAssertEqual(urls, [
            "https://app.clockoff.online/api/mobile/v1/sync",
            "https://app.clockoff.online/api/mobile/v1/schedule?from=2026-10-05T00:00:00.000Z&to=2026-10-07T00:00:00.000Z",
            "https://app.clockoff.online/api/mobile/v1/device/push-token",
        ])
    }

    func testDebugSimulatorBaseTargetsLocalhost() async throws {
        let urls = try await requestURLs(apiRoot: "http://localhost:3000/api/mobile/v1")
        XCTAssertEqual(urls.first, "http://localhost:3000/api/mobile/v1/sync")
        XCTAssertEqual(urls.last, "http://localhost:3000/api/mobile/v1/device/push-token")
    }

    func testRefreshAndReplayStayUnderTheAPIRoot() async throws {
        StubURLProtocol.install { request in
            if request.path == Self.refreshPath { return .response(status: 200, json: Self.newTokensJSON) }
            if request.headers["Authorization"] == "Bearer access-new" { return .response(status: 200, json: Fixture.syncJSON) }
            return .response(status: 401, json: #"{"error":{"code":"UNAUTHENTICATED","message":"expired"}}"#)
        }
        _ = try await client.sync()
        XCTAssertEqual(StubURLProtocol.recorded.map(\.url.absoluteString), [
            "https://api.example.test/api/mobile/v1/sync",
            "https://api.example.test/api/mobile/v1/auth/refresh",
            "https://api.example.test/api/mobile/v1/sync",
        ])
    }

    // MARK: 401 → refresh

    func testUnauthorizedRefreshesOnceAndReplays() async throws {
        StubURLProtocol.install { request in
            if request.path == Self.refreshPath { return .response(status: 200, json: Self.newTokensJSON) }
            if request.headers["Authorization"] == "Bearer access-new" { return .response(status: 200, json: Fixture.syncJSON) }
            return .response(status: 401, json: #"{"error":{"code":"UNAUTHENTICATED","message":"Access token expired"}}"#)
        }
        let bundle = try await client.sync()
        XCTAssertEqual(bundle.scheduleVersion, 7)
        let paths = StubURLProtocol.recorded.map(\.path)
        XCTAssertEqual(paths, [Self.syncPath, Self.refreshPath, Self.syncPath])
        let refreshBody = try jsonObject(try XCTUnwrap(StubURLProtocol.recorded[1].body))
        XCTAssertEqual(refreshBody["refreshToken"] as? String, Fixture.tokens.refreshToken)
        XCTAssertNil(StubURLProtocol.recorded[1].headers["Authorization"])
        XCTAssertEqual(try tokenStore.loadTokens()?.accessToken, "access-new")
        XCTAssertEqual(try tokenStore.loadTokens()?.refreshToken, "refresh-new-0123456789abcdef")
    }

    func testConcurrentUnauthorizedRequestsShareOneRefresh() async throws {
        StubURLProtocol.install { request in
            if request.path == Self.refreshPath {
                Thread.sleep(forTimeInterval: 0.05)
                return .response(status: 200, json: Self.newTokensJSON)
            }
            if request.headers["Authorization"] == "Bearer access-new" { return .response(status: 200, json: Fixture.syncJSON) }
            return .response(status: 401, json: #"{"error":{"code":"UNAUTHENTICATED","message":"expired"}}"#)
        }
        let client = self.client!
        try await withThrowingTaskGroup(of: Int.self) { group in
            for _ in 0..<5 {
                group.addTask { try await client.sync().scheduleVersion }
            }
            for try await version in group {
                XCTAssertEqual(version, 7)
            }
        }
        XCTAssertEqual(StubURLProtocol.recorded.filter { $0.path == Self.refreshPath }.count, 1, "single in-flight refresh")
    }

    func testRefreshRejectedClearsTokensAndNotifies() async throws {
        let lost = expectation(description: "authentication lost")
        client.onAuthenticationLost = { lost.fulfill() }
        StubURLProtocol.install { request in
            if request.path == Self.refreshPath {
                return .response(status: 401, json: #"{"error":{"code":"TOKEN_REUSED","message":"Refresh token was already used"}}"#)
            }
            return .response(status: 401, json: #"{"error":{"code":"UNAUTHENTICATED","message":"expired"}}"#)
        }
        do {
            _ = try await client.sync()
            XCTFail("expected TOKEN_REUSED")
        } catch let error as APIError {
            XCTAssertEqual(error.code, .tokenReused)
            XCTAssertEqual(error.status, 401)
            XCTAssertTrue(error.isAuthenticationFailure)
        }
        await fulfillment(of: [lost], timeout: 1)
        XCTAssertNil(try tokenStore.loadTokens())
        XCTAssertFalse(client.hasCredentials())
        XCTAssertEqual(StubURLProtocol.recorded.filter { $0.path == Self.refreshPath }.count, 1, "refresh is never retried")
    }

    func testSecondUnauthorizedAfterRefreshIsNotLooped() async throws {
        StubURLProtocol.install { request in
            if request.path == Self.refreshPath { return .response(status: 200, json: Self.newTokensJSON) }
            return .response(status: 401, json: #"{"error":{"code":"UNAUTHENTICATED","message":"no"}}"#)
        }
        do {
            _ = try await client.sync()
            XCTFail("expected UNAUTHENTICATED")
        } catch let error as APIError {
            XCTAssertEqual(error.code, .unauthenticated)
        }
        XCTAssertEqual(StubURLProtocol.recorded.map(\.path), [Self.syncPath, Self.refreshPath, Self.syncPath])
    }

    func testAuthenticatedCallWithoutTokensFailsFast() async throws {
        try tokenStore.deleteTokens()
        StubURLProtocol.install { _ in .response(status: 200, json: Fixture.syncJSON) }
        do {
            _ = try await client.sync()
            XCTFail("expected NOT_SIGNED_IN")
        } catch let error as APIError {
            XCTAssertEqual(error.code, .notSignedIn)
        }
        XCTAssertTrue(StubURLProtocol.recorded.isEmpty)
    }

    // MARK: 429 / 5xx / network

    func testRateLimitedIsNotRetriedAndCarriesRetryAfter() async throws {
        StubURLProtocol.install { _ in
            .response(status: 429, json: #"{"error":{"code":"RATE_LIMITED","message":"Too many attempts"}}"#, headers: ["Retry-After": "42"])
        }
        do {
            _ = try await client.joinLookup(JoinLookupRequest(companyCode: "BREW-4821", firstName: "Sam", lastName: "Patel"))
            XCTFail("expected RATE_LIMITED")
        } catch let error as APIError {
            XCTAssertEqual(error.code, .rateLimited)
            XCTAssertEqual(error.status, 429)
            XCTAssertEqual(error.retryAfter, 42)
            XCTAssertEqual(error.message, "Too many attempts")
        }
        XCTAssertEqual(StubURLProtocol.recorded.count, 1)
        XCTAssertTrue(sleeper.box.delays.isEmpty)
    }

    func testRateLimitedReadsRetryAfterFromDetailsWithoutHeader() async throws {
        StubURLProtocol.install { _ in
            .response(status: 429, json: #"{"error":{"code":"RATE_LIMITED","message":"Slow down","details":{"retryAfterSeconds":120}}}"#)
        }
        do {
            _ = try await client.sync()
            XCTFail("expected RATE_LIMITED")
        } catch let error as APIError {
            XCTAssertEqual(error.code, .rateLimited)
            XCTAssertEqual(error.retryAfter, 120)
            XCTAssertFalse(error.isTransient, "429 is not retried automatically")
        }
        XCTAssertEqual(StubURLProtocol.recorded.count, 1)
    }

    func testServerErrorsAreRetriedWithExponentialBackoffThenSucceed() async throws {
        var calls = 0
        StubURLProtocol.install { _ in
            calls += 1
            return calls < 3 ? .response(status: 503, json: "<html>busy</html>") : .response(status: 200, json: Fixture.syncJSON)
        }
        let bundle = try await client.sync()
        XCTAssertEqual(bundle.scheduleVersion, 7)
        XCTAssertEqual(StubURLProtocol.recorded.count, 3)
        XCTAssertEqual(sleeper.box.delays, [0.5, 1.0], "initial · 2^(n−1) with jitter factor 1")
    }

    func testServerErrorsGiveUpAfterMaxRetries() async throws {
        StubURLProtocol.install { _ in .response(status: 500, json: #"{"error":{"code":"INTERNAL_ERROR","message":"boom"}}"#) }
        do {
            _ = try await client.sync()
            XCTFail("expected INTERNAL_ERROR")
        } catch let error as APIError {
            XCTAssertEqual(error.code, .internalError)
            XCTAssertEqual(error.status, 500)
            XCTAssertTrue(error.isTransient)
        }
        XCTAssertEqual(StubURLProtocol.recorded.count, 4, "1 attempt + 3 retries")
        XCTAssertEqual(sleeper.box.delays, [0.5, 1.0, 2.0])
    }

    func testNetworkErrorsAreRetriedThenSurfaceAsNetworkError() async throws {
        StubURLProtocol.install { _ in .failure(.notConnectedToInternet) }
        do {
            _ = try await client.sync()
            XCTFail("expected NETWORK_ERROR")
        } catch let error as APIError {
            XCTAssertEqual(error.code, .networkError)
            XCTAssertEqual(error.status, 0)
        }
        XCTAssertEqual(StubURLProtocol.recorded.count, 4)
    }

    func testNonIdempotentRequestsAreNeverRetried() async throws {
        try tokenStore.deleteTokens()
        StubURLProtocol.install { _ in .response(status: 502, json: "bad gateway") }
        do {
            _ = try await client.joinConfirm(JoinConfirmRequest(
                companyCode: "BREW-4821", employeeId: "e", firstName: "Sam", lastName: "Patel",
                device: MobileDeviceInfo(appVersion: "1.0.0", osVersion: "26.5", model: "iPhone")
            ))
            XCTFail("expected an error")
        } catch let error as APIError {
            XCTAssertEqual(error.code, .internalError, "no envelope: classified by status")
            XCTAssertEqual(error.status, 502)
        }
        XCTAssertEqual(StubURLProtocol.recorded.count, 1)
    }

    func testDomainErrorsDecodeFromEnvelope() async throws {
        StubURLProtocol.install { _ in .response(status: 404, json: #"{"error":{"code":"INVALID_COMPANY_CODE","message":"No workplace uses that code"}}"#) }
        do {
            _ = try await client.joinLookup(JoinLookupRequest(companyCode: "NOPE-0000", firstName: "Sam", lastName: "Patel"))
            XCTFail("expected INVALID_COMPANY_CODE")
        } catch let error as APIError {
            XCTAssertEqual(error, APIError(code: .invalidCompanyCode, message: "No workplace uses that code", status: 404))
        }
    }

    func testUnexpectedSuccessBodyIsADecodingError() async throws {
        StubURLProtocol.install { _ in .response(status: 200, json: #"{"unexpected":true}"#) }
        do {
            _ = try await client.sync()
            XCTFail("expected DECODING_ERROR")
        } catch let error as APIError {
            XCTAssertEqual(error.code, .decodingError)
        }
    }

    // MARK: Session endpoints

    func testLogoutDeletesTokensEvenWhenTheRequestFails() async throws {
        StubURLProtocol.install { _ in .failure(.notConnectedToInternet) }
        do {
            try await client.logout()
            XCTFail("expected a network error")
        } catch {}
        XCTAssertNil(try tokenStore.loadTokens())
        XCTAssertEqual(StubURLProtocol.recorded.count, 1, "logout is not retried")
    }

    func testLogoutSendsRefreshTokenAndAcceptsNoContent() async throws {
        StubURLProtocol.install { _ in .response(status: 204, json: "") }
        try await client.logout()
        let body = try jsonObject(try XCTUnwrap(StubURLProtocol.recorded.first?.body))
        XCTAssertEqual(body["refreshToken"] as? String, Fixture.tokens.refreshToken)
        XCTAssertNil(try tokenStore.loadTokens())
    }

    func testLeaveWorkplacePostsEmptyObjectAndDeletesTokens() async throws {
        StubURLProtocol.install { _ in .response(status: 200, json: #"{"ok":true}"#) }
        try await client.leaveWorkplace()
        let request = try XCTUnwrap(StubURLProtocol.recorded.first)
        XCTAssertEqual(request.path, "/api/mobile/v1/leave-workplace")
        XCTAssertEqual(request.body.map { String(decoding: $0, as: UTF8.self) }, "{}")
        XCTAssertNil(try tokenStore.loadTokens())
    }

    func testEndBreakAndPushTokenPaths() async throws {
        StubURLProtocol.install { request in
            if request.path.hasSuffix("/push-token") { return .response(status: 200, json: #"{"ok":true}"#) }
            return .response(status: 200, json: """
            {"breakSession":{"id":"b1","clientBreakId":"c","shiftId":"s","startedAt":"2026-10-06T11:00:00Z","plannedEndsAt":"2026-10-06T11:15:00Z",
              "endedAt":"2026-10-06T11:10:00Z","status":"ENDED","endReason":"EMPLOYEE_ENDED","restrictionBehaviour":"RELAX_ALL","relaxedCategories":[]},
             "allowance":{"breaksTaken":1,"breaksRemaining":1,"minutesUsed":10,"minutesRemaining":20,"nextEligibleAt":null,"canStartNow":false}}
            """)
        }
        let ended = try await client.endBreak(breakSessionId: "b1", EndBreakRequest(endedAt: iso("2026-10-06T11:10:00Z"), reason: .employeeEnded))
        XCTAssertEqual(ended.breakSession.endReason, .employeeEnded)
        try await client.registerPushToken(PushTokenRequest(token: String(repeating: "ab", count: 32), environment: .sandbox))
        XCTAssertEqual(StubURLProtocol.recorded.map(\.path), ["/api/mobile/v1/breaks/b1/end", "/api/mobile/v1/device/push-token"])
        let pushBody = try jsonObject(try XCTUnwrap(StubURLProtocol.recorded[1].body))
        XCTAssertEqual(pushBody["environment"] as? String, "sandbox")
    }

    // MARK: Logging

    func testLoggingNeverContainsTokensOrBodies() async throws {
        StubURLProtocol.install { request in
            if request.path == Self.refreshPath { return .response(status: 200, json: Self.newTokensJSON) }
            if request.headers["Authorization"] == "Bearer access-new" { return .response(status: 200, json: Fixture.syncJSON) }
            return .response(status: 401, json: #"{"error":{"code":"UNAUTHENTICATED","message":"expired"}}"#)
        }
        _ = try await client.sync()
        let joined = logger.lines.joined(separator: "\n")
        XCTAssertFalse(joined.contains("access-old"))
        XCTAssertFalse(joined.contains("access-new"))
        XCTAssertFalse(joined.contains("refresh-"))
        XCTAssertEqual(logger.lines.count, 3)
        XCTAssertTrue(logger.lines[0].hasPrefix("GET /api/mobile/v1/sync 401"))
    }

    func testBackoffPolicyCapsAndJitters() {
        let policy = BackoffPolicy(maxRetries: 3, initialDelay: 1, maxDelay: 5)
        XCTAssertEqual(policy.delay(forRetry: 1, jitter: 1), 1)
        XCTAssertEqual(policy.delay(forRetry: 3, jitter: 1), 4)
        XCTAssertEqual(policy.delay(forRetry: 6, jitter: 1), 5, "capped at maxDelay")
        XCTAssertEqual(policy.delay(forRetry: 3, jitter: 0), 2, "jitter never drops below half")
        XCTAssertEqual(policy.delay(forRetry: 3, jitter: 7), 4, "jitter is clamped")
    }
}
