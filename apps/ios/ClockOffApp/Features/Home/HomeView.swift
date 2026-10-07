import SwiftUI
import WorkModeCore

struct HomeView: View {
    @EnvironmentObject private var model: AppModel
    @State private var breakError: String?
    @State private var isBreakBusy = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let banner = model.staleBanner {
                        StaleSyncBanner(text: banner)
                    }
                    let card = model.homeCard
                    TimelineView(.periodic(from: .now, by: card.countdownTo == nil ? 30 : 1)) { context in
                        StateCardView(card: card, now: context.date)
                    }
                    if let prompt = model.repairPrompt {
                        Button {
                            model.repairEnforcement()
                        } label: {
                            Label(prompt.message, systemImage: "wrench.and.screwdriver.fill")
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        }
                        .buttonStyle(.bordered)
                        .tint(.orange)
                    }
                    if model.needsBreakSelection {
                        Button {
                            model.chooseBreakKeptApps()
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Label("Selection incomplete", systemImage: "exclamationmark.triangle.fill").font(.headline)
                                Text("Choose the apps that stay blocked during breaks. Until then every app stays blocked on a break.")
                                    .font(.callout)
                                    .multilineTextAlignment(.leading)
                            }
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        }
                        .buttonStyle(.bordered)
                        .tint(.orange)
                    }
                    if let action = card.action, let title = card.actionTitle {
                        PrimaryButton(title: title, isLoading: isBreakBusy && (action == .startBreak || action == .endBreak)) {
                            perform(action)
                        }
                    } else if let note = card.note {
                        Label(note, systemImage: "info.circle")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .accessibilityElement(children: .combine)
                    }
                    if let organisation = model.cachedState.organisation {
                        Text(organisation.name)
                            .font(.headline)
                            .foregroundStyle(.secondary)
                    }
                    SyncStatusLine(cache: model.cachedState, isSyncing: model.isSyncing, isOnline: model.isOnline, error: model.lastSyncError)
                }
                .padding(20)
            }
            .refreshable { await model.refresh(reason: .pullToRefresh) }
            .navigationTitle("ClockOff")
            .alert("Break", isPresented: Binding(get: { breakError != nil }, set: { if !$0 { breakError = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(breakError ?? "")
            }
        }
    }

    private func perform(_ action: HomeCardModel.Action) {
        switch action {
        case .startBreak:
            Task {
                isBreakBusy = true
                defer { isBreakBusy = false }
                do {
                    try await model.startBreak()
                } catch {
                    breakError = BreakErrorMessages.message(for: error)
                }
            }
        case .endBreak:
            Task {
                isBreakBusy = true
                defer { isBreakBusy = false }
                do {
                    try await model.endBreakEarly()
                } catch {
                    breakError = BreakErrorMessages.message(for: error)
                }
            }
        case .openSetup:
            model.openSetupRepair()
        case .repair:
            model.repairEnforcement()
        }
    }
}

struct StateCardView: View {
    let card: HomeCardModel
    let now: Date

    private var tint: Color {
        switch card.kind {
        case .working: return .indigo
        case .onBreak: return .teal
        case .startingSoon: return .orange
        case .offShift: return .gray
        case .pausedByManager: return .purple
        case .actionRequired: return .red
        case .syncDelayed: return .brown
        case .unknown: return .gray
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Image(systemName: card.systemImage)
                .font(.system(size: 44, weight: .semibold))
                .accessibilityHidden(true)
            Text(card.title)
                .font(.largeTitle.weight(.heavy))
                .fixedSize(horizontal: false, vertical: true)
                .minimumScaleFactor(0.7)
            if let target = card.countdownTo, let label = card.countdownLabel {
                VStack(alignment: .leading, spacing: 2) {
                    Text(label).font(.callout)
                    Text(HomeCardModel.countdown(to: target, from: now))
                        .font(.system(size: 40, weight: .bold, design: .rounded).monospacedDigit())
                }
                .accessibilityElement(children: .combine)
            }
            Text(card.headline)
                .font(.title3.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            ForEach(card.details, id: \.self) { line in
                Text(line)
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .foregroundStyle(.white)
        .padding(24)
        .frame(maxWidth: .infinity, minHeight: 260, alignment: .bottomLeading)
        .background(tint.gradient, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(card.title.capitalized). \(card.headline) \(card.details.joined(separator: " "))")
        .accessibilityAddTraits(.isHeader)
    }
}

struct StaleSyncBanner: View {
    let text: String

    var body: some View {
        Label(text, systemImage: "wifi.exclamationmark")
            .font(.footnote.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
            .padding(.horizontal, 12)
            .background(Color.orange.opacity(0.18), in: RoundedRectangle(cornerRadius: 10))
            .accessibilityElement(children: .combine)
    }
}

struct SyncStatusLine: View {
    let cache: CachedState
    let isSyncing: Bool
    var isOnline = true
    let error: APIError?

    var body: some View {
        let time = TimeFormatting(timeZone: .current, now: Date())
        VStack(alignment: .leading, spacing: 4) {
            if isSyncing {
                Label("Syncing…", systemImage: "arrow.triangle.2.circlepath")
            } else if let last = cache.lastSyncAt {
                Label("Last synced \(time.relative(last))", systemImage: isOnline ? "checkmark.icloud" : "icloud.slash")
            } else {
                Label("Not synced yet", systemImage: "icloud.slash")
            }
            if !isOnline, !isSyncing {
                Text("Offline — your saved schedule still applies.")
                    .foregroundStyle(.secondary)
            } else if let error, !isSyncing {
                Text(error.isTransient ? "Couldn't reach ClockOff. Pull down to try again." : error.message)
                    .foregroundStyle(.secondary)
            }
        }
        .font(.callout)
        .accessibilityElement(children: .combine)
    }
}
