import Foundation

/// Intercepts every request of a session configured with it and answers from `handler`.
/// Records each request (with its body, which URLProtocol only exposes as a stream).
final class StubURLProtocol: URLProtocol {
    struct Recorded {
        let method: String
        let path: String
        let query: [String: String]
        let headers: [String: String]
        let body: Data?
    }

    enum Reply {
        case response(status: Int, json: String, headers: [String: String] = [:])
        case failure(URLError.Code)
    }

    private static let lock = NSLock()
    private static var _handler: ((Recorded) -> Reply)?
    private static var _recorded: [Recorded] = []

    static func install(_ handler: @escaping (Recorded) -> Reply) {
        lock.lock()
        defer { lock.unlock() }
        _handler = handler
        _recorded = []
    }

    static func reset() {
        lock.lock()
        defer { lock.unlock() }
        _handler = nil
        _recorded = []
    }

    static var recorded: [Recorded] {
        lock.lock()
        defer { lock.unlock() }
        return _recorded
    }

    static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url ?? URL(string: "about:blank")!
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        var query: [String: String] = [:]
        for item in components?.queryItems ?? [] { query[item.name] = item.value }
        let recorded = Recorded(
            method: request.httpMethod ?? "GET",
            path: url.path,
            query: query,
            headers: request.allHTTPHeaderFields ?? [:],
            body: request.httpBody ?? Self.readStream(request.httpBodyStream)
        )
        Self.lock.lock()
        Self._recorded.append(recorded)
        let handler = Self._handler
        Self.lock.unlock()

        switch handler?(recorded) ?? .failure(.badServerResponse) {
        case .response(let status, let json, let headers):
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(json.utf8))
            client?.urlProtocolDidFinishLoading(self)
        case .failure(let code):
            client?.urlProtocol(self, didFailWithError: URLError(code))
        }
    }

    override func stopLoading() {}

    private static func readStream(_ stream: InputStream?) -> Data? {
        guard let stream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}
