// DEBUG ONLY — see DiagnosticsSnapshot.swift.
#if DEBUG
import Foundation
import ClockOffCore

/// Where the Diagnostics screen gets its data and how its buttons act. `LiveDiagnosticsDataSource` reads the
/// app's real objects; the formatting (`DiagnosticsReport`) is pure and unit-tested.
@MainActor
protocol DiagnosticsDataSource: AnyObject {
    /// Everything the screen shows, read now (cheap enough to call every couple of seconds).
    func snapshot() -> DiagnosticsSnapshot
    /// "Force sync": a full `SyncCoordinator` sync, then a reconcile. Returns the message to show.
    func forceSync() async -> String
    /// "Re-plan schedules": rewrites plans.json and re-registers every DeviceActivity. Returns the message.
    func replanSchedules() -> String
    /// "Clear all shields": empties both ManagedSettings stores. Returns the message.
    func clearAllShields() -> String
}

/// The Screen Time state a `RestrictionProvider` can expose for diagnostics: the DeviceActivity schedules
/// registered with iOS and the contents of the two ManagedSettings stores, as counts.
/// `AppleScreenTimeRestrictionProvider` reads the real frameworks; `MockRestrictionProvider` its simulation.
protocol ScreenTimeDiagnosticsInspecting: AnyObject {
    var diagnosticsProviderKind: DiagnosticsSnapshot.ProviderKind { get }
    func registeredActivitiesForDiagnostics() -> [DiagnosticsSnapshot.RegisteredActivity]
    func shieldStoresForDiagnostics() -> [DiagnosticsSnapshot.ShieldStore]
}

@MainActor
final class LiveDiagnosticsDataSource: DiagnosticsDataSource {
    private let model: AppModel
    private let now: () -> Date
    private let fileManager: FileManager

    init(model: AppModel, now: @escaping () -> Date = Date.init, fileManager: FileManager = .default) {
        self.model = model
        self.now = now
        self.fileManager = fileManager
    }

    func snapshot() -> DiagnosticsSnapshot {
        let container = model.container
        let instant = now()
        let state = container.cache.load() ?? CachedState()
        let provider = container.restrictionProvider
        let inspector = provider as? ScreenTimeDiagnosticsInspecting
        let authorization = provider.authorizationStatus
        let plansFile = container.plans.read()
        let flags = container.sharedFlags

        let registered = inspector?.registeredActivitiesForDiagnostics().sorted { a, b in
            let aStart = a.start ?? .distantPast
            let bStart = b.start ?? .distantPast
            return aStart == bStart ? a.name < b.name : aStart < bStart
        }
        let planned = plansFile?.activities.map { activity in
            DiagnosticsSnapshot.PlannedActivity(name: activity.name, kind: activity.kind, start: activity.intervalStart,
                                                end: activity.plannedEnd ?? activity.intervalEnd)
        }

        return DiagnosticsSnapshot(
            capturedAt: instant,
            timeZone: container.deviceInfo.timeZone,
            appVersion: container.configuration.displayVersion,
            authorization: DiagnosticsSnapshot.Authorization(
                familyControls: authorization,
                reportedPermission: authorization.permissionState(previous: state.lastPermissionState),
                provider: inspector?.diagnosticsProviderKind ?? .unavailable
            ),
            selection: DiagnosticsSnapshot.Selection(
                work: provider.hasSelection() ? provider.selectionCounts() : nil,
                breakKept: container.selectionStatus.hasSelection(.breakKept) ? container.selectionStatus.counts(.breakKept) : nil,
                breakKeptRequired: state.policy.map {
                    RestrictionPlan.make(shiftId: "", policy: $0, breakPolicy: state.breakPolicy).requiresBreakSubsetSelection
                } ?? false
            ),
            engine: DiagnosticsSnapshot.Engine(
                isJoined: state.isJoined,
                screenState: model.controller.state,
                expected: model.controller.expectedState,
                providerState: provider.currentEngineState(),
                lastReconcile: model.controller.lastOutcome.map(DiagnosticsSnapshot.Reconcile.init(outcome:)),
                lastReconcileAt: state.lastReconcileAt
            ),
            schedules: DiagnosticsSnapshot.Schedules(
                registered: registered,
                planned: planned,
                needsReschedule: container.syncMetadata.activitiesNeedReschedule
            ),
            shieldStores: inspector?.shieldStoresForDiagnostics(),
            appGroup: DiagnosticsSnapshot.AppGroupContents(
                isSharedContainer: container.fileStore.isSharedContainer,
                plansFileModifiedAt: modificationDate(of: PlansStore.defaultFileName),
                plansGeneratedAt: plansFile?.generatedAt,
                stateFileModifiedAt: modificationDate(of: StateCache.defaultFileName),
                recordedEngineState: state.engineState,
                lastMonitorCallback: flags?.lastMonitorCallback,
                outboxCount: state.outbox.count,
                queuedBreakCount: state.queuedBreaks.count,
                selectionIncomplete: flags?.selectionIncomplete ?? false
            ),
            sync: DiagnosticsSnapshot.Sync(
                lastSyncAt: state.lastSyncAt,
                lastServerContactAt: container.syncMetadata.lastServerContactAt,
                lastSyncErrorCode: state.lastSyncErrorCode,
                policyVersion: state.policyVersion,
                scheduleVersion: state.scheduleVersion,
                clockSkewSeconds: state.clockSkewSeconds,
                lastCheckInAt: state.lastDeviceStateReportAt,
                apiHost: Self.hostText(container.configuration.apiBaseURL)
            )
        )
    }

    func forceSync() async -> String {
        await model.refresh(reason: .pullToRefresh)
        let time = DiagnosticsTimeFormat(timeZone: model.container.deviceInfo.timeZone, now: now())
        if let error = model.lastSyncError {
            return "Sync failed at \(time.absolute(now())): \(error.code.rawValue) — \(error.message)"
        }
        return "Sync finished at \(time.absolute(now()))."
    }

    func replanSchedules() -> String {
        do {
            guard let file = try model.controller.replanActivities() else {
                return "Nothing re-planned: the phone is not joined or Screen Time access is not approved."
            }
            model.container.syncMetadata.activitiesNeedReschedule = false
            let entries = file.entries.count == 1 ? "1 entry" : "\(file.entries.count) entries"
            return "Re-planned: plans.json rewritten with \(entries) and DeviceActivity schedules registered again."
        } catch {
            model.container.syncMetadata.activitiesNeedReschedule = true
            return "Re-plan failed: \(error.localizedDescription)"
        }
    }

    func clearAllShields() -> String {
        do {
            try model.container.restrictionProvider.clearRestrictions()
            return "Shields cleared. Work Mode applies them again at its next check (app foreground, sync or a schedule boundary) if a shift is in progress."
        } catch {
            return "Clearing shields failed: \(error.localizedDescription)"
        }
    }

    // MARK: Private

    private func modificationDate(of fileName: String) -> Date? {
        let path = model.container.fileStore.url(for: fileName).path
        return (try? fileManager.attributesOfItem(atPath: path))?[.modificationDate] as? Date
    }

    private static func hostText(_ url: URL) -> String {
        guard let host = url.host else { return url.absoluteString }
        return url.port.map { "\(host):\($0)" } ?? host
    }
}
#endif
