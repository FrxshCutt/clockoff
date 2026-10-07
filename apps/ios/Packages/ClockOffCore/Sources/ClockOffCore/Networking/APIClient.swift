import Foundation

public struct APIClientConfiguration: Sendable {
    /// Root of the mobile API (Info.plist `API_BASE_URL`), e.g. `https://app.clockoff.online/api/mobile/v1`
    /// or `http://localhost:3000/api/mobile/v1`. Endpoint paths are appended to it (`Endpoint.url(apiRoot:)`).
    public var baseURL: URL
    public var backoff: BackoffPolicy
    public var timeout: TimeInterval

    public init(baseURL: URL, backoff: BackoffPolicy = BackoffPolicy(), timeout: TimeInterval = 30) {
        self.baseURL = baseURL
        self.backoff = backoff
        self.timeout = timeout
    }
}

/// URLSession client for the mobile API.
///
/// - Bearer access token from the `TokenStore`; on a 401 it refreshes once through `TokenRefresher`
///   (single in-flight refresh) and replays the request. If the refresh itself is refused the tokens are
///   deleted, `onAuthenticationLost` fires and the error is thrown.
/// - 5xx responses and network errors on idempotent endpoints are retried up to `backoff.maxRetries` times
///   with exponential backoff and jitter. 429 is not retried (it surfaces `RATE_LIMITED` with `retryAfter`).
/// - Every non-2xx response becomes an `APIError` decoded from the `{ error: { code, message } }` envelope.
/// - Logging records method, path, status and timing only — never tokens, query values or bodies.
public final class APIClient: MobileAPI {
    private let configuration: APIClientConfiguration
    private let session: URLSession
    private let tokenStore: TokenStore
    private let sleeper: Sleeper
    private let jitter: @Sendable () -> Double
    private let logger: APIRequestLogging
    private let refresher: TokenRefresher
    private let lock = NSLock()
    private var authenticationLostHandler: (@Sendable () -> Void)?

    public init(
        configuration: APIClientConfiguration,
        tokenStore: TokenStore,
        session: URLSession = .shared,
        sleeper: Sleeper = TaskSleeper(),
        jitter: @escaping @Sendable () -> Double = { Double.random(in: 0...1) },
        logger: APIRequestLogging = OSLogAPIRequestLogger()
    ) {
        self.configuration = configuration
        self.session = session
        self.tokenStore = tokenStore
        self.sleeper = sleeper
        self.jitter = jitter
        self.logger = logger
        let bridge = RefreshBridge()
        refresher = TokenRefresher(tokenStore: tokenStore) { refreshToken in
            guard let client = bridge.client else { throw APIError.notSignedIn() }
            return try await client.performRefresh(refreshToken: refreshToken)
        }
        bridge.client = self
    }

    /// Called (on an arbitrary thread) when the server permanently rejects this device's session and the
    /// tokens have been deleted. The app routes back to onboarding.
    public var onAuthenticationLost: (@Sendable () -> Void)? {
        get {
            lock.lock()
            defer { lock.unlock() }
            return authenticationLostHandler
        }
        set {
            lock.lock()
            defer { lock.unlock() }
            authenticationLostHandler = newValue
        }
    }

    // MARK: MobileAPI

    public func hasCredentials() -> Bool {
        do {
            return try tokenStore.loadTokens() != nil
        } catch {
            // Unreadable is not absent (e.g. the Keychain before first unlock): a joined phone must not be
            // routed back to onboarding by a transient read failure. Requests then fail with
            // CREDENTIALS_UNAVAILABLE, which is not an authentication failure.
            return true
        }
    }

    public func joinLookup(_ request: JoinLookupRequest) async throws -> JoinLookupResponse {
        try await send(try .post(MobileAPIPath.joinLookup, body: request, requiresAuth: false, retry: .idempotent))
    }

    public func joinConfirm(_ request: JoinConfirmRequest) async throws -> JoinConfirmResponse {
        let response: JoinConfirmResponse = try await send(try .post(MobileAPIPath.joinConfirm, body: request, requiresAuth: false, retry: .never))
        do {
            try tokenStore.saveTokens(response.tokens)
        } catch {
            throw APIError(code: .notSignedIn, message: "Your sign-in could not be saved to the Keychain.", status: 0)
        }
        return response
    }

