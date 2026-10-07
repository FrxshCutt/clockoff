import XCTest
import WorkModeCore
@testable import ClockOffApp

/// `API_BASE_URL` is the mobile API root; help pages live on the web app of the same server.
final class AppConfigurationTests: XCTestCase {
    private func configuration(_ apiBaseURL: String) throws -> AppConfiguration {
        AppConfiguration(apiBaseURL: try XCTUnwrap(URL(string: apiBaseURL)), pushEnvironment: .production, appVersion: "1.0.0", buildNumber: "1")
    }

    func testTheBuiltInfoPlistHoldsTheMobileAPIRoot() throws {
        // The hosted tests run the Debug app: Config/Debug.xcconfig (or a developer's Local.xcconfig).
        let raw = try XCTUnwrap(Bundle.main.object(forInfoDictionaryKey: "API_BASE_URL") as? String)
        let url = try XCTUnwrap(AppConfiguration.apiBaseURL(from: raw), "API_BASE_URL '\(raw)' is not a mobile API root")
        XCTAssertTrue(url.path.hasSuffix(MobileAPIPath.mountPath), url.absoluteString)
        XCTAssertEqual(AppConfiguration.load().apiBaseURL, url)
    }

    func testAcceptsMobileAPIRoots() {
        for raw in [
            "https://app.clockoff.online/api/mobile/v1",
            "https://app.clockoff.online/api/mobile/v1/",
            "http://localhost:3000/api/mobile/v1",
            " http://my-mac.local:3000/api/mobile/v1 \n",
            "http://192.168.1.20:3000/api/mobile/v1",
            // Behind a proxy that mounts the server under a sub-path.
            "https://example.test/clockoff/api/mobile/v1",
        ] {
            XCTAssertNotNil(AppConfiguration.apiBaseURL(from: raw), raw)
        }
        XCTAssertEqual(AppConfiguration.apiBaseURL(from: " http://localhost:3000/api/mobile/v1 ")?.absoluteString, "http://localhost:3000/api/mobile/v1")
    }

    func testRefusesABareOriginAndNonHTTPValues() {
        // A bare origin is the old meaning of API_BASE_URL: every request would miss /api/mobile/v1.
        for raw in ["https://app.clockoff.online", "https://app.clockoff.online/", "http://localhost:3000", "", "app.clockoff.online/api/mobile/v1",
                    "ftp://app.clockoff.online/api/mobile/v1", "https:///api/mobile/v1", "$(API_BASE_URL)"] {
            XCTAssertNil(AppConfiguration.apiBaseURL(from: raw), raw)
        }
    }

    func testRefusesPathsThatAreNotExactlyTheMobileAPIRoot() {
        // Each of these would send every request to a path the server does not serve (404).
        for raw in [
            "http://localhost:3000/api",                                  // partial
            "http://localhost:3000/api/mobile",                           // partial
            "https://app.clockoff.online/api/mobile/v10",                 // wrong version segment
            "https://app.clockoff.online/xapi/mobile/v1",                 // not a whole segment
            "https://app.clockoff.online/api/mobile/v1/sync",             // an endpoint, not the root
            "https://app.clockoff.online//api/mobile/v1",                 // empty segment
            "https://app.clockoff.online/api/mobile//v1",                 // empty segment
            "https://app.clockoff.online/api/mobile/v1/api/mobile/v1",    // doubled mount path
            "https://app.clockoff.online/api/mobile/v1/x/api/mobile/v1",  // repeated mount path
        ] {
            XCTAssertNil(AppConfiguration.apiBaseURL(from: raw), raw)
        }
    }

    func testHelpIsOnTheWebAppNotUnderTheAPI() throws {
        XCTAssertEqual(try configuration("https://app.clockoff.online/api/mobile/v1").helpURL.absoluteString, "https://app.clockoff.online/help")
        XCTAssertEqual(try configuration("https://app.clockoff.online/api/mobile/v1/").helpURL.absoluteString, "https://app.clockoff.online/help")
        XCTAssertEqual(try configuration("http://localhost:3000/api/mobile/v1").helpURL.absoluteString, "http://localhost:3000/help")
        // Mounted under a sub-path: the web app is that sub-path.
        XCTAssertEqual(try configuration("https://example.test/clockoff/api/mobile/v1").helpURL.absoluteString, "https://example.test/clockoff/help")
        // Mounted somewhere else entirely: the server origin.
        XCTAssertEqual(try configuration("https://api.example.test/mobile").helpURL.absoluteString, "https://api.example.test/help")
    }
}
