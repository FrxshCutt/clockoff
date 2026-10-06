import Foundation

/// Which selection a stored payload is.
public enum SelectionKind: String, Codable, CaseIterable, Sendable {
    /// Everything shielded during a shift.
    case work
    /// The subset that stays shielded during a RELAX_CATEGORIES break (the second picker pass).
    case breakKept

    var fileName: String { "selection-\(rawValue).json" }
}

/// A persisted selection: the provider's opaque payload (the JSON of a `FamilyActivitySelection`, which only
/// the Screen Time frameworks can interpret) plus its counts. WorkModeCore never decodes the payload.
public struct StoredSelection: Codable, Equatable, Sendable {
    /// Identifies the payload encoding so a future format change is detected (`SelectionStore.familyActivitySelectionFormat`).
    public var format: String
    public var payload: Data
    public var summary: SelectionSummary
    public var updatedAt: Date

    public init(format: String, payload: Data, summary: SelectionSummary, updatedAt: Date) {
        self.format = format
        self.payload = payload
        self.summary = summary
        self.updatedAt = updatedAt
    }
}

/// Persists the employee's selections in the App Group container (`selection-work.json`,
/// `selection-breakKept.json`) with `completeUntilFirstUserAuthentication` protection, so the
/// DeviceActivityMonitor extension can re-apply shields at 6am with the phone still in a pocket.
/// Only counts (`SelectionSummary`) are ever read for reporting; the payload goes straight back into
/// `ManagedSettingsStore` through a `ShieldStoring` adapter.
public final class SelectionStore {
    /// Payload format written by the app's `SelectionCodec` (JSON-encoded `FamilyActivitySelection`).
    public static let familyActivitySelectionFormat = "FamilyActivitySelection.json.v1"

    private let fileStore: AppGroupFileStore

    public init(fileStore: AppGroupFileStore) {
        self.fileStore = fileStore
    }

    public func save(_ payload: Data, summary: SelectionSummary, kind: SelectionKind, format: String = SelectionStore.familyActivitySelectionFormat, at date: Date = Date()) throws {
        let stored = StoredSelection(format: format, payload: payload, summary: summary, updatedAt: date)
        try fileStore.write(try JSONEncoder.workMode.encode(stored), to: kind.fileName)
    }

    public func load(_ kind: SelectionKind) -> StoredSelection? {
        do {
            guard let data = try fileStore.read(kind.fileName) else { return nil }
            return try JSONDecoder.workMode.decode(StoredSelection.self, from: data)
        } catch {
            WorkModeLog.storage.error("\(kind.fileName, privacy: .public) unreadable: \(String(describing: error), privacy: .public)")
            return nil
        }
    }

    /// The opaque payload, or nil when nothing (or nothing usable) is stored.
    public func payload(_ kind: SelectionKind) -> Data? {
        guard let stored = load(kind), !stored.summary.isEmpty else { return nil }
        return stored.payload
    }

    public func summary(_ kind: SelectionKind) -> SelectionSummary {
        load(kind)?.summary ?? .empty
    }

    /// True when a non-empty selection of `kind` is stored.
    public func hasSelection(_ kind: SelectionKind) -> Bool {
        !summary(kind).isEmpty
    }

    public func remove(_ kind: SelectionKind) throws {
        try fileStore.delete(kind.fileName)
    }

    /// Forgets every selection (Leave Workplace / Sign Out).
    public func removeAll() throws {
        for kind in SelectionKind.allCases { try remove(kind) }
    }
}
