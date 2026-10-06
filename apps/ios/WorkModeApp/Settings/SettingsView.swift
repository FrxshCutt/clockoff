import SwiftUI
import UIKit
import WorkModeCore

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var confirmingLeave = false
    @State private var confirmingSignOut = false
    @State private var isLeaving = false
    @State private var actionError: String?

    var body: some View {
        let cache = model.cachedState
        let time = TimeFormatting(timeZone: .current, now: Date())
        NavigationStack {
            List {
                Section("Workplace") {
                    LabeledContent("Workplace", value: cache.organisation?.name ?? "—")
                    LabeledContent("Name", value: cache.employee?.fullName ?? "—")
                    if let title = cache.employee?.jobTitle { LabeledContent("Job title", value: title) }
                    if let location = cache.employee?.primaryLocation?.name { LabeledContent("Location", value: location) }
                    if let policy = cache.policy { LabeledContent("Work policy", value: policy.policy.name) }
                }

                Section("Connection status") {
                    LabeledContent("Status", value: connectionText(cache))
                    LabeledContent("Last sync", value: cache.lastSyncAt.map(time.relative) ?? "Never")
                    if let error = model.lastSyncError {
                        Text(error.message).font(.footnote).foregroundStyle(.secondary)
                    }
                    Button("Sync now") { Task { await model.refresh(reason: .pullToRefresh) } }
                        .frame(minHeight: 44)
                        .disabled(model.isSyncing)
                }

                Section("Permissions") {
                    LabeledContent("Screen Time access", value: permissionText(model.permissionState))
                    LabeledContent("Apps to block", value: selectionText)
                    if !model.permissionState.isApproved {
                        Button("Open iPhone Settings") {
                            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                        }
                        .frame(minHeight: 44)
                    }
                }

                Section {
                    NavigationLink("Privacy — what your employer can see") { PrivacyView() }
                        .frame(minHeight: 44)
                    NavigationLink("Help") { HelpView() }
                        .frame(minHeight: 44)
                }

                Section("Device info") {
                    LabeledContent("App version", value: model.container.configuration.displayVersion)
                    LabeledContent("iOS version", value: model.container.deviceInfo.osVersion)
                    LabeledContent("Device", value: model.container.deviceInfo.model)
                    LabeledContent("Timezone", value: model.container.deviceInfo.timeZone.identifier)
                    LabeledContent("Policy synced", value: cache.lastPolicySyncAt.map(time.dateTime) ?? "Never")
                    LabeledContent("Schedule synced", value: cache.lastScheduleSyncAt.map(time.dateTime) ?? "Never")
                    LabeledContent("Last check-in", value: cache.lastDeviceStateReportAt.map(time.dateTime) ?? "Never")
                    if model.isUsingMockRestrictions {
                        LabeledContent("Restrictions", value: "Simulated (development)")
                    }
                }

                Section {
                    Button(role: .destructive) {
                        confirmingLeave = true
                    } label: {
                        if isLeaving {
                            ProgressView().accessibilityLabel("Leaving workplace")
                        } else {
                            Text("Leave Workplace")
                        }
                    }
                    .frame(minHeight: 44)
                    .disabled(isLeaving)
                    Button("Sign Out") { confirmingSignOut = true }
                        .frame(minHeight: 44)
                        .disabled(isLeaving)
                } footer: {
                    Text("Leaving lifts every Work Mode restriction on this iPhone and disconnects it from your workplace.")
                }
            }
            .navigationTitle("Settings")
            .confirmationDialog("Leave \(cache.organisation?.name ?? "this workplace")?", isPresented: $confirmingLeave, titleVisibility: .visible) {
                Button("Leave Workplace", role: .destructive) { leave() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Work Mode will stop blocking apps on this iPhone and your manager will see it as disconnected.")
            }
            .confirmationDialog("Sign out of Work Mode?", isPresented: $confirmingSignOut, titleVisibility: .visible) {
                Button("Sign Out", role: .destructive) { Task { await model.signOut() } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Restrictions are lifted on this iPhone until you join again.")
            }
            .alert("Left on this iPhone", isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(actionError ?? "")
            }
        }
    }

    private var selectionText: String {
        guard model.hasSelection else { return "Not chosen" }
        let counts = model.selectionCounts
        return "\(counts.categories) categories, \(counts.applications) apps, \(counts.webDomains) sites"
    }

    private func connectionText(_ cache: CachedState) -> String {
        if !cache.isJoined { return "Not connected" }
        if HomeCard.isSyncStale(cache: cache, now: Date()) { return "Connected — sync delayed" }
        return "Connected"
    }

    private func permissionText(_ state: PermissionState) -> String {
        switch state {
        case .approved: return "Allowed"
        case .notDetermined: return "Not set up"
        case .denied: return "Not allowed"
        case .revoked: return "Turned off"
        case .unknown: return "Unknown"
        }
    }

    private func leave() {
        isLeaving = true
        Task {
            do {
                try await model.leaveWorkplace()
            } catch {
                actionError = "Restrictions were removed from this iPhone, but Work Mode couldn't tell your workplace. Ask your manager to disconnect this phone."
            }
            isLeaving = false
        }
    }
}

struct PrivacyView: View {
    var body: some View {
        List {
            Section {
                Text(PrivacyStatements.principle).font(.headline)
            }
            Section("Your employer CAN see") {
                ForEach(PrivacyStatements.canSee) { PrivacyRow(statement: $0, systemImage: "eye") }
            }
            Section("Your employer CANNOT see") {
                ForEach(PrivacyStatements.cannotSee) { PrivacyRow(statement: $0, systemImage: "eye.slash") }
            }
        }
        .navigationTitle("Privacy")
    }
}

private struct PrivacyRow: View {
    let statement: PrivacyStatement
    let systemImage: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(statement.label, systemImage: systemImage).font(.headline)
            Text(statement.detail).font(.subheadline).foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

struct HelpView: View {
    private let items: [(String, String)] = [
        ("When are apps blocked?", "Only during the shifts your employer schedules. Blocks start automatically, relax on breaks and lift when your shift ends — even if the Work Mode app is closed."),
        ("My schedule looks wrong", "Pull down on Home or Schedule to sync. If it is still wrong, ask your manager to check your shifts."),
        ("It says ACTION REQUIRED", "Screen Time access is off or no apps are chosen. Allow Work Mode in Settings › Screen Time, then reopen the app."),
        ("It says SYNC DELAYED", "Your phone hasn't reached Work Mode for a while. Your saved schedule still applies; connect to the internet and pull down to refresh."),
        ("Can I still make calls?", "Yes. Screen Time cannot block the Phone app or emergency calls, and other apps are blocked only if you chose them."),
        ("I have a new phone", "Leave the workplace on your old phone (Settings › Leave Workplace), or ask your manager to disconnect it, then join on the new one."),
    ]

    var body: some View {
        List(items, id: \.0) { item in
            VStack(alignment: .leading, spacing: 6) {
                Text(item.0).font(.headline)
                Text(item.1).font(.body).foregroundStyle(.secondary)
            }
            .padding(.vertical, 4)
            .accessibilityElement(children: .combine)
        }
        .navigationTitle("Help")
    }
}
