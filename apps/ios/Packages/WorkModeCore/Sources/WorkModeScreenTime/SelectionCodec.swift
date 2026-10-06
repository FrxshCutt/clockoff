import FamilyControls
import Foundation
import WorkModeCore

/// Encodes a `FamilyActivitySelection` for `SelectionStore` and summarises it. The tokens inside are opaque
/// to the app (Apple never reveals which apps they are); only the counts are ever reported (§12).
public enum SelectionCodec {
    public static func encode(_ selection: FamilyActivitySelection) throws -> Data {
        try JSONEncoder().encode(selection)
    }

    public static func decode(_ data: Data) throws -> FamilyActivitySelection {
        try JSONDecoder().decode(FamilyActivitySelection.self, from: data)
    }

    public static func summary(of selection: FamilyActivitySelection) -> SelectionSummary {
        SelectionSummary(
            categoryCount: selection.categoryTokens.count,
            applicationCount: selection.applicationTokens.count,
            webDomainCount: selection.webDomainTokens.count
        )
    }

    /// Persists `selection` as `kind` and returns its counts.
    @discardableResult
    public static func save(_ selection: FamilyActivitySelection, kind: SelectionKind, to store: SelectionStore, at date: Date = Date()) throws -> SelectionSummary {
        let summary = summary(of: selection)
        try store.save(try encode(selection), summary: summary, kind: kind, format: SelectionStore.familyActivitySelectionFormat, at: date)
        return summary
    }

    /// The stored selection of `kind`, or an empty one when none (or an unreadable one) is stored.
    public static func load(_ kind: SelectionKind, from store: SelectionStore) -> FamilyActivitySelection {
        guard let stored = store.load(kind), stored.format == SelectionStore.familyActivitySelectionFormat,
              let selection = try? decode(stored.payload) else {
            return FamilyActivitySelection()
        }
        return selection
    }
}
