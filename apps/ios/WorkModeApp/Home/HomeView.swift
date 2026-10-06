import SwiftUI
import WorkModeCore

struct HomeView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    StateCardView(card: model.homeCard)
                    if let organisation = model.cachedState.organisation {
                        Text(organisation.name)
                            .font(.headline)
                            .foregroundStyle(.secondary)
                    }
                    SyncStatusLine(cache: model.cachedState, isSyncing: model.isSyncing, error: model.lastSyncError)
                }
                .padding(20)
            }
            .refreshable { await model.refresh(reason: .pullToRefresh) }
            .navigationTitle("Work Mode")
        }
        .task {
            // Re-evaluate the saved schedule while Home is on screen (cancelled when it disappears).
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30 * 1_000_000_000)
                guard !Task.isCancelled else { break }
                await model.tick()
            }
        }
    }
}

struct StateCardView: View {
    let card: HomeCard

    private var tint: Color {
        switch card.kind {
        case .workModeActive: return .indigo
        case .breakActive: return .teal
        case .startingSoon: return .orange
        case .offShift: return .gray
        case .pausedByManager: return .purple
        case .actionRequired: return .red
        case .syncDelayed: return .brown
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Image(systemName: card.systemImage)
                .font(.system(size: 48, weight: .semibold))
                .accessibilityHidden(true)
            Text(card.title)
                .font(.largeTitle.weight(.heavy))
                .fixedSize(horizontal: false, vertical: true)
                .minimumScaleFactor(0.7)
            Text(card.message)
                .font(.title3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(.white)
        .padding(24)
        .frame(maxWidth: .infinity, minHeight: 260, alignment: .bottomLeading)
        .background(tint.gradient, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(card.title.capitalized). \(card.message)")
        .accessibilityAddTraits(.isHeader)
    }
}

struct SyncStatusLine: View {
    let cache: CachedState
    let isSyncing: Bool
    let error: APIError?

    var body: some View {
        let time = TimeFormatting(timeZone: .current, now: Date())
        VStack(alignment: .leading, spacing: 4) {
            if isSyncing {
                Label("Syncing…", systemImage: "arrow.triangle.2.circlepath")
            } else if let last = cache.lastSyncAt {
                Label("Last synced \(time.relative(last))", systemImage: "checkmark.icloud")
            } else {
                Label("Not synced yet", systemImage: "icloud.slash")
            }
            if let error, !isSyncing {
                Text(error.isTransient ? "Couldn't reach Work Mode. Pull down to try again." : error.message)
                    .foregroundStyle(.secondary)
            }
        }
        .font(.callout)
        .accessibilityElement(children: .combine)
    }
}
