import SwiftUI
import WorkModeCore

/// Today + upcoming shifts from the cache (works offline). Times are shown in the phone's timezone.
struct ScheduleView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        let now = Date()
        let time = TimeFormatting(timeZone: .current, now: now)
        let shifts = model.cachedState.shifts
            .filter { $0.isEffective && $0.endsAt > now }
            .sorted { $0.startsAt < $1.startsAt }
        let today = shifts.filter { time.isSameDay($0.startsAt, now) || $0.startsAt <= now }
        let upcoming = shifts.filter { !(time.isSameDay($0.startsAt, now) || $0.startsAt <= now) }

        NavigationStack {
            List {
                Section("Today") {
                    if today.isEmpty {
                        Text("No shifts today").foregroundStyle(.secondary)
                    }
                    ForEach(today) { ShiftRow(shift: $0, time: time) }
                }
                Section("Upcoming") {
                    if upcoming.isEmpty {
                        Text("No upcoming shifts").foregroundStyle(.secondary)
                    }
                    ForEach(upcoming) { ShiftRow(shift: $0, time: time) }
                }
            }
            .refreshable { await model.refresh(reason: .pullToRefresh) }
            .navigationTitle("Schedule")
        }
    }
}

struct ShiftRow: View {
    let shift: Shift
    let time: TimeFormatting

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(time.day(shift.startsAt)).font(.headline)
            Text(time.range(shift.startsAt, shift.endsAt)).font(.title3.monospacedDigit())
            HStack(spacing: 8) {
                Text(TimeFormatting.duration(shift.endsAt.timeIntervalSince(shift.startsAt)))
                if let location = shift.location?.name {
                    Text("·")
                    Text(location)
                }
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
            if shift.timezone != time.timeZone.identifier {
                Text("Scheduled in \(shift.timezone); shown in your phone's time.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }
}
