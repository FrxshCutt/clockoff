// DEBUG ONLY — the Screen Time half of the Diagnostics screen (see Features/Diagnostics). Not compiled into
// Release builds.
#if DEBUG
import DeviceActivity
import Foundation
import ManagedSettings
import ClockOffCore
import ClockOffScreenTime

/// Reads what iOS really holds: the DeviceActivity schedules registered for this app and the two named
/// ManagedSettings stores. Only counts of the opaque tokens are taken; the tokens themselves are never kept.
extension AppleScreenTimeRestrictionProvider: ScreenTimeDiagnosticsInspecting {
    private static let diagnosticsWorkStore = ManagedSettingsStore(named: .work)
    private static let diagnosticsBreakStore = ManagedSettingsStore(named: .breakRelaxed)

    var diagnosticsProviderKind: DiagnosticsSnapshot.ProviderKind { .screenTime }

    /// `DeviceActivityCenter().activities` (every activity this app monitors, ours or not) with `schedule(for:)`.
    func registeredActivitiesForDiagnostics() -> [DiagnosticsSnapshot.RegisteredActivity] {
        let center = DeviceActivityCenter()
        return center.activities.map { name in
            let schedule = center.schedule(for: name)
            let interval = schedule?.nextInterval
            return DiagnosticsSnapshot.RegisteredActivity(
                name: name.rawValue,
                start: schedule?.intervalStart.resolvedDate() ?? interval?.start,
                end: schedule?.intervalEnd.resolvedDate() ?? interval?.end,
                repeats: schedule?.repeats ?? false,
                warningMinutes: schedule?.warningTime.map { ($0.hour ?? 0) * 60 + ($0.minute ?? 0) }
            )
        }
    }

    func shieldStoresForDiagnostics() -> [DiagnosticsSnapshot.ShieldStore] {
        [Self.describe(Self.diagnosticsWorkStore, role: .work), Self.describe(Self.diagnosticsBreakStore, role: .breakRelaxed)]
    }

    private static func describe(_ store: ManagedSettingsStore, role: ShieldStoreRole) -> DiagnosticsSnapshot.ShieldStore {
        DiagnosticsSnapshot.ShieldStore(
            role: role,
            applications: store.shield.applications?.count,
            applicationCategories: store.shield.applicationCategories.map(categoryPolicy),
            webDomains: store.shield.webDomains?.count,
            webDomainCategories: store.shield.webDomainCategories.map(categoryPolicy)
        )
    }

    private static func categoryPolicy<Activity>(_ policy: ShieldSettings.ActivityCategoryPolicy<Activity>) -> DiagnosticsSnapshot.CategoryPolicy {
        switch policy {
        case .none:
            return .none
        case .specific(let categories, let except):
            return .specific(categories: categories.count, exceptions: except.count)
        case .all(let except):
            return .all(exceptions: except.count)
        @unknown default:
            return .none
        }
    }
}

#if DEBUG_MOCK_RESTRICTIONS
/// The simulation's equivalent: its registered activities and what its applied restriction would put in the
/// two stores (counts from the simulated selections, empty sets as nil — like the real adapter).
extension MockRestrictionProvider: ScreenTimeDiagnosticsInspecting {
    var diagnosticsProviderKind: DiagnosticsSnapshot.ProviderKind { .simulated }

    func registeredActivitiesForDiagnostics() -> [DiagnosticsSnapshot.RegisteredActivity] {
        scheduledActivities.map { plan in
            DiagnosticsSnapshot.RegisteredActivity(name: plan.name, start: plan.intervalStart, end: plan.intervalEnd, repeats: false,
                                                   warningMinutes: plan.warningMinutes > 0 ? plan.warningMinutes : nil)
        }
    }

    func shieldStoresForDiagnostics() -> [DiagnosticsSnapshot.ShieldStore] {
        var work = DiagnosticsSnapshot.ShieldStore.empty(.work)
        var breakStore = DiagnosticsSnapshot.ShieldStore.empty(.breakRelaxed)
        switch activeRestriction {
        case .none:
            break
        case .work:
            work = Self.simulatedStore(.work, counts: selectionCounts())
        case .onBreak(_, let behaviour):
            switch behaviour {
            case .relaxAll:
                break
            case .relaxCategories:
                // Like `ShieldApplier.applyBreak`: the kept subset on the break store, or (no such selection) the
                // KEEP_RESTRICTIONS fallback with the full work set still up.
                if let kept = breakKeptSelectionCounts {
                    breakStore = Self.simulatedStore(.breakRelaxed, counts: kept)
                } else {
                    work = Self.simulatedStore(.work, counts: selectionCounts())
                }
            case .keepRestrictions:
                work = Self.simulatedStore(.work, counts: selectionCounts())
            }
        }
        return [work, breakStore]
    }

    private static func simulatedStore(_ role: ShieldStoreRole, counts: SelectionCounts) -> DiagnosticsSnapshot.ShieldStore {
        let categories: DiagnosticsSnapshot.CategoryPolicy? = counts.categories > 0 ? .specific(categories: counts.categories, exceptions: 0) : nil
        return DiagnosticsSnapshot.ShieldStore(
            role: role,
            applications: counts.applications > 0 ? counts.applications : nil,
            applicationCategories: categories,
            webDomains: counts.webDomains > 0 ? counts.webDomains : nil,
            webDomainCategories: categories
        )
    }
}
#endif
#endif
