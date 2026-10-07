import Foundation
import UIKit

/// Generic, non-identifying facts about this phone (§12: app version, iOS version, generic model, timezone).
/// Never a device name, serial number or identifier.
protocol DeviceInfoProviding: AnyObject {
    var appVersion: String { get }
    var osVersion: String { get }
    /// Generic model family, e.g. "iPhone".
    var model: String { get }
    var timeZone: TimeZone { get }
}

final class SystemDeviceInfo: DeviceInfoProviding {
    let appVersion: String
    let osVersion: String
    let model: String

    init(configuration: AppConfiguration) {
        appVersion = configuration.appVersion
        osVersion = UIDevice.current.systemVersion
        // `model` is the generic family ("iPhone"); `name` (the user-chosen phone name) is never read.
        model = UIDevice.current.model
    }

    var timeZone: TimeZone { TimeZone.current }
}
