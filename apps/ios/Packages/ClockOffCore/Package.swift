// swift-tools-version:5.9
import PackageDescription

// ClockOffCore — Foundation-only domain layer shared by the ClockOff app and its three app extensions
// (DeviceActivityMonitor, ShieldConfiguration, ShieldAction). It must stay small and must never import
// UIKit, SwiftUI or the Screen Time frameworks: extensions have tight memory limits, and every decision
// (engine, break rules, shield applier, monitor handler) is unit-tested here in the simulator.
//
// ClockOffScreenTime — the thin adapter over ManagedSettings / FamilyControls (`ManagedSettingsShieldStore`,
// `SelectionCodec`) shared by the app and the DeviceActivityMonitor extension so both apply shields identically.
// It holds no logic of its own.
//
// Tests/ClockOffCoreTests/Fixtures/workmode-cases.json is a COPY of docs/fixtures/workmode-cases.json
// (`make sync-fixtures` refreshes it; `WorkModeFixtureTests` fails when the two differ).
let package = Package(
    name: "ClockOffCore",
    platforms: [.iOS("16.4")],
    products: [
        .library(name: "ClockOffCore", targets: ["ClockOffCore"]),
        .library(name: "ClockOffScreenTime", targets: ["ClockOffScreenTime"]),
    ],
    targets: [
        .target(
            name: "ClockOffCore",
            path: "Sources/ClockOffCore"
        ),
        .target(
            name: "ClockOffScreenTime",
            dependencies: ["ClockOffCore"],
            path: "Sources/ClockOffScreenTime"
        ),
        .testTarget(
            name: "ClockOffCoreTests",
            dependencies: ["ClockOffCore"],
            path: "Tests/ClockOffCoreTests",
            resources: [.copy("Fixtures/workmode-cases.json")]
        ),
        .testTarget(
            name: "ClockOffScreenTimeTests",
            dependencies: ["ClockOffScreenTime"],
            path: "Tests/ClockOffScreenTimeTests"
        ),
    ],
    swiftLanguageVersions: [.v5]
)
