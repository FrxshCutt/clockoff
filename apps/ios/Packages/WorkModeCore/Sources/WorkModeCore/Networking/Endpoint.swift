import Foundation

public enum HTTPMethod: String, Sendable {
    case get = "GET"
    case post = "POST"
}

/// Whether a failed request may be repeated automatically.
public enum RetryBehaviour: Sendable {
    /// Safe to repeat: reads, and writes the server de-duplicates (client ids, idempotent state reports).
    case idempotent
    /// Never repeated: the first attempt may have taken effect (token rotation, join confirmation, unlink).
    case never
}

/// A request to the mobile API, before authentication is attached.
public struct Endpoint: Sendable {
    public var method: HTTPMethod
    /// Path relative to the mobile API root (`API_BASE_URL`), e.g. `/sync`. Already percent-encoded.
    public var path: String
    public var query: [URLQueryItem]
    public var body: Data?
    public var requiresAuth: Bool
    public var retry: RetryBehaviour

    public init(method: HTTPMethod, path: String, query: [URLQueryItem] = [], body: Data? = nil, requiresAuth: Bool, retry: RetryBehaviour) {
        self.method = method
        self.path = path
        self.query = query
        self.body = body
        self.requiresAuth = requiresAuth
        self.retry = retry
    }

    static func get(_ path: String, query: [URLQueryItem] = []) -> Endpoint {
        Endpoint(method: .get, path: path, query: query, requiresAuth: true, retry: .idempotent)
    }

    static func post<Body: Encodable>(_ path: String, body: Body, requiresAuth: Bool = true, retry: RetryBehaviour) throws -> Endpoint {
        let data: Data
        do {
            data = try JSONEncoder.workMode.encode(body)
        } catch {
            throw APIError(code: .encodingError, message: "Could not encode the request.", status: 0)
        }
        return Endpoint(method: .post, path: path, body: data, requiresAuth: requiresAuth, retry: retry)
    }
}

extension Endpoint {
    /// This endpoint's request URL under `apiRoot`, the mobile API root (`API_BASE_URL`, e.g.
    /// `https://app.clockoff.online/api/mobile/v1`), with or without a trailing slash.
    ///
    /// Joined by hand, never with `URL(string:relativeTo:)`: resolving an absolute path such as `/sync`
    /// against the root REPLACES the root's path (→ `https://app.clockoff.online/sync`), and a relative one
    /// drops the root's last segment unless it ends in `/`. Exactly one `/` separates the root and `path`;
    /// the root's own query (if any), a query embedded in `path`, and `query` are all kept, in that order.
    /// `nil` when `apiRoot` is not an absolute URL with a host or `path` is not a valid URL path.
    public func url(apiRoot: URL) -> URL? {
        guard var components = URLComponents(url: apiRoot, resolvingAgainstBaseURL: true),
              components.scheme != nil, components.host?.isEmpty == false else { return nil }
        var rootPath = components.percentEncodedPath
        while rootPath.hasSuffix("/") { rootPath.removeLast() }
        var relative = Substring(path)
        while relative.hasPrefix("/") { relative.removeFirst() }
        // Parsed as an absolute-path reference: a `:` or `//` in `path` can never become a scheme or a host.
        guard let reference = URLComponents(string: "/" + relative) else { return nil }
        components.percentEncodedPath = rootPath + reference.percentEncodedPath

        var queries = [components.percentEncodedQuery, reference.percentEncodedQuery]
        if !query.isEmpty {
            var encoder = URLComponents()
            encoder.queryItems = query
            queries.append(encoder.percentEncodedQuery)
        }
        let joined = queries.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "&")
        components.percentEncodedQuery = joined.isEmpty ? nil : joined
        components.fragment = nil
        return components.url
    }
}

/// Exponential backoff with jitter for transient failures (5xx, network errors).
public struct BackoffPolicy: Equatable, Sendable {
    /// Retries after the first attempt (so at most `maxRetries + 1` attempts).
    public var maxRetries: Int
    public var initialDelay: TimeInterval
    public var maxDelay: TimeInterval

    public init(maxRetries: Int = 3, initialDelay: TimeInterval = 0.5, maxDelay: TimeInterval = 8) {
        self.maxRetries = max(0, maxRetries)
        self.initialDelay = max(0, initialDelay)
        self.maxDelay = max(initialDelay, maxDelay)
    }

    /// Delay before retry number `retry` (1-based): `min(maxDelay, initialDelay · 2^(retry−1))` scaled by a
    /// jitter factor in [0.5, 1] ("equal jitter") so a fleet of phones does not retry in lock-step.
    public func delay(forRetry retry: Int, jitter: Double) -> TimeInterval {
        let exponent = Double(max(0, retry - 1))
        let capped = min(maxDelay, initialDelay * pow(2, exponent))
        let factor = 0.5 + 0.5 * min(1, max(0, jitter))
        return capped * factor
    }
}

/// Abstracts `Task.sleep` so tests do not wait for real backoff delays.
public protocol Sleeper: Sendable {
    func sleep(seconds: TimeInterval) async throws
}

public struct TaskSleeper: Sleeper {
    public init() {}

    public func sleep(seconds: TimeInterval) async throws {
        guard seconds > 0 else { return }
        try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }
}

/// Request logging. Receives method, path and outcome only — never headers (tokens), query values or bodies.
public protocol APIRequestLogging: Sendable {
    func logRequest(method: String, path: String, status: Int?, attempt: Int, duration: TimeInterval, errorCode: String?)
}

public struct OSLogAPIRequestLogger: APIRequestLogging {
    public init() {}

    public func logRequest(method: String, path: String, status: Int?, attempt: Int, duration: TimeInterval, errorCode: String?) {
        let millis = Int(duration * 1000)
        let statusText = status.map(String.init) ?? "-"
        WorkModeLog.network.info("\(method, privacy: .public) \(path, privacy: .public) → \(statusText, privacy: .public) in \(millis)ms (attempt \(attempt)) \(errorCode ?? "", privacy: .public)")
    }
}
