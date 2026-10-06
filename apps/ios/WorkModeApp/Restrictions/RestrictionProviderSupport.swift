import Foundation
import WorkModeCore

/// The provider the app runs with: §8.3 `RestrictionProvider` plus selection counts for `/device/state`.
typealias AppRestrictionProvider = RestrictionProvider & SelectionCountsProviding

/// Presents (or, in development, simulates) the employee's choice of apps to block. The Apple
/// implementation (FamilyActivityPicker) arrives with the Screen Time stage; until then Release builds
/// have no configurator and onboarding says so instead of pretending.
protocol SelectionConfiguring: AnyObject {
    /// Short label for the onboarding button.
    var actionTitle: String { get }
    /// Records a selection. Returns the resulting counts (numbers only).
    func configureSelection() throws -> SelectionCounts
}

/// Compile-time choice of restriction provider (see Config/Debug.xcconfig `DEBUG_MOCK_RESTRICTIONS`).
enum RestrictionProviderFactory {
    struct Choice {
        let provider: AppRestrictionProvider
        let selectionConfigurator: SelectionConfiguring?
        let isMock: Bool
    }

    static func make(store: KeyValueStore) -> Choice {
        #if DEBUG_MOCK_RESTRICTIONS
        let mock = MockRestrictionProvider(store: store)
        return Choice(provider: mock, selectionConfigurator: mock, isMock: true)
        #else
        return Choice(provider: AppleScreenTimeRestrictionProvider(), selectionConfigurator: nil, isMock: false)
        #endif
    }
}
