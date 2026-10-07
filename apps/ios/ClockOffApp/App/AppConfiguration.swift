import Foundation
import ClockOffCore

/// Build-time configuration read from Info.plist (values come from Config/*.xcconfig).
struct AppConfiguration: Equatable {
    /// Root of the mobile API (`API_BASE_URL`), e.g. `https://app.clockoff.online/api/mobile/v1`. Endpoint
    /// paths such as `/sync` are appended to it; the client adds no prefix of its own.
    let apiBaseURL: URL
    /// APNs environment reported with the push token (`ClockOffPushEnvironment`).
    let pushEnvironment: PushEnvironment
    /// Marketing version, e.g. `1.0.0`.
    let appVersion: String
    /// Build number, e.g. `1`.
    let buildNumber: String

    static func load(from bundle: Bundle = .main) -> AppConfiguration {
        let info = bundle.infoDictionary ?? [:]
        guard let raw = info["API_BASE_URL"] as? String, let url = apiBaseURL(from: raw) else {
            // A build configuration error, never a runtime condition: fail loudly in every configuration.
            fatalError("Info.plist API_BASE_URL is missing or invalid: it must be the mobile API root, e.g. http://localhost:3000\(MobileAPIPath.mountPath) — check Config/Debug.xcconfig / Release.xcconfig / Local.xcconfig")
        }
        let push = (info["ClockOffPushEnvironment"] as? String).flatMap(PushEnvironment.init(rawValue:)) ?? .production
        return AppConfiguration(
            apiBaseURL: url,
            pushEnvironment: push,
            appVersion: info["CFBundleShortVersionString"] as? String ?? "0.0.0",
            buildNumber: info["CFBundleVersion"] as? String ?? "0"
        )
    }

    /// Parses `API_BASE_URL`: an http(s) URL with a host whose path ends with `/api/mobile/v1` (the mobile API
    /// root; one trailing slash or more is tolerated). Every request would 404 otherwise, so these are
    /// refused: a bare server origin such as `http://localhost:3000` (the old meaning of the setting), a
    /// partial or over-long path (`…/api/mobile`, `…/api/mobile/v1/sync`), an empty segment (`//`) and a
    /// repeated `/api/mobile/v1`.
    static func apiBaseURL(from raw: String) -> URL? {
        guard let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = url.host, !host.isEmpty,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return nil
        }
        let mount = MobileAPIPath.mountPath
        var path = components.percentEncodedPath
        while path.hasSuffix("/") { path.removeLast() }
        guard path.hasSuffix(mount), !path.contains("//"),
              !(String(path.dropLast(mount.count)) + "/").contains(mount + "/") else {
            return nil
        }
        return url
    }

    /// The web app on the same server: `apiBaseURL` without its trailing `/api/mobile/v1` (just the origin
    /// when the API is mounted somewhere else). Pages such as `/help` live here, not under the API.
    var webBaseURL: URL {
        guard var components = URLComponents(url: apiBaseURL, resolvingAgainstBaseURL: true) else { return apiBaseURL }
        var path = components.percentEncodedPath
        while path.hasSuffix("/") { path.removeLast() }
        if path.hasSuffix(MobileAPIPath.mountPath) {
            path.removeLast(MobileAPIPath.mountPath.count)
        } else {
            path = ""
        }
        components.percentEncodedPath = path
        components.query = nil
        components.fragment = nil
        return components.url ?? apiBaseURL
    }

    /// The help page (Settings › Help), e.g. `https://app.clockoff.online/help`.
    var helpURL: URL { webBaseURL.appendingPathComponent("help") }

    /// "1.0.0 (1)" for display.
    var displayVersion: String { "\(appVersion) (\(buildNumber))" }
}
