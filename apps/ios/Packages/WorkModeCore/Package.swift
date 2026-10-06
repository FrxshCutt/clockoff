// swift-tools-version:5.9
import PackageDescription

// WorkModeCore — Foundation-only domain layer shared by the Work Mode app and its three app extensions
// (DeviceActivityMonitor, ShieldConfiguration, ShieldAction). It must stay small and must never import
// UIKit, SwiftUI or the Screen Time frameworks: extensions have tight memory limits, and every decision
// (engine, break rules, shield applier, monitor handler) is unit-tested here in the simulator.
//
// WorkModeScreenTime — the thin adapter over ManagedSettings / FamilyControls (`ManagedSettingsShieldStore`,
// `SelectionCodec`) shared by the app and the DeviceActivityMonitor extension so both apply shields identically.
// It holds no logic of its own.
//
// Tests/WorkModeCoreTests/Fixtures/workmode-cases.json is a COPY of docs/fixtures/workmode-cases.json
// (`make sync-fixtures` refreshes it; `WorkModeFixtureTests` fails when the two differ).
let package = Package(
    name: "WorkModeCore",
    platforms: [.iOS("16.4")],
    products: [
        .library(name: "WorkModeCore", targets: ["WorkModeCore"]),
        .library(name: "WorkModeScreenTime", targets: ["WorkModeScreenTime"]),
    ],
    targets: [
        .target(
            name: "WorkModeCore",
            path: "Sources/WorkModeCore"
        ),
        .target(
            name: "WorkModeScreenTime",
            dependencies: ["WorkModeCore"],
            path: "Sources/WorkModeScreenTime"
        ),
        .testTarget(
            name: "WorkModeCoreTests",
            dependencies: ["WorkModeCore"],
            path: "Tests/WorkModeCoreTests",
            resources: [.copy("Fixtures/workmode-cases.json")]
        ),
        .testTarget(
            name: "WorkModeScreenTimeTests",
            dependencies: ["WorkModeScreenTime"],
            path: "Tests/WorkModeScreenTimeTests"
        ),
    ],
    swiftLanguageVersions: [.v5]
)
