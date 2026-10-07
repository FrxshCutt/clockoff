// DEBUG ONLY — see DiagnosticsSnapshot.swift. Opened from Settings by tapping "App version" five times.
#if DEBUG
import SwiftUI
import UIKit
import ClockOffCore

@MainActor
final class DiagnosticsViewModel: ObservableObject {
    /// How often the screen re-reads everything while it is visible.
    static let refreshInterval: TimeInterval = 2

    @Published private(set) var snapshot: DiagnosticsSnapshot
    @Published private(set) var lastAction: String?
    @Published private(set) var isSyncing = false

    private let source: DiagnosticsDataSource
    private let copyToPasteboard: (String) -> Void

    init(source: DiagnosticsDataSource, copyToPasteboard: @escaping (String) -> Void = { UIPasteboard.general.string = $0 }) {
        self.source = source
        self.copyToPasteboard = copyToPasteboard
        snapshot = source.snapshot()
    }

    var sections: [DiagnosticsSection] { DiagnosticsReport.sections(snapshot) }

    func refresh() {
        snapshot = source.snapshot()
    }

    /// Refreshes every `refreshInterval` until the task is cancelled (the view's `.task` ends on disappear).
    func runLiveUpdates() async {
        while !Task.isCancelled {
            refresh()
            try? await Task.sleep(nanoseconds: UInt64(DiagnosticsViewModel.refreshInterval * 1_000_000_000))
        }
    }

    func forceSync() async {
        guard !isSyncing else { return }
        isSyncing = true
        lastAction = "Syncing…"
        lastAction = await source.forceSync()
        isSyncing = false
        refresh()
    }

    func replanSchedules() {
        lastAction = source.replanSchedules()
        refresh()
    }

    func clearAllShields() {
        lastAction = source.clearAllShields()
        refresh()
    }

    func copyReport() {
        refresh()
        copyToPasteboard(DiagnosticsReport.text(snapshot))
        lastAction = "Diagnostics copied to the clipboard (counts and states only)."
    }
}

/// Live view of everything that decides whether Work Mode is enforced on this iPhone, so a tester can tell
/// "Work Mode failed" from "Work Mode worked but the UI is wrong". Debug builds only.
struct DiagnosticsView: View {
    @StateObject private var viewModel: DiagnosticsViewModel
    @State private var confirmingClear = false

    init(source: DiagnosticsDataSource) {
        _viewModel = StateObject(wrappedValue: DiagnosticsViewModel(source: source))
    }

    var body: some View {
        List {
            Section {
                Button("Force sync") { Task { await viewModel.forceSync() } }
                    .frame(minHeight: 44)
                    .disabled(viewModel.isSyncing)
                Button("Re-plan schedules") { viewModel.replanSchedules() }
                    .frame(minHeight: 44)
                Button("Clear all shields", role: .destructive) { confirmingClear = true }
                    .frame(minHeight: 44)
                Button("Copy diagnostics to clipboard") { viewModel.copyReport() }
                    .frame(minHeight: 44)
                if let message = viewModel.lastAction {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            } header: {
                Text("Actions")
            } footer: {
                Text("Debug builds only. Updates every \(Int(DiagnosticsViewModel.refreshInterval)) seconds. \(DiagnosticsReport.privacyNote)")
            }

            ForEach(viewModel.sections) { section in
                Section(section.title) {
                    ForEach(Array(section.rows.enumerated()), id: \.offset) { _, row in
                        DiagnosticsRowView(row: row)
                    }
                }
            }
        }
        .navigationTitle("Diagnostics")
        .navigationBarTitleDisplayMode(.inline)
        .task { await viewModel.runLiveUpdates() }
        .onReceive(NotificationCenter.default.publisher(for: .clockOffAuthorizationStatusDidChange).receive(on: RunLoop.main)) { _ in
            viewModel.refresh()
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            viewModel.refresh()
        }
        .confirmationDialog("Clear all shields?", isPresented: $confirmingClear, titleVisibility: .visible) {
            Button("Clear all shields", role: .destructive) { viewModel.clearAllShields() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Removes every ClockOff shield on this iPhone now. Work Mode puts them back at its next check if a shift is in progress.")
        }
    }
}

private struct DiagnosticsRowView: View {
    let row: DiagnosticsRow

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(row.label)
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if row.attention {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                        .accessibilityLabel("Needs attention")
                }
                Text(row.value)
                    .font(.callout)
                    .foregroundStyle(row.attention ? Color.orange : Color.primary)
                    .textSelection(.enabled)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}
#endif
