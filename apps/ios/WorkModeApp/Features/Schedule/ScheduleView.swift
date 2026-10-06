import SwiftUI
import WorkModeCore

/// Today + the next 14 days from the cache (works offline), grouped by day in the phone's timezone. Informational
/// only: shifts are enforced by DeviceActivity and the controller, never from here.
struct ScheduleView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        let sections = ScheduleViewModel.sections(shifts: model.cachedState.shifts, now: Date(), timeZone: .current)
        NavigationStack {
            List {
                ForEach(sections) { section in
                    Section(section.title) {
                        if section.shifts.isEmpty {
                            Text("No shifts").foregroundStyle(.secondary)
                        }
                        ForEach(section.shifts) { ShiftRow(row: $0) }
                    }
                }
                if sections.allSatisfy({ $0.shifts.isEmpty }) {
                    Section {
                        Text("No shifts in the next \(ScheduleViewModel.windowDays) days. Pull down to sync.")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .refreshable { await model.refresh(reason: .pullToRefresh) }
            .navigationTitle("Schedule")
        }
    }
}

struct ShiftRow: View {
    let row: ScheduleShiftRow

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(row.timeRange).font(.title3.monospacedDigit())
                if let suffix = row.overnightSuffix {
                    Text("(\(suffix))")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("ends the next day")
                }
                Spacer()
                statusLabel
            }
            HStack(spacing: 8) {
                Text(row.duration)
                if let location = row.location {
                    Text("·")
                    Text(location)
                }
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
            ForEach(row.breaks, id: \.self) { item in
                Label("Break \(item)", systemImage: "cup.and.saucer")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let note = row.timezoneNote {
                Text(note)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var statusLabel: some View {
        switch row.status {
        case .inProgress:
            Text("In progress").font(.caption.weight(.semibold)).foregroundStyle(.indigo)
        case .ended:
            Text("Ended").font(.caption).foregroundStyle(.secondary)
        case .upcoming:
            EmptyView()
        }
    }
}
