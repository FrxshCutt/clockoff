import XCTest
@testable import ClockOffCore

/// `Endpoint.url(apiRoot:)`: API_BASE_URL is the mobile API root and endpoint paths are appended to it.
final class EndpointURLTests: XCTestCase {
    private static let release = "https://app.clockoff.online/api/mobile/v1"
    private static let range = [
        URLQueryItem(name: "from", value: "2026-10-05T00:00:00.000Z"),
        URLQueryItem(name: "to", value: "2026-10-07T00:00:00.000Z"),
    ]

    private func join(_ root: String, _ path: String, query: [URLQueryItem] = [], file: StaticString = #filePath, line: UInt = #line) -> String? {
        guard let rootURL = URL(string: root) else {
            XCTFail("bad root literal \(root)", file: file, line: line)
            return nil
        }
        return Endpoint(method: .get, path: path, query: query, requiresAuth: true, retry: .idempotent).url(apiRoot: rootURL)?.absoluteString
    }

    func testExactlyOneSlashWithOrWithoutTrailingSlashOnTheRoot() {
        for root in [Self.release, Self.release + "/", Self.release + "//"] {
            for path in ["/sync", "sync", "//sync"] {
                XCTAssertEqual(join(root, path), "https://app.clockoff.online/api/mobile/v1/sync", "\(root) + \(path)")
            }
        }
    }

    func testRootPathIsNeverDroppedUnlikeURLRelativeTo() throws {
        let root = try XCTUnwrap(URL(string: Self.release))
        // The trap this joiner avoids: RFC 3986 resolution of an absolute path REPLACES the base path…
        XCTAssertEqual(URL(string: "/sync", relativeTo: root)?.absoluteString, "https://app.clockoff.online/sync")
        // …and a relative one replaces the base's last segment when the base has no trailing slash.
        XCTAssertEqual(URL(string: "sync", relativeTo: root)?.absoluteString, "https://app.clockoff.online/api/mobile/sync")
        XCTAssertEqual(join(Self.release, "/sync"), "https://app.clockoff.online/api/mobile/v1/sync")
        XCTAssertEqual(join(Self.release, "/breaks/start"), "https://app.clockoff.online/api/mobile/v1/breaks/start")
    }

    func testEveryEndpointPathLandsUnderTheMobileAPI() {
        let paths = [
            MobileAPIPath.joinLookup, MobileAPIPath.joinConfirm, MobileAPIPath.refresh, MobileAPIPath.logout,
            MobileAPIPath.leaveWorkplace, MobileAPIPath.me, MobileAPIPath.schedule, MobileAPIPath.sync,
            MobileAPIPath.deviceState, MobileAPIPath.events, MobileAPIPath.startBreak, MobileAPIPath.pushToken,
            MobileAPIPath.endBreak("b1"),
        ]
        for path in paths {
            XCTAssertEqual(join(Self.release + "/", path), "https://app.clockoff.online/api/mobile/v1" + path)
        }
    }

    func testDebugRootKeepsHTTPAndPort() {
        XCTAssertEqual(join("http://localhost:3000/api/mobile/v1", MobileAPIPath.pushToken), "http://localhost:3000/api/mobile/v1/device/push-token")
        XCTAssertEqual(join("http://my-mac.local:3000/api/mobile/v1/", MobileAPIPath.me), "http://my-mac.local:3000/api/mobile/v1/me")
    }

    func testQueryIsPreserved() {
        let expected = "https://app.clockoff.online/api/mobile/v1/schedule?from=2026-10-05T00:00:00.000Z&to=2026-10-07T00:00:00.000Z"
        XCTAssertEqual(join(Self.release, "/schedule", query: Self.range), expected)
        XCTAssertEqual(join(Self.release + "/", "/schedule", query: Self.range), expected)
    }

    func testRootQueryAndAQueryInThePathAreKeptAndAFragmentDropped() {
        XCTAssertEqual(
            join("https://api.example.test/api/mobile/v1/?k=1#top", "/schedule?x=2", query: Self.range),
            "https://api.example.test/api/mobile/v1/schedule?k=1&x=2&from=2026-10-05T00:00:00.000Z&to=2026-10-07T00:00:00.000Z"
        )
    }

    func testEscapedSegmentsAndColonsStayInThePath() {
        XCTAssertEqual(join(Self.release, MobileAPIPath.endBreak("a/b c")), "https://app.clockoff.online/api/mobile/v1/breaks/a%2Fb%20c/end")
        // A ':' in the first segment is not read as a scheme, and '//' is not read as a host.
        XCTAssertEqual(join(Self.release, "/a:b"), "https://app.clockoff.online/api/mobile/v1/a:b")
        XCTAssertEqual(join(Self.release, "//evil.example/x"), "https://app.clockoff.online/api/mobile/v1/evil.example/x")
    }

    func testABareOriginGetsNoImplicitPrefix() {
        // API_BASE_URL is the API root: nothing is prepended (AppConfiguration refuses a bare origin).
        XCTAssertEqual(join("https://app.clockoff.online", "/sync"), "https://app.clockoff.online/sync")
    }

    func testRootsWithoutSchemeOrHostAreRefused() {
        XCTAssertNil(join("api/mobile/v1", "/sync"))
        XCTAssertNil(Endpoint(method: .get, path: "/sync", requiresAuth: true, retry: .idempotent).url(apiRoot: URL(fileURLWithPath: "/api/mobile/v1")))
    }
}
