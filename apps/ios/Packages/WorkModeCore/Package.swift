// swift-tools-version:5.9
import PackageDescription

// WorkModeCore — Foundation-only domain layer shared by the Work Mode app and its three app extensions
// (DeviceActivityMonitor, ShieldConfiguration, ShieldAction). It must stay small and must never import
// UIKit, SwiftUI or the Screen Time frameworks: extensions have tight memory limits, and the Screen Time
// implementation lives in the app target behind the `RestrictionProvider` protocol defined here.
let package = Package(
    name: "WorkModeCore",
    platforms: [.iOS("16.4")],
    products: [
        .library(name: "WorkModeCore", targets: ["WorkModeCore"]),
    ],
    targets: [
        .target(
            name: "WorkModeCore",
            path: "Sources/WorkModeCore"
        ),
        .testTarget(
            name: "WorkModeCoreTests",
            dependencies: ["WorkModeCore"],
            path: "Tests/WorkModeCoreTests"
        ),
    ],
    swiftLanguageVersions: [.v5]
)
