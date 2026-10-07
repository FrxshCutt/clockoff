import SwiftUI
import ClockOffCore

struct OnboardingFlowView: View {
    @ObservedObject var model: OnboardingViewModel
    var sessionEndedMessage: String?

    var body: some View {
        Group {
            switch model.step {
            case .welcome:
                WelcomeView(model: model, notice: sessionEndedMessage)
            case .name:
                NameEntryView(model: model)
            case .joinWorkplace:
                JoinWorkplaceView(model: model)
            case .confirmIdentity:
                ConfirmIdentityView(model: model)
            case .screenTimeExplained:
                ScreenTimeExplainedView(model: model)
            case .authorise:
                AuthoriseScreenTimeView(model: model)
            case .chooseApps:
                ChooseAppsView(model: model)
            case .confirmPolicy:
                ConfirmPolicyView(model: model)
            }
        }
        .animation(.default, value: model.step)
    }
}

// MARK: 1 — Welcome

struct WelcomeView: View {
    @ObservedObject var model: OnboardingViewModel
    var notice: String?

    var body: some View {
        OnboardingScreen(title: "ClockOff") {
            Image(systemName: "lock.shield.fill")
                .font(.system(size: 64))
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            if let notice {
                Text(notice)
                    .font(.callout)
                    .padding()
                    .background(Color.orange.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
            }
            Text("Your employer uses ClockOff to reduce phone distractions while you're working.")
                .font(.title2.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            InfoRow(systemImage: "eye.slash.fill", text: "ClockOff cannot see your messages, photos or browsing history.")
            InfoRow(systemImage: "clock.fill", text: "Distracting apps are blocked only during your shifts, and relax on breaks.")
        } actions: {
            PrimaryButton(title: "Get Started") { model.getStarted() }
        }
    }
}

// MARK: 2 — Your name

struct NameEntryView: View {
    @ObservedObject var model: OnboardingViewModel
    @FocusState private var focused: Field?

    private enum Field { case first, last }

    var body: some View {
        OnboardingScreen(title: "Your name", showsBack: true, onBack: model.back) {
            Text("Enter your name as your employer has it, so we can find you.")
                .font(.body)
            VStack(alignment: .leading, spacing: 8) {
                Text("First name").font(.headline)
                TextField("First name", text: $model.firstName)
                    .textContentType(.givenName)
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
                    .submitLabel(.next)
                    .focused($focused, equals: .first)
                    .onSubmit { focused = .last }
                    .textFieldStyle(.roundedBorder)
                    .font(.title3)
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("Last name").font(.headline)
                TextField("Last name", text: $model.lastName)
                    .textContentType(.familyName)
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
                    .submitLabel(.continue)
                    .focused($focused, equals: .last)
                    .onSubmit { model.submitName() }
                    .textFieldStyle(.roundedBorder)
                    .font(.title3)
            }
            if let error = model.errorMessage { ErrorMessage(message: error) }
        } actions: {
            PrimaryButton(title: "Continue", isEnabled: model.canSubmitName) { model.submitName() }
        }
        .onAppear { focused = .first }
    }
}

// MARK: 3 — Join workplace

struct JoinWorkplaceView: View {
    @ObservedObject var model: OnboardingViewModel

    var body: some View {
        OnboardingScreen(title: "Join your workplace", showsBack: true, onBack: model.back) {
            Text("Enter the company code your manager gave you.")
            VStack(alignment: .leading, spacing: 8) {
                Text("Company code").font(.headline)
                TextField(CompanyCode.placeholder, text: Binding(
                    get: { model.companyCode },
                    set: { model.updateCompanyCode($0) }
                ))
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .keyboardType(.asciiCapable)
                .textFieldStyle(.roundedBorder)
                .font(.title2.monospaced())
                .accessibilityLabel("Company code")
                .accessibilityHint("A word, a dash, then four numbers, like \(CompanyCode.placeholder)")
            }
            Toggle(isOn: $model.hasEmployeeCode) {
                Text("I have an employee code").font(.body)
            }
            .frame(minHeight: 44)
            if model.hasEmployeeCode {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Employee code").font(.headline)
                    TextField("K7PX2M", text: $model.employeeCode)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .keyboardType(.asciiCapable)
                        .textFieldStyle(.roundedBorder)
                        .font(.title2.monospaced())
                        .accessibilityLabel("Employee code")
                }
            }
            if let error = model.errorMessage { ErrorMessage(message: error) }
        } actions: {
            PrimaryButton(title: "Find me", isLoading: model.isWorking, isEnabled: model.canLookUp) {
                Task { await model.lookUp() }
            }
        }
    }
}

// MARK: 4 — Confirm it's you

struct ConfirmIdentityView: View {
    @ObservedObject var model: OnboardingViewModel

    var body: some View {
        OnboardingScreen(title: "Confirm it's you", showsBack: true, onBack: model.back) {
            if let preview = model.preview {
                VStack(alignment: .leading, spacing: 16) {
                    DetailLine(label: "Workplace", value: model.workplaceName ?? "—")
                    DetailLine(label: "Name", value: preview.fullName)
                    DetailLine(label: "Job title", value: preview.jobTitle ?? "Not set")
                    DetailLine(label: "Location", value: preview.locationName ?? "Not set")
                }
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
                Text("Connecting this phone lets ClockOff block distracting apps during your shifts at this workplace.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            if let error = model.errorMessage { ErrorMessage(message: error) }
        } actions: {
            PrimaryButton(title: "Yes, that's me", isLoading: model.isWorking) {
                Task { await model.confirmIdentity() }
            }
            SecondaryButton(title: "That's not me") { model.rejectIdentity() }
        }
    }
}

struct DetailLine: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.subheadline).foregroundStyle(.secondary)
            Text(value).font(.title3.weight(.semibold))
        }
        .accessibilityElement(children: .combine)
    }
}
