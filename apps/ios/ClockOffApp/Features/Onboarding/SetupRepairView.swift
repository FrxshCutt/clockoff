import SwiftUI

/// "Setup Repair": re-runs screen 6 (authorise) and/or screen 7 (choose apps) when Screen Time access or the app
/// selection regressed after setup. Presented as a sheet from Home ("Open Setup") and Settings.
struct SetupRepairView: View {
    @ObservedObject var model: OnboardingViewModel
    let onClose: () -> Void

    var body: some View {
        NavigationStack {
            Group {
                switch model.step {
                case .authorise:
                    AuthoriseScreenTimeView(model: model)
                default:
                    ChooseAppsView(model: model)
                }
            }
            .navigationTitle("Setup repair")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", action: onClose)
                }
            }
        }
        .interactiveDismissDisabled(model.isWorking)
    }
}
