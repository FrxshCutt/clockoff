import Foundation
import WorkModeCore

/// Build-time configuration read from Info.plist (values come from Config/*.xcconfig).
struct AppConfiguration: Equatable {
    /// Server origin for the mobile API (`API_BASE_URL`).
    let apiBaseURL: URL
    /// APNs environment reported with the push token (`WorkModePushEnvironment`).
    let pushEnvironment: PushEnvironment
    /// Marketing version, e.g. `1.0.0`.
    let appVersion: String
    /// Build number, e.g. `1`.
    let buildNumber: String

    static func load(from bundle: Bundle = .main) -> AppConfiguration {
        let info = bundle.infoDictionary ?? [:]
        guard let raw = info["API_BASE_URL"] as? String,
              let url = URL(string: raw.trimmingCharacters(in: .whitespaces)),
              let scheme = url.scheme, ["http", "https"].contains(scheme), url.host != nil else {
            // A build configuration error, never a runtime condition: fail loudly in every configuration.
            fatalError("Info.plist API_BASE_URL is missing or invalid — check Config/Debug.xcconfig / Release.xcconfig")
        }
        let push = (info["WorkModePushEnvironment"] as? String).flatMap(PushEnvironment.init(rawValue:)) ?? .production
        return AppConfiguration(
            apiBaseURL: url,
            pushEnvironment: push,
            appVersion: info["CFBundleShortVersionString"] as? String ?? "0.0.0",
            buildNumber: info["CFBundleVersion"] as? String ?? "0"
        )
    }

    /// "1.0.0 (1)" for display.
    var displayVersion: String { "\(appVersion) (\(buildNumber))" }
}
