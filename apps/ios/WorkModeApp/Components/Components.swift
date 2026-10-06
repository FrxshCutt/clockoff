import SwiftUI
import UIKit

/// Full-width primary action, ≥ 50pt tall, Dynamic Type friendly.
struct PrimaryButton: View {
    let title: String
    var isLoading = false
    var isEnabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if isLoading {
                    ProgressView().tint(.white)
                }
                Text(title)
                    .font(.headline)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity, minHeight: 50)
            .padding(.horizontal, 12)
        }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.roundedRectangle(radius: 14))
        .disabled(!isEnabled || isLoading)
        .accessibilityHint(isLoading ? "In progress" : "")
    }
}

/// Full-width secondary action, ≥ 44pt tall.
struct SecondaryButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.roundedRectangle(radius: 14))
    }
}

/// Inline error shown under a form; announced by VoiceOver when it appears.
struct ErrorMessage: View {
    let message: String

    var body: some View {
        Label {
            Text(message)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "exclamationmark.circle.fill")
        }
        .foregroundStyle(.red)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Error: \(message)")
        .onAppear {
            UIAccessibility.post(notification: .announcement, argument: message)
        }
    }
}

#if DEBUG_MOCK_RESTRICTIONS
/// Persistent banner while `MockRestrictionProvider` is in use. Compiled with the mock only, so a Release build
/// cannot show it (or contain its text).
struct DevelopmentModeBanner: View {
    var body: some View {
        Text("DEVELOPMENT MODE — restrictions are simulated")
            .font(.footnote.weight(.bold))
            .multilineTextAlignment(.center)
            .foregroundStyle(.black)
            .frame(maxWidth: .infinity, minHeight: 32)
            .padding(.horizontal, 12)
            .padding(.vertical, 4)
            .background(Color.yellow)
            .accessibilityAddTraits(.isHeader)
            .accessibilityLabel("Development mode. Restrictions are simulated, apps are not really blocked.")
    }
}
#endif

/// Common layout for onboarding screens: scrolling content, actions pinned to the bottom.
struct OnboardingScreen<Content: View, Actions: View>: View {
    let title: String
    var showsBack = false
    var onBack: () -> Void = {}
    @ViewBuilder let content: () -> Content
    @ViewBuilder let actions: () -> Actions

    var body: some View {
        VStack(spacing: 0) {
            if showsBack {
                HStack {
                    Button(action: onBack) {
                        Label("Back", systemImage: "chevron.backward")
                            .font(.body.weight(.semibold))
                            .frame(minWidth: 44, minHeight: 44, alignment: .leading)
                    }
                    .accessibilityLabel("Back")
                    Spacer()
                }
                .padding(.horizontal)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text(title)
                        .font(.largeTitle.bold())
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                    content()
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(24)
            }
            .scrollDismissesKeyboard(.interactively)
            VStack(spacing: 12) {
                actions()
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 16)
            .background(.bar)
        }
    }
}

/// A line of explanatory body text with a leading SF Symbol.
struct InfoRow: View {
    let systemImage: String
    let text: String
    /// Grows with Dynamic Type so the icon column never clips at accessibility sizes.
    @ScaledMetric(relativeTo: .title3) private var iconWidth: CGFloat = 28

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: systemImage)
                .font(.title3)
                .foregroundStyle(.tint)
                .frame(width: iconWidth)
                .accessibilityHidden(true)
            Text(text)
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }
}
