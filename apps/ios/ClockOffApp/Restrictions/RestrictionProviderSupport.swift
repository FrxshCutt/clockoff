import Foundation
import ClockOffCore

/// The provider the app runs with: §8.3 `RestrictionProvider` plus selection counts for `/device/state`.
typealias AppRestrictionProvider = RestrictionProvider & SelectionCountsProviding

/// Presents (or, in development, simulates) the employee's choice of apps to block.
///
/// Apple's picker is a SwiftUI view (`FamilyActivityPicker`), so the real configurator
/// (`ScreenTimeSelectionConfigurator`) presents a sheet when `configureSelection()` is called and returns the
/// counts stored so far (usually zero until the sheet is saved). Callers re-read `RestrictionProvider.hasSelection()`
/// afterwards — `Notification.Name.clockOffSelectionDidChange` is posted when a selection is saved.
protocol SelectionConfiguring: AnyObject {
    /// Short label for the onboarding button.
    var actionTitle: String { get }
    /// Records a selection (mock) or presents the picker for the work selection (Screen Time). Returns the
    /// counts currently stored (numbers only).
    func configureSelection() throws -> SelectionCounts
    /// Presents the picker for `kind` (`.breakKept` is the subset that stays blocked during RELAX_CATEGORIES
    /// breaks). The mock simulates a selection of that kind.
    func configureSelection(kind: SelectionKind) throws -> SelectionCounts
}

extension SelectionConfiguring {
    func configureSelection(kind: SelectionKind) throws -> SelectionCounts {
        try configureSelection()
    }
}

/// Compile-time choice of restriction provider (see Config/Debug.xcconfig `DEBUG_MOCK_RESTRICTIONS`).
enum RestrictionProviderFactory {
    struct Choice {
        let provider: AppRestrictionProvider
        let selectionConfigurator: SelectionConfiguring?
        let isMock: Bool
    }

    /// The production graph's choice: the mock under `DEBUG_MOCK_RESTRICTIONS`, Apple's Screen Time otherwise.
    /// `store` is the App Group `UserDefaults` suite (shared flags; the mock also persists its simulation there).
    static func make(store: KeyValueStore) -> Choice {
        #if DEBUG_MOCK_RESTRICTIONS
        let mock = MockRestrictionProvider(store: store)
        return Choice(provider: mock, selectionConfigurator: mock, isMock: true)
        #else
        let fileStore: AppGroupFileStore
        do {
            fileStore = try AppGroupFileStore.live()
        } catch {
            fatalError("ClockOff cannot create its data directory: \(error)")
        }
        return screenTime(fileStore: fileStore, flags: SharedFlags(store: store))
        #endif
    }

    /// Apple's Screen Time provider over the given App Group storage (used by `make(store:)` in builds without
    /// the mock; exposed so a device Debug build with the mock condition off can be wired explicitly).
    static func screenTime(fileStore: AppGroupFileStore, flags: SharedFlags?) -> Choice {
        let provider = AppleScreenTimeRestrictionProvider(fileStore: fileStore, flags: flags)
        let configurator = ScreenTimeSelectionConfigurator(selections: SelectionStore(fileStore: fileStore), flags: flags)
        return Choice(provider: provider, selectionConfigurator: configurator, isMock: false)
    }
}
