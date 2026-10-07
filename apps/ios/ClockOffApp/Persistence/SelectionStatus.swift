import Foundation
import ClockOffCore

/// Whether the employee's selections exist, and their counts (numbers only, §12). `RestrictionProvider` only
/// exposes the work selection; the "keep blocked on breaks" subset (`SelectionKind.breakKept`) is read here so
/// onboarding and Settings can tell whether a RELAX_CATEGORIES policy is fully configured.
protocol SelectionStatusProviding: AnyObject {
    func hasSelection(_ kind: SelectionKind) -> Bool
    func counts(_ kind: SelectionKind) -> SelectionCounts
}

/// Reads the App Group selection files written by Apple's picker (`SelectionCodec` → `SelectionStore`).
final class SelectionStoreStatus: SelectionStatusProviding {
    private let store: SelectionStore

    init(store: SelectionStore) {
        self.store = store
    }

    func hasSelection(_ kind: SelectionKind) -> Bool {
        store.hasSelection(kind)
    }

    func counts(_ kind: SelectionKind) -> SelectionCounts {
        store.summary(kind).counts
    }
}

#if DEBUG_MOCK_RESTRICTIONS
extension MockRestrictionProvider: SelectionStatusProviding {
    func hasSelection(_ kind: SelectionKind) -> Bool {
        switch kind {
        case .work: return hasSelection()
        case .breakKept: return (breakKeptSelectionCounts?.total ?? 0) > 0
        }
    }

    func counts(_ kind: SelectionKind) -> SelectionCounts {
        switch kind {
        case .work: return selectionCounts()
        case .breakKept: return breakKeptSelectionCounts ?? .zero
        }
    }
}
#endif
