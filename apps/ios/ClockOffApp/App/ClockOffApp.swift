import SwiftUI

@main
struct ClockOffApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            if AppRuntime.isRunningUnitTests {
                // Hosted unit tests construct their own dependencies; keep the host inert.
                Text("Running tests")
            } else {
                AppRootHost()
            }
        }
    }
}

/// Owns the production `AppModel` so it is only created outside unit tests.
private struct AppRootHost: View {
    @StateObject private var model = AppModel(container: .shared)
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        RootView()
            .environmentObject(model)
            .onAppear { model.start() }
            .onChange(of: scenePhase) { phase in
                model.scenePhaseChanged(phase)
            }
    }
}

struct RootView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Group {
            switch model.route {
            case .launching:
                ProgressView()
                    .accessibilityLabel("Loading")
            case .onboarding:
                if let onboarding = model.onboarding {
                    OnboardingFlowView(model: onboarding, sessionEndedMessage: model.sessionEndedMessage)
                }
            case .main:
                MainTabView()
            }
        }
        #if DEBUG_MOCK_RESTRICTIONS
        .safeAreaInset(edge: .top, spacing: 0) {
            if model.isUsingMockRestrictions {
                DevelopmentModeBanner()
            }
        }
        #endif
    }
}

struct MainTabView: View {
    enum Tab: Hashable {
        case home
        case schedule
        case settings
    }

    @EnvironmentObject private var model: AppModel
    @State private var selectedTab: Tab = .home

    var body: some View {
        TabView(selection: $selectedTab) {
            HomeView()
                .tabItem { Label("Home", systemImage: "house.fill") }
                .tag(Tab.home)
            ScheduleView()
                .tabItem { Label("Schedule", systemImage: "calendar") }
                .tag(Tab.schedule)
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
                .tag(Tab.settings)
        }
        // "Open ClockOff" on a shield: show the status (Home) and clear the request.
        .onChange(of: model.controller.statusRequestedFromShield) { requested in
            guard requested else { return }
            selectedTab = .home
            model.controller.statusRequestedFromShield = false
        }
        .sheet(item: $model.repair) { repair in
            SetupRepairView(model: repair, onClose: { model.dismissRepair() })
        }
        .alert("ClockOff", isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.notice ?? "")
        }
    }
}
