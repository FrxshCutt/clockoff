import Foundation
import os

/// Unified logging categories. Never log tokens, request bodies or anything from §12's CANNOT list.
public enum WorkModeLog {
    public static let subsystem = "online.clockoff.app"

    public static let network = Logger(subsystem: subsystem, category: "network")
    public static let storage = Logger(subsystem: subsystem, category: "storage")
    public static let restrictions = Logger(subsystem: subsystem, category: "restrictions")
    public static let sync = Logger(subsystem: subsystem, category: "sync")
    public static let engine = Logger(subsystem: subsystem, category: "engine")
    public static let app = Logger(subsystem: subsystem, category: "app")
    public static let extensions = Logger(subsystem: subsystem, category: "extensions")
}
