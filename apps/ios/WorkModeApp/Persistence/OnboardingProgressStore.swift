import Foundation
import WorkModeCore

/// Remembers how far the employee got through onboarding so a relaunch resumes at the right screen. The step
/// is only a hint: `OnboardingResume` clamps it to what the Keychain, cache and Screen Time state allow.
final class OnboardingProgressStore {
    enum Keys {
        static let step = "wm.onboarding.step"
    }

    private let store: KeyValueStore

    init(store: KeyValueStore) {
        self.store = store
    }

    var step: OnboardingViewModel.Step? {
        get { store.string(forKey: Keys.step).flatMap(Int.init).flatMap(OnboardingViewModel.Step.init(rawValue:)) }
        set { store.set(newValue.map { String($0.rawValue) }, forKey: Keys.step) }
    }

    func clear() {
        store.removeValue(forKey: Keys.step)
    }
}
