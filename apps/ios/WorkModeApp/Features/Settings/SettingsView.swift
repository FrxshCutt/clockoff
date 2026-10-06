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
                    if let breakPolicy = cache.breakPolicy { LabeledContent("Break rules", value: breakPolicy.name) }
                }

                Section("Connection") {
                    LabeledContent("Status", value: connectionText(cache))
                    LabeledContent("Network", value: model.isOnline ? "Online" : "Offline")
                    LabeledContent("Last sync", value: cache.lastSyncAt.map(time.relative) ?? "Never")
                    LabeledContent("Server last reached", value: model.container.syncMetadata.lastServerContactAt.map(time.relative) ?? "Never")
                    if let error = model.lastSyncError {
                        Text(error.isTransient ? "Couldn't reach Work Mode on the last sync." : error.message)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    Button("Sync now") { Task { await model.refresh(reason: .pullToRefresh) } }
                        .frame(minHeight: 44)
                        .disabled(model.isSyncing)
                }

                Section("Permissions") {
                    LabeledContent("Screen Time access", value: permissionText(model.permissionState))
                    LabeledContent("Apps to block", value: selectionText)
                    if model.policyNeedsBreakKeptSelection {
                        LabeledContent("Kept blocked on breaks", value: breakKeptText)
                    }
                    if model.setupNeedsRepair {
                        Button("Repair setup") { model.openSetupRepair() }
                            .frame(minHeight: 44)
                    } else if model.policyNeedsBreakKeptSelection, !model.hasBreakKeptSelection {
                        Button("Choose apps that stay blocked on breaks") { model.chooseBreakKeptApps() }
                            .frame(minHeight: 44)
                    }
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
                    NavigationLink("Help") { HelpView(helpURL: helpURL) }
                        .frame(minHeight: 44)
                }

                Section("Device") {
                    LabeledContent("App version", value: model.container.configuration.displayVersion)
                    LabeledContent("iOS version", value: model.container.deviceInfo.osVersion)
                    LabeledContent("Device", value: model.container.deviceInfo.model)
                    LabeledContent("Timezone", value: model.container.deviceInfo.timeZone.identifier)
                    LabeledContent("Last check-in", value: cache.lastDeviceStateReportAt.map(time.dateTime) ?? "Never")
                    LabeledContent("Policy synced", value: cache.lastPolicySyncAt.map(time.dateTime) ?? "Never")
                    LabeledContent("Schedule synced", value: cache.lastScheduleSyncAt.map(time.dateTime) ?? "Never")
                    if let skew = cache.clockSkewSeconds, abs(skew) > BreakRules.clockSkewAttentionThresholdSeconds {
                        Label(clockSkewText(skew), systemImage: "clock.badge.exclamationmark")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
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
                    Text("Leaving lifts every Work Mode restriction on this iPhone, removes your saved schedule and app choices, and disconnects it from your workplace.")
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

    private var helpURL: URL {
        model.container.configuration.apiBaseURL.appendingPathComponent("help")
    }

    private var selectionText: String {
        guard model.hasSelection else { return "Not chosen" }
        let counts = model.selectionCounts
        return "\(counts.categories) categories, \(counts.applications) apps, \(counts.webDomains) sites"
    }

    private var breakKeptText: String {
        guard model.hasBreakKeptSelection else { return "Not chosen" }
        let counts = model.breakKeptSelectionCounts
        return "\(counts.categories) categories, \(counts.applications) apps, \(counts.webDomains) sites"
    }

    private func connectionText(_ cache: CachedState) -> String {
        if !cache.isJoined { return "Not connected" }
        if SyncStaleness.isStale(lastSyncAt: cache.lastSyncAt, now: Date()) { return "Connected — sync delayed" }
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

    private func clockSkewText(_ skew: Int) -> String {
        let minutes = max(1, abs(skew) / 60)
        let direction = skew > 0 ? "ahead of" : "behind"
        return "Your clock is about \(minutes) min \(direction) server time. Turn on Settings › General › Date & Time › Set Automatically so shifts start on time."
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
    let helpURL: URL

    private let items: [(String, String)] = [
        ("When are apps blocked?", "Only during the shifts your employer schedules. Blocks start automatically, relax on breaks and lift when your shift ends — even if the Work Mode app is closed."),
        ("How do I take a break?", "On Home, tap Start Break while your shift is on. Your workplace's break rules decide how many breaks you can take, how long they last and when they can start; the card tells you when the next one is available."),
        ("My schedule looks wrong", "Pull down on Home or Schedule to sync. If it is still wrong, ask your manager to check your shifts."),
        ("It says ACTION REQUIRED", "Screen Time access is off or no apps are chosen. Tap Open Setup, or allow Work Mode in Settings › Screen Time, then reopen the app."),
        ("It says SYNC DELAYED", "Your phone hasn't reached Work Mode for a while. Your saved schedule still applies; connect to the internet and pull down to refresh."),
        ("I was offline during a break", "Breaks started or ended without a connection are kept on this phone and sent to your workplace when you reconnect, with the time you tapped."),
        ("Can I still make calls?", "Yes. Screen Time cannot block the Phone app or emergency calls, and other apps are blocked only if you chose them."),
        ("I have a new phone", "Leave the workplace on your old phone (Settings › Leave Workplace), or ask your manager to disconnect it, then join on the new one."),
    ]

    var body: some View {
        List {
            Section {
                ForEach(items, id: \.0) { item in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(item.0).font(.headline)
                        Text(item.1).font(.body).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                    .accessibilityElement(children: .combine)
                }
            }
            Section {
                Link(destination: helpURL) {
                    Label("More help online", systemImage: "safari")
                        .frame(minHeight: 44)
                }
            }
        }
        .navigationTitle("Help")
    }
}
