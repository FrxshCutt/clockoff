import SwiftUI
import UIKit
import WorkModeCore

// Screens 5–8: Screen Time explainer, authorisation, app selection (Apple's FamilyActivityPicker through
// `SelectionConfiguring`; "Simulate selection" with the mock) and the policy confirmation.

// MARK: 5 — Screen Time explained

struct ScreenTimeExplainedView: View {
    @ObservedObject var model: OnboardingViewModel

    var body: some View {
        OnboardingScreen(title: "How Work Mode works") {
            InfoRow(systemImage: "hourglass", text: "Work Mode uses Apple's Screen Time to pause the apps you choose while you're on shift.")
            InfoRow(systemImage: "calendar", text: "It follows the shifts your employer schedules, even when this app is closed.")
            InfoRow(systemImage: "cup.and.saucer.fill", text: "Breaks relax the blocks, and everything lifts when your shift ends.")
            Text("Your privacy").font(.headline).padding(.top, 4)
            InfoRow(systemImage: "eye", text: "Your employer can see whether Work Mode is set up and working, when you take breaks and when your phone last synced.")
            InfoRow(systemImage: "eye.slash.fill", text: "Your employer cannot see your messages, photos, browsing, notifications, how you use your phone or which apps you chose.")
            InfoRow(systemImage: "iphone", text: "Your app choices stay on this iPhone as Apple tokens that nobody else can read — only counts are sent.")
        } actions: {
            PrimaryButton(title: "Continue") { model.continueFromScreenTimeExplained() }
        }
        .task { await model.loadPolicy(force: false) }
    }
}

// MARK: 6 — Authorise

struct AuthoriseScreenTimeView: View {
    @ObservedObject var model: OnboardingViewModel