    public func refresh() async throws -> TokenPair {
        do {
            return try await refresher.refreshedTokens(rejected: nil)
        } catch let error as APIError where error.isAuthenticationFailure {
            notifyAuthenticationLost()
            throw error
        }
    }

    public func logout() async throws {
        let refreshToken = (try? tokenStore.loadTokens())?.refreshToken
        defer { try? tokenStore.deleteTokens() }
        _ = try await perform(try .post(MobileAPIPath.logout, body: LogoutRequest(refreshToken: refreshToken), retry: .never))
    }

    public func leaveWorkplace() async throws {
        _ = try await perform(try .post(MobileAPIPath.leaveWorkplace, body: EmptyRequest(), retry: .never))
        try? tokenStore.deleteTokens()
    }

    public func me() async throws -> MeResponse {
        try await send(.get(MobileAPIPath.me))
    }

    public func schedule(from: Date, to: Date) async throws -> ScheduleResponse {
        try await send(.get(MobileAPIPath.schedule, query: [
            URLQueryItem(name: "from", value: ClockOffDateCoding.format(from)),
            URLQueryItem(name: "to", value: ClockOffDateCoding.format(to)),
        ]))
    }

    public func sync() async throws -> SyncBundle {
        try await send(.get(MobileAPIPath.sync))
    }

    public func reportDeviceState(_ report: DeviceStateReport) async throws -> DeviceStateResponse {
        // Idempotent: a repeated check-in overwrites the same device row.
        try await send(try .post(MobileAPIPath.deviceState, body: report, retry: .idempotent))
    }

    public func postEvents(_ events: [DeviceEvent]) async throws -> DeviceEventsResponse {
        // Idempotent: the server de-duplicates on clientEventId.
        try await send(try .post(MobileAPIPath.events, body: DeviceEventsRequest(events: events), retry: .idempotent))
    }

    public func startBreak(_ request: StartBreakRequest) async throws -> BreakResponse {
        // Idempotent on clientBreakId.
        try await send(try .post(MobileAPIPath.startBreak, body: request, retry: .idempotent))
    }

    public func endBreak(breakSessionId: String, _ request: EndBreakRequest) async throws -> BreakResponse {
        // Idempotent: ending an ended break returns it unchanged.
        try await send(try .post(MobileAPIPath.endBreak(breakSessionId), body: request, retry: .idempotent))
    }

    public func registerPushToken(_ request: PushTokenRequest) async throws {
        _ = try await perform(try .post(MobileAPIPath.pushToken, body: request, retry: .idempotent))
    }

    // MARK: Transport

    /// `POST /auth/refresh`, used only by `TokenRefresher`. Never retried: the first attempt may have rotated
    /// the token server-side, and replaying the old one would be reported as reuse.
    func performRefresh(refreshToken: String) async throws -> TokenPair {
        try await send(try .post(MobileAPIPath.refresh, body: RefreshTokenRequest(refreshToken: refreshToken), requiresAuth: false, retry: .never))
    }

    private func send<Response: Decodable>(_ endpoint: Endpoint) async throws -> Response {
        let data = try await perform(endpoint)
        do {
            return try JSONDecoder.clockOff.decode(Response.self, from: data)
        } catch {
            ClockOffLog.network.error("decode failed for \(endpoint.path, privacy: .public): \(String(describing: error), privacy: .public)")
            throw APIError(code: .decodingError, message: "The server sent a response this version of ClockOff does not understand.", status: 200)
        }
    }

