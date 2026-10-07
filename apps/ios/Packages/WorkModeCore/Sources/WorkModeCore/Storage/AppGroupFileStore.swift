import Foundation

/// Files in the App Group container shared by the app and its extensions (cache, outbox, plans.json).
///
/// - Every write is atomic (write to a temporary file, then rename) and protected with
///   `completeFileProtectionUntilFirstUserAuthentication`, so the DeviceActivityMonitor extension can read
///   them while the phone is locked after its first unlock (shifts start at 6am with the phone in a pocket).
/// - Read-modify-write goes through `NSFileCoordinator`, so the app and an extension updating the same file
///   cannot lose each other's changes. Coordination is short and synchronous; never hold it across `await`.
public final class AppGroupFileStore {
    public let directory: URL
    /// True when `directory` is the real App Group container (false: a per-process fallback directory).
    public let isSharedContainer: Bool
    private let fileManager: FileManager
    private let lock = NSRecursiveLock()

    public init(directory: URL, isSharedContainer: Bool = false, fileManager: FileManager = .default) throws {
        self.directory = directory
        self.isSharedContainer = isSharedContainer
        self.fileManager = fileManager
        try fileManager.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
    }

    /// The App Group container's `ClockOff` directory, or nil when the container is unavailable (the
    /// App Group entitlement is missing — e.g. an unsigned simulator build).
    public static func appGroup(identifier: String = AppGroup.identifier, fileManager: FileManager = .default) -> AppGroupFileStore? {
        guard let container = fileManager.containerURL(forSecurityApplicationGroupIdentifier: identifier) else {
            return nil
        }
        return try? AppGroupFileStore(
            directory: container.appendingPathComponent("ClockOff", isDirectory: true),
            isSharedContainer: true,
            fileManager: fileManager
        )
    }

    /// The App Group store when available, else `Application Support/ClockOffShared` in this process's own
    /// container. The fallback keeps unsigned simulator builds working; extensions cannot see it, which is
    /// logged because on a device it means the entitlement is misconfigured.
    public static func live(identifier: String = AppGroup.identifier, fileManager: FileManager = .default) throws -> AppGroupFileStore {
        if let shared = appGroup(identifier: identifier, fileManager: fileManager) {
            return shared
        }
        WorkModeLog.storage.error("App Group container \(identifier, privacy: .public) unavailable; using a private fallback directory")
        let support = try fileManager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return try AppGroupFileStore(directory: support.appendingPathComponent("ClockOffShared", isDirectory: true), fileManager: fileManager)
    }

    public func url(for name: String) -> URL {
        directory.appendingPathComponent(name, isDirectory: false)
    }

    /// Contents of `name`, or nil when the file does not exist.
    public func read(_ name: String) throws -> Data? {
        lock.lock()
        defer { lock.unlock() }
        let url = url(for: name)
        var coordinationError: NSError?
        var result: Result<Data?, Error> = .success(nil)
        NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: url, options: [], error: &coordinationError) { readURL in
            result = Result { try self.readUncoordinated(readURL) }
        }
        if let coordinationError { throw coordinationError }
        return try result.get()
    }

    /// Atomically replaces `name` with `data`.
    public func write(_ data: Data, to name: String) throws {
        try update(name) { _ in data }
    }

    /// Coordinated read-modify-write. Returning nil from `transform` deletes the file.
    public func update(_ name: String, _ transform: (Data?) throws -> Data?) throws {
        lock.lock()
        defer { lock.unlock() }
        let url = url(for: name)
        var coordinationError: NSError?
        var outcome: Result<Void, Error> = .success(())
        NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: url, options: [.forMerging], error: &coordinationError) { writeURL in
            outcome = Result {
                let current = try self.readUncoordinated(writeURL)
                if let next = try transform(current) {
                    try next.write(to: writeURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                } else if self.fileManager.fileExists(atPath: writeURL.path) {
                    try self.fileManager.removeItem(at: writeURL)
                }
            }
        }
        if let coordinationError { throw coordinationError }
        try outcome.get()
    }

    public func delete(_ name: String) throws {
        try update(name) { _ in nil }
    }

    private func readUncoordinated(_ url: URL) throws -> Data? {
        guard fileManager.fileExists(atPath: url.path) else { return nil }
        return try Data(contentsOf: url)
    }
}