    var body: some View {
        OnboardingScreen(title: "Allow Screen Time", showsBack: model.canGoBack, onBack: model.back) {
            Text("iOS will ask you to allow Work Mode to use Screen Time. This lets it block apps during your shifts on this iPhone.")
            Text("You can turn it off at any time in Settings › Screen Time. Your manager will see that Work Mode needs attention, but nothing else.")
                .font(.callout)
                .foregroundStyle(.secondary)
            switch model.authorisation {
            case .approved:
                Label("Screen Time access is allowed", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            case .denied:
                Label("Screen Time access is not allowed", systemImage: "xmark.octagon.fill")
                    .foregroundStyle(.red)
            case .failed, .notRequested:
                EmptyView()
            }
            if let error = model.errorMessage { ErrorMessage(message: error) }
        } actions: {
            switch model.authorisation {
            case .approved:
                PrimaryButton(title: "Continue", isLoading: model.isWorking) {
                    Task { await model.authorise() }
                }
            case .denied:
                PrimaryButton(title: "Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
                SecondaryButton(title: "Try again") {
                    Task { await model.authorise() }
                }
            case .failed:
                PrimaryButton(title: "Try again", isLoading: model.isWorking) {
                    Task { await model.authorise() }
                }
            case .notRequested:
                PrimaryButton(title: "Allow Screen Time access", isLoading: model.isWorking) {
                    Task { await model.authorise() }
                }
            }
        }
    }
}

// MARK: 7 — Choose apps

struct ChooseAppsView: View {
    @ObservedObject var model: OnboardingViewModel

    var body: some View {
        OnboardingScreen(title: "Choose apps to block", showsBack: model.canGoBack, onBack: model.back) {
            if model.policyCategoryLabels.isEmpty {
                Text("Pick the apps and categories to pause during your shifts. Your choices stay on this iPhone — your employer only sees how many you picked.")
            } else {
                Text("Your workplace blocks these categories during shifts. Pick them in the app picker (and any apps you'd add). Your choices stay on this iPhone — your employer only sees how many you picked.")
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(model.policyCategoryLabels, id: \.self) { label in
                        Label(label, systemImage: "nosign")
                    }
                }
                .padding(.leading, 4)
            }
            if !model.selectionRequired {
                Text("Choosing apps is optional at your workplace.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            selectionStatus
            if model.needsBreakKeptSelection {
                Divider()
                Text("Apps that stay restricted during breaks").font(.headline)
                Text(breakSubsetExplanation)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                breakSelectionStatus
                SecondaryButton(title: model.breakSelectionActionTitle) { model.chooseBreakKeptApps() }
            }
            if !model.canConfigureSelection {
                Text("App selection isn't available in this build yet.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            if model.selectionIncompleteShown, let problem = model.selectionProblem {
                Label("Selection incomplete", systemImage: "exclamationmark.triangle.fill")
                    .font(.headline)
                    .foregroundStyle(.orange)
                Text(problem)
                    .font(.callout)
            } else if let error = model.errorMessage {
                ErrorMessage(message: error)
            }
        } actions: {
            if model.canConfigureSelection {
                if model.hasSelection {
                    SecondaryButton(title: model.selectionActionTitle) { model.chooseApps() }
                } else {
                    PrimaryButton(title: model.selectionActionTitle) { model.chooseApps() }
                }
            }
            PrimaryButton(title: "Continue", isLoading: model.isWorking) {
                Task { await model.continueFromChooseApps() }
            }
        }
    }

    private var selectionStatus: some View {
        Group {
            if model.hasSelection {
                let counts = model.selectionCounts
                Label("\(counts.categories) categories, \(counts.applications) apps and \(counts.webDomains) websites selected", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            } else {
                Label("Nothing selected yet", systemImage: "circle.dashed")
                    .foregroundStyle(.secondary)
            }
        }
        .font(.callout)
    }

    private var breakSelectionStatus: some View {
        Group {
            if model.hasBreakKeptSelection {
                let counts = model.breakKeptSelectionCounts
                Label("\(counts.categories) categories, \(counts.applications) apps and \(counts.webDomains) websites stay blocked on breaks", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            } else {
                Label("Not chosen yet", systemImage: "circle.dashed")
                    .foregroundStyle(.secondary)
            }
        }
        .font(.callout)
    }

    private var breakSubsetExplanation: String {
        let relaxed = model.relaxedCategoryLabels
        let allowed = relaxed.isEmpty ? "some categories" : relaxed.joined(separator: ", ")
        return "On breaks your workplace allows \(allowed). Apple can't tell which of your chosen apps those are, so pick the subset of your selection that should stay blocked during breaks — everything else you chose is allowed on a break."
    }
}

// MARK: 8 — Confirm policy

struct ConfirmPolicyView: View {
    @ObservedObject var model: OnboardingViewModel

    var body: some View {
        OnboardingScreen(title: "Your workplace settings", showsBack: model.canGoBack, onBack: model.back) {
            VStack(alignment: .leading, spacing: 12) {
                DetailLine(label: "Your workplace", value: model.workplaceName ?? "—")
                if let name = model.employeeName { DetailLine(label: "You", value: name) }
                if let policy = model.policy {
                    DetailLine(label: "Policy", value: policy.policy.name)
                    Text("During Work Mode").font(.headline)
                    if model.policyCategoryLabels.isEmpty {
                        Text("The apps you chose are blocked.")
                    } else {
                        ForEach(model.policyCategoryLabels, id: \.self) { label in
                            Label(label, systemImage: "nosign")
                        }
                    }
                    if !policy.restrictionConfig.alwaysAllowedNote.isEmpty {
                        Text("Always available").font(.headline)
                        Text(policy.restrictionConfig.alwaysAllowedNote.joined(separator: ", "))
                    }
                    Text("Break allowance").font(.headline)
                    Text(model.breakAllowanceSummary ?? "Breaks are not available in Work Mode.")
                    if let message = policy.restrictionConfig.shieldMessage, !message.isEmpty {
                        Text("Shield message").font(.headline)
                        Text("“\(message)”").italic()
                    }
                } else if model.isLoadingPolicy {
                    ProgressView("Loading your workplace settings…")
                } else if !model.policyLoadFailed {
                    Text("Your workplace hasn't published a Work Policy yet. Work Mode will apply it automatically once it does.")
                }
            }
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
            if let error = model.errorMessage { ErrorMessage(message: error) }
        } actions: {
            PrimaryButton(title: "Complete Setup", isLoading: model.isWorking) {
                Task { await model.completeSetup() }
            }
        }
        .task { await model.loadPolicy() }
    }
}
