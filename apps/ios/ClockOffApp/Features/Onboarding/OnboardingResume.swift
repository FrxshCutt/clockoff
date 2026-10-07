import Foundation

/// Which onboarding screen a relaunch resumes at. The persisted step is only a hint: it is clamped to what the
/// Keychain (joined), the cache (setup completed) and the Screen Time state (authorised, selection) allow.
enum OnboardingResume {
    /// Nil means the phone is set up: show the main tabs.
    static func step(
        joined: Bool,
        setupCompleted: Bool,
        persisted: OnboardingViewModel.Step?,
        authorised: Bool,
        hasSelection: Bool
    ) -> OnboardingViewModel.Step? {
        guard joined else { return .welcome }
        if setupCompleted { return nil }
        let ceiling: OnboardingViewModel.Step = authorised ? (hasSelection ? .confirmPolicy : .chooseApps) : .authorise
        let floor: OnboardingViewModel.Step = .screenTimeExplained
        guard let persisted else { return authorised ? ceiling : floor }
        return min(max(persisted, floor), ceiling)
    }

    /// The first screen of the repair flow: authorisation when it is missing, else the app selection.
    static func repairStep(authorised: Bool, hasSelection: Bool) -> OnboardingViewModel.Step {
        authorised ? .chooseApps : .authorise
    }
}