    /// Runs `endpoint` with auth, one refresh-and-replay on 401, and backoff retries. Returns the 2xx body.
    private func perform(_ endpoint: Endpoint) async throws -> Data {
        guard let url = endpoint.url(apiRoot: configuration.baseURL) else {
            throw APIError(code: .invalidResponse, message: "The server address is not valid.", status: 0)
        }
        // The server path only: query values are never logged.
        let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? endpoint.path
        var retries = 0
        var refreshed = false
        while true {
            let attempt = retries + 1
            let accessToken: String? = endpoint.requiresAuth ? try await refresher.accessToken() : nil
            let request = makeRequest(endpoint, url: url, accessToken: accessToken)
            let started = Date()
            do {
                let (data, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse else {
                    log(endpoint, path: path, status: nil, attempt: attempt, started: started, errorCode: APIErrorCode.invalidResponse.rawValue)
                    throw APIError(code: .invalidResponse, message: "The server sent an invalid response.", status: 0)
                }
                let status = http.statusCode
                if (200..<300).contains(status) {
                    log(endpoint, path: path, status: status, attempt: attempt, started: started, errorCode: nil)
                    return data
                }
                let error = apiError(from: data, response: http)
                log(endpoint, path: path, status: status, attempt: attempt, started: started, errorCode: error.code.rawValue)

                if status == 401, endpoint.requiresAuth, !refreshed {
                    refreshed = true
                    do {
                        _ = try await refresher.refreshedAccessToken(rejected: accessToken)
                    } catch let refreshError as APIError where refreshError.isAuthenticationFailure {
                        notifyAuthenticationLost()
                        throw refreshError
                    }
                    continue
                }
                if (500...599).contains(status), case .idempotent = endpoint.retry, retries < configuration.backoff.maxRetries {
                    retries += 1
                    try await sleeper.sleep(seconds: configuration.backoff.delay(forRetry: retries, jitter: jitter()))
                    continue
                }
                throw error
            } catch let error as APIError {
                throw error
            } catch let error as URLError {
                if error.code == .cancelled {
                    throw APIError(code: .cancelled, message: "The request was cancelled.", status: 0)
                }
                log(endpoint, path: path, status: nil, attempt: attempt, started: started, errorCode: "URL_ERROR_\(error.code.rawValue)")
                if case .idempotent = endpoint.retry, retries < configuration.backoff.maxRetries {
                    retries += 1
                    try await sleepOrCancel(configuration.backoff.delay(forRetry: retries, jitter: jitter()))
                    continue
                }
                throw APIError.network(error)
            } catch is CancellationError {
                throw APIError(code: .cancelled, message: "The request was cancelled.", status: 0)
            } catch {
                throw APIError.network(error)
            }
        }
    }

    private func sleepOrCancel(_ seconds: TimeInterval) async throws {
        do {
            try await sleeper.sleep(seconds: seconds)
        } catch {
            throw APIError(code: .cancelled, message: "The request was cancelled.", status: 0)
        }
    }

    private func makeRequest(_ endpoint: Endpoint, url: URL, accessToken: String?) -> URLRequest {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: configuration.timeout)
        request.httpMethod = endpoint.method.rawValue
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body = endpoint.body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let accessToken {
            request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    private func apiError(from data: Data, response: HTTPURLResponse) -> APIError {
        let status = response.statusCode
        // RATE_LIMITED carries `details.retryAfterSeconds`; a Retry-After header (proxies, 503) wins when present.
        let retryAfter = response.value(forHTTPHeaderField: "Retry-After").flatMap { TimeInterval($0.trimmingCharacters(in: .whitespaces)) }
            ?? (try? JSONDecoder.clockOff.decode(RetryAfterDetails.self, from: data))?.error.details?.retryAfterSeconds
        if let envelope = try? JSONDecoder.clockOff.decode(APIErrorEnvelope.self, from: data) {
            return APIError(code: APIErrorCode(rawValue: envelope.error.code), message: envelope.error.message, status: status, retryAfter: retryAfter)
        }
        // No envelope (proxy error page, load balancer): classify by status.
        let code: APIErrorCode
        switch status {
        case 401: code = .unauthenticated
        case 403: code = .forbidden
        case 404: code = .notFound
        case 409: code = .conflict
        case 429: code = .rateLimited
        case 500...599: code = .internalError
        default: code = .invalidResponse
        }
        return APIError(code: code, message: HTTPURLResponse.localizedString(forStatusCode: status).capitalized, status: status, retryAfter: retryAfter)
    }

    private func notifyAuthenticationLost() {
        onAuthenticationLost?()
    }

    private func log(_ endpoint: Endpoint, path: String, status: Int?, attempt: Int, started: Date, errorCode: String?) {
        logger.logRequest(
            method: endpoint.method.rawValue,
            path: path,
            status: status,
            attempt: attempt,
            duration: Date().timeIntervalSince(started),
            errorCode: errorCode
        )
    }
}

/// `{ error: { details: { retryAfterSeconds } } }` of a RATE_LIMITED response (every other key ignored).
private struct RetryAfterDetails: Decodable {
    struct Body: Decodable {
        struct Details: Decodable {
            let retryAfterSeconds: Double?
        }

        let details: Details?
    }

    let error: Body
}

/// Breaks the init-time cycle between `APIClient` and its `TokenRefresher`.
private final class RefreshBridge: @unchecked Sendable {
    weak var client: APIClient?
}
