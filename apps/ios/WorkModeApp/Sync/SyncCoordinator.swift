import Foundation
import WorkModeCore

/// Why a sync was requested (for logs and for deciding whether to refresh the profile).
enum SyncReason: String, Sendable {
    case launch
    case foreground
    case pullToRefresh
    case backgroundRefresh
    case silentPush
    case setup
}

struct SyncOutcome {
    /// The state computed on-device (from fresh data when the sync succeeded, else from the cache).
    var expectedState: ExpectedState
    var engineState: RestrictionEngineState
    var policyChanged = false
    var scheduleChanged = false
    var activitiesRescheduled = false
    var restrictionAction: RestrictionAction = .leaveUnchanged
    var eventsFlushed = 0
    /// The first error that stopped the network part of the sync (nil on success).
    var error: APIError?

    var succeeded: Bool { error == nil }
}

/// Keeps the device in step with the server and enforces locally:
///
/// 1. `GET /sync` (and `GET /me` on launch) → diff `policyVersion` / `scheduleVersion` → update the cache.
/// 2. Compute the expected state with `WorkModeEngine` from the cache (works offline too).
/// 3. Re-plan DeviceActivity schedules (`ActivityPlanner` + `deviceComponents`) when the plan changed, and
///    write `plans.json` for the monitor extension.
/// 4. Reconcile the shields now through the `RestrictionProvider`.
/// 5. Queue POLICY_SYNCED / SCHEDULE_SYNCED / WORK_MODE_* / PERMISSION_NEEDS_ATTENTION events, flush the
///    outbox (`POST /events`) and check in (`POST /device/state`).
///
/// Concurrent calls coalesce into the sync already in flight.
actor SyncCoordinator {
    private let api: MobileAPI
    private let cache: StateCache
    private let outbox: EventOutbox
    private let plans: PlansStore
    private let provider: AppRestrictionProvider
    private let deviceInfo: DeviceInfoProviding
    private let planner: ActivityPlanner
    private let now: () -> Date
    private var inFlight: Task<SyncOutcome, Never>?

    init(
        api: MobileAPI,
        cache: StateCache,
        outbox: EventOutbox,
        plans: PlansStore,
        provider: AppRestrictionProvider,
        deviceInfo: DeviceInfoProviding,
        planner: ActivityPlanner = ActivityPlanner(),
        now: @escaping () -> Date = Date.init
    ) {
        self.api = api
        self.cache = cache
        self.outbox = outbox
        self.plans = plans
        self.provider = provider
        self.deviceInfo = deviceInfo
        self.planner = planner
        self.now = now
    }

    func sync(reason: SyncReason) async -> SyncOutcome {
        if let inFlight {
            return await inFlight.value
        }
        let task = Task { await self.performSync(reason: reason) }
        inFlight = task
        defer { inFlight = nil }
        return await task.value
    }

    /// Re-evaluates and enforces from the cache without the network (e.g. on foreground when offline).
    func enforceFromCache() -> SyncOutcome {
        let instant = now()
        let state = cache.load() ?? CachedState()
        return enforce(state: state, at: instant, policyChanged: false, scheduleChanged: false, error: nil)
    }

    // MARK: Sync

    private func performSync(reason: SyncReason) async -> SyncOutcome {
        let instant = now()
        WorkModeLog.sync.info("sync started (\(reason.rawValue, privacy: .public))")
        guard api.hasCredentials() else {
            return enforce(state: cache.load() ?? CachedState(), at: instant, policyChanged: false, scheduleChanged: false, error: .notSignedIn())
        }

        let bundle: SyncBundle
        do {
            bundle = try await api.sync()
        } catch {
            let apiError = error as? APIError ?? .network(error)
            WorkModeLog.sync.error("sync failed: \(apiError.code.rawValue, privacy: .public)")
            let state = (try? cache.update { $0.lastSyncErrorCode = apiError.code.rawValue }) ?? cache.load() ?? CachedState()
            var outcome = enforce(state: state, at: instant, policyChanged: false, scheduleChanged: false, error: apiError)
            if !apiError.isAuthenticationFailure {
                // Still try to deliver queued events and a check-in: /sync may fail while others succeed.
                outcome.eventsFlushed = await flushOutbox()
            }
            return outcome
        }

        if reason == .launch || reason == .setup || cache.load()?.organisation == nil {
            await refreshProfile()
        }

        var policyChanged = false
        var scheduleChanged = false
        let updated: CachedState
        do {
            updated = try cache.update { state in
                policyChanged = state.lastPolicySyncAt == nil || state.policyVersion != bundle.policyVersion
                scheduleChanged = state.lastScheduleSyncAt == nil || state.scheduleVersion != bundle.scheduleVersion
                state.policy = bundle.policy
                state.breakPolicy = bundle.breakPolicy
                state.shifts = bundle.shifts
                state.policyVersion = bundle.policyVersion
                state.scheduleVersion = bundle.scheduleVersion
                state.activeOverrides = bundle.activeOverrides
                state.activeBreakSession = bundle.activeBreakSession
                state.breakAllowance = bundle.breakAllowance
                state.lastSyncAt = instant
                state.lastSyncErrorCode = nil
                if policyChanged { state.lastPolicySyncAt = instant }
                if scheduleChanged { state.lastScheduleSyncAt = instant }
            }
        } catch {
            WorkModeLog.sync.error("cache update failed: \(String(describing: error), privacy: .public)")
            return enforce(state: cache.load() ?? CachedState(), at: instant, policyChanged: false, scheduleChanged: false,
                           error: APIError(code: .invalidResponse, message: "Work Mode could not save your schedule on this phone.", status: 0))
        }

        var events: [DeviceEvent] = []
        if policyChanged {
            events.append(DeviceEvent(type: .policySynced, occurredAt: instant, metadata: DeviceEventMetadata(policyVersion: bundle.policyVersion)))
        }
        if scheduleChanged {
            events.append(DeviceEvent(type: .scheduleSynced, occurredAt: instant, metadata: DeviceEventMetadata(scheduleVersion: bundle.scheduleVersion)))
        }
        if !events.isEmpty { _ = try? outbox.append(contentsOf: events) }

        var outcome = enforce(state: updated, at: instant, policyChanged: policyChanged, scheduleChanged: scheduleChanged, error: nil)
        outcome.eventsFlushed = await flushOutbox()
        await reportDeviceState(engineState: outcome.engineState.state, at: instant)
        WorkModeLog.sync.info("sync finished: \(outcome.expectedState.state.rawValue, privacy: .public), rescheduled=\(outcome.activitiesRescheduled)")
        return outcome
    }

    private func refreshProfile() async {
        do {
            let me = try await api.me()
            try cache.update { state in
                state.organisation = me.organisation
                state.employee = me.employee
                state.deviceId = me.deviceId
            }
        } catch {
            WorkModeLog.sync.error("profile refresh failed: \(String(describing: error), privacy: .public)")
        }
    }

    // MARK: Local enforcement

    /// Computes the expected state from `state`, re-plans activities when needed, reconciles the shields and
    /// records the applied engine state + implied events. Never touches the network.
    private func enforce(state: CachedState, at instant: Date, policyChanged: Bool, scheduleChanged: Bool, error: APIError?) -> SyncOutcome {
        let authorization = provider.authorizationStatus
        let permission = authorization.permissionState(previous: state.lastPermissionState)
        let timeZone = deviceInfo.timeZone
        let options = WorkModeEngineOptions.forPolicy(state.policy)
        let engine = WorkModeEngine(options: options, timezone: timeZone.identifier)
        let expected = engine.computeExpectedState(
            now: instant,
            shifts: state.shifts,
            breakSessions: state.breakSessions,
            overrides: state.activeOverrides,
            permissionState: permission
        )

        var outcome = SyncOutcome(expectedState: expected, engineState: .unknown, policyChanged: policyChanged, scheduleChanged: scheduleChanged, error: error)
        guard state.isJoined, error?.isAuthenticationFailure != true else {
            outcome.engineState = RestrictionEngineState(state: expected.state, source: .appEngine, updatedAt: instant)
            return outcome
        }

        // 1. DeviceActivity schedules (only when they differ from what was last scheduled successfully).
        if permission.isApproved {
            let entries = planner.plan(now: instant, shifts: state.shifts, activeBreak: state.activeBreakSession,
                                       policy: state.policy, breakPolicy: state.breakPolicy, timeZone: timeZone, options: options)
            let file = PlansFile(
                generatedAt: instant,
                organisationName: state.organisation?.name,
                entries: Dictionary(entries.map { ($0.activity.name, $0) }, uniquingKeysWith: { first, _ in first })
            )
            let existing = plans.read()
            if existing?.entries != file.entries || existing?.organisationName != file.organisationName {
                do {
                    provider.cancelAllActivities()
                    try provider.scheduleActivities(file.activities)
                    try plans.write(file)
                    outcome.activitiesRescheduled = true
                } catch {
                    WorkModeLog.sync.error("scheduling activities failed: \(String(describing: error), privacy: .public)")
                }
            }
        }

        // 2. Shields right now.
        var applied = expected.state
        if permission.isApproved {
            if expected.restrictionsShouldBeActive && !provider.hasSelection() {
                // Shields should be up but there is nothing to shield with: the employee must choose apps.
                applied = .permissionError
            } else {
                do {
                    outcome.restrictionAction = try RestrictionReconciler.reconcile(expected, policy: state.policy, breakPolicy: state.breakPolicy, provider: provider)
                } catch RestrictionProviderError.notAuthorized {
                    applied = .permissionError
                } catch {
                    WorkModeLog.sync.error("applying restrictions failed: \(String(describing: error), privacy: .public)")
                    applied = .unknown
                }
            }
        }
        let engineState = RestrictionEngineState(state: applied, source: .appEngine, updatedAt: instant)
        outcome.engineState = engineState

        // 3. Implied events + persisted engine/permission state.
        var events = WorkModeEvents.transitionEvents(from: state.engineState?.state, to: ExpectedState(
            state: applied,
            effectiveRestriction: expected.effectiveRestriction,
            restrictionsShouldBeActive: expected.restrictionsShouldBeActive,
            computedAt: instant,
            permissionState: permission,
            activeShift: expected.activeShift
        ), at: instant)
        if state.lastPermissionState == .approved && !permission.isApproved {
            events.append(DeviceEvent(type: .permissionNeedsAttention, occurredAt: instant,
                                      metadata: DeviceEventMetadata(reason: "PERMISSION_\(permission.rawValue)", permissionState: permission)))
        }
        do {
            try cache.update { cached in
                cached.engineState = engineState
                cached.lastPermissionState = permission
            }
            if !events.isEmpty { try outbox.append(contentsOf: events) }
        } catch {
            WorkModeLog.sync.error("recording engine state failed: \(String(describing: error), privacy: .public)")
        }
        return outcome
    }

    // MARK: Upload

    private func flushOutbox() async -> Int {
        do {
            // A batch the server refuses outright (400 VALIDATION_ERROR …) is dropped, never retried forever.
            return try await outbox.flush(isPermanentFailure: APIError.isPermanentRejection) { [api] batch in
                _ = try await api.postEvents(batch)
            }
        } catch {
            WorkModeLog.sync.error("event flush failed: \(String(describing: error), privacy: .public)")
            return 0
        }
    }

    private func reportDeviceState(engineState: WorkModeState, at instant: Date) async {
        let state = cache.load() ?? CachedState()
        let report = DeviceStateReportBuilder.make(provider: provider, cache: state, engineState: engineState, deviceInfo: deviceInfo, now: instant)
        do {
            let response = try await api.reportDeviceState(report)
            try cache.update { cached in
                cached.lastDeviceStateReportAt = instant
                cached.clockSkewSeconds = response.clockSkewSeconds
            }
        } catch {
            WorkModeLog.sync.error("device state report failed: \(String(describing: error), privacy: .public)")
        }
    }
}
