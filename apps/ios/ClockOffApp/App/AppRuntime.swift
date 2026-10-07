import Foundation

enum AppRuntime {
    /// True when the process is the host app of an XCTest bundle: launch side effects (network sync,
    /// background task registration, push registration) are skipped so tests stay hermetic.
    static let isRunningUnitTests: Bool = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
}
