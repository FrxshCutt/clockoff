import SwiftUI
import WorkModeCore

// Screens 5–8. Functional against the real seams (provider authorisation, selection, /sync, /device/state,
// /events); the Screen Time stage replaces the selection placeholder with Apple's FamilyActivityPicker.

// MARK: 5 — Screen Time explained

struct ScreenTimeExplainedView: View {
    @ObservedObject var model: OnboardingViewModel

    var body: some View {
        OnboardingScreen(title: "How Work Mode works") {
            InfoRow(systemImage: "hourglass", text: "Work Mode uses Apple's Screen Time to pause the apps you choose while you're on shift.")
            InfoRow(systemImage: "calendar", text: "It follows the shifts your employer schedules, even when this app is closed.")
            InfoRow(systemImage: "cup.and.saucer.fill", text: "Breaks relax the blocks, and everything lifts when your shift ends.")
            InfoRow(systemImage: "hand.raised.fill", text: "Your employer only sees whether Work Mode is set up and working — never which apps you choose or what you do on your phone.")
        } actions: {
            PrimaryButton(title: "Continue") { model.continueFromScreenTimeExplained() }
        }
    }
}

// MARK: 6 — Authorise

struct AuthoriseScreenTimeView: View {
    @ObservedObject var model: OnboardingViewModel

    var body: some View {
        OnboardingScreen(title: "Allow Screen Time", showsBack: true, onBack: model.back) {
            Text("iOS will ask you to allow Work Mode to use Screen Time. This lets it block apps during your shifts on this iPhone.")
            Text("You can turn it off at any time in Settings › Screen Time. Your manager will see that Work Mode needs attention, but nothing else.")
                .font(.callout)
                .foregroundStyle(.secondary)
            if let error = model.errorMessage { ErrorMessage(message: error) }
        } actions: {
            PrimaryButton(
                title: model.authorizationStatus == .approved ? "Continue" : "Allow Screen Time access",
                isLoading: model.isWorking
            ) {
                Task { await model.authorise() }
            }
        }
    }
}

// MARK: 7 — Choose apps

struct ChooseAppsView: View {
    @ObservedObject var model: OnboardingViewModel

    var body: some View {
        OnboardingScreen(title: "Choose apps to block", showsBack: true, onBack: model.back) {
            Text("Pick the apps and categories to pause during your shifts. Your choices stay on this iPhone — your employer only sees how many you picked.")
            if model.hasSelection {
                let counts = model.selectionCounts
                Label("\(counts.categories) categories, \(counts.applications) apps and \(counts.webDomains) websites selected", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            } else if !model.canConfigureSelection {
                Text("App selection isn't available in this build yet.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            if let error = model.errorMessage { ErrorMessage(message: error) }
        } actions: {
            PrimaryButton(
                title: model.hasSelection ? "Continue" : model.selectionActionTitle,
                isEnabled: model.hasSelection || model.canConfigureSelection
            ) {
                model.chooseApps()
            }
        }
    }
}

// MARK: 8 — Confirm policy

struct ConfirmPolicyView: View {
    @ObservedObject var model: OnboardingViewModel

    var body: some View {
        OnboardingScreen(title: "Your workplace settings", showsBack: true, onBack: model.back) {
            if let policy = model.policy {
                VStack(alignment: .leading, spacing: 12) {
                    DetailLine(label: "Work policy", value: policy.policy.name)
                    Text("Blocked during shifts").font(.headline)
                    ForEach(policy.restrictionConfig.categories, id: \.self) { category in
                        Label(category.label, systemImage: "nosign")
                    }
                    if !policy.restrictionConfig.alwaysAllowedNote.isEmpty {
                        Text("Always allowed").font(.headline)
                        Text(policy.restrictionConfig.alwaysAllowedNote.joined(separator: ", "))
                    }
                    if let rules = model.breakPolicy?.rules {
                        Text("Breaks").font(.headline)
                        Text(breakSummary(rules))
                    }
                }
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
            } else if model.isWorking {
                ProgressView("Loading your workplace settings…")
            } else if !model.policyLoadFailed {
                Text("Your workplace hasn't published a Work Policy yet. Work Mode will apply it automatically once it does.")
            }
            if let error = model.errorMessage { ErrorMessage(message: error) }
        } actions: {
            PrimaryButton(title: "Complete Setup", isLoading: model.isWorking) {
                Task { await model.completeSetup() }
            }
        }
        .task { await model.loadPolicy() }
    }

    private func breakSummary(_ rules: BreakPolicyRules) -> String {
        guard rules.breaksEnabled else { return "Breaks are not available in Work Mode." }
        let relax: String
        switch rules.restrictionBehaviour {
        case .relaxAll:
            relax = "all apps are allowed"
        case .relaxCategories:
            relax = rules.relaxedCategories.isEmpty ? "apps stay blocked" : "\(rules.relaxedCategories.map(\.label).joined(separator: ", ")) are allowed"
        case .keepRestrictions:
            relax = "apps stay blocked"
        }
        return "Up to \(rules.maxBreaksPerShift) breaks per shift, \(rules.maxBreakDurationMinutes) minutes each. During a break \(relax)."
    }
}
