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
    /// The network came back (NWPathMonitor): flush the outbox and replay offline breaks.
    case connectivity
    /// The setup-repair flow finished (permission or selection restored).
    case repair
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
    /// What happened to the breaks started or ended offline.
    var breakReplay = BreakReplayOutcome()
    /// Local notifications scheduled for upcoming boundaries.
    var notificationsPlanned = 0
    /// The first error that stopped the network part of the sync (nil on success).
    var error: APIError?

    var succeeded: Bool { error == nil }
}

/// Keeps the device in step with the server and enforces locally (docs/SYNC_AND_OFFLINE.md):
///
/// 1. Replay breaks started or ended offline (`BreakReplayer`, same `clientBreakId` / `requestedAt`).
/// 2. `GET /sync` (and `GET /me` on launch/setup) → diff `policyVersion` / `scheduleVersion` → update the cache,
///    keeping a local break the server does not know yet (`BreakSessionMerge`).
/// 3. Compute the expected state with `WorkModeEngine` from the cache (works offline too).
/// 4. Re-plan DeviceActivity schedules when the plan changed: `plans.json` is written BEFORE
///    `provider.scheduleActivities` so a monitor callback always finds its entry; a failed registration is
///    retried on the next sync (`SyncMetadataStore.activitiesNeedReschedule`).
/// 5. Reconcile the shields now (`ReconcileDecision`, provider-state aware, same rules as `WorkModeController`).
/// 6. Queue POLICY_SYNCED / SCHEDULE_SYNCED / WORK_MODE_* / PERMISSION_NEEDS_ATTENTION events, plan local
///    notifications, flush the outbox (`POST /events`, batches ≤ 200) and check in (`POST /device/state`).
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
    private let replayer: BreakReplayer?
    private let notifications: LocalNotificationScheduling?
    private let metadata: SyncMetadataStore?
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
        breakAPI: BreakStarting? = nil,
        notifications: LocalNotificationScheduling? = nil,
        metadata: SyncMetadataStore? = nil,
        now: @escaping () -> Date = Date.init
    ) {
        self.api = api
        self.cache = cache
        self.outbox = outbox
        self.plans = plans
        self.provider = provider
        self.deviceInfo = deviceInfo
        self.planner = planner
        replayer = breakAPI.map { BreakReplayer(api: $0, cache: cache, now: now) }
        self.notifications = notifications
        self.metadata = metadata
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

    /// Re-plans the local notifications from the cache (after a break starts or ends in the app).
    @discardableResult
    func replanNotifications() async -> Int {
        await replanNotifications(state: cache.load() ?? CachedState(), at: now())
    }

    // MARK: Sync

    private func performSync(reason: SyncReason) async -> SyncOutcome {
        let instant = now()
        WorkModeLog.sync.info("sync started (\(reason.rawValue, privacy: .public))")
        guard api.hasCredentials() else {
            return enforce(state: cache.load() ?? CachedState(), at: instant, policyChanged: false, scheduleChanged: false, error: .notSignedIn())
        }

        // 1. Offline breaks first, so GET /sync answers with the server's view of them.
        var replay = BreakReplayOutcome()
        if let replayer {
            replay = await replayer.replay()
            if replay.replayed > 0 || !replay.dropped.isEmpty { touchServerContact(at: instant) }
        }
        if let error = replay.error, error.isAuthenticationFailure {
            var outcome = enforce(state: cache.load() ?? CachedState(), at: instant, policyChanged: false, scheduleChanged: false, error: error)
            outcome.breakReplay = replay
            return outcome
        }

        // 2. The bundle.
        let bundle: SyncBundle
        do {
            bundle = try await api.sync()
        } catch {
            let apiError = error as? APIError ?? .network(error)
            WorkModeLog.sync.error("sync failed: \(apiError.code.rawValue, privacy: .public)")
            let state = (try? cache.update { $0.lastSyncErrorCode = apiError.code.rawValue }) ?? cache.load() ?? CachedState()
            var outcome = enforce(state: state, at: instant, policyChanged: false, scheduleChanged: false, error: apiError)
            outcome.breakReplay = replay
            outcome.notificationsPlanned = await replanNotifications(state: cache.load() ?? state, at: instant)
            if !apiError.isAuthenticationFailure {
                // Still try to deliver queued events and a check-in: /sync may fail while others succeed.
                outcome.eventsFlushed = await flushOutbox()
            }
            return outcome
        }
        touchServerContact(at: instant)

        // 3. Profile (who/where), on launch and setup or when the cache lost it.
        if reason == .launch || reason == .setup || cache.load()?.organisation == nil {
            await refreshProfile()
        }

        // 4. Cache diff.
        var policyChanged = false
        var scheduleChanged = false
        var hadSchedule = false
        let updated: CachedState
        do {
            updated = try cache.update { state in
                hadSchedule = state.lastScheduleSyncAt != nil
                policyChanged = state.lastPolicySyncAt == nil || state.policyVersion != bundle.policyVersion
                scheduleChanged = state.lastScheduleSyncAt == nil || state.scheduleVersion != bundle.scheduleVersion
                state.policy = bundle.policy
                state.breakPolicy = bundle.breakPolicy
                state.shifts = bundle.shifts
                state.policyVersion = bundle.policyVersion
                state.scheduleVersion = bundle.scheduleVersion
                state.activeOverrides = bundle.activeOverrides
                state.activeBreakSession = BreakSessionMerge.merge(local: state.activeBreakSession, remote: bundle.activeBreakSession, queued: state.queuedBreaks)
                state.breakAllowance = bundle.breakAllowance
                state.lastSyncAt = instant
                state.lastSyncErrorCode = nil
                if policyChanged { state.lastPolicySyncAt = instant }
                if scheduleChanged { state.lastScheduleSyncAt = instant }
            }
        } catch {
            WorkModeLog.sync.error("cache update failed: \(String(describing: error), privacy: .public)")
            return enforce(state: cache.load() ?? CachedState(), at: instant, policyChanged: false, scheduleChanged: false,
                           error: APIError(code: .invalidResponse, message: "ClockOff could not save your schedule on this phone.", status: 0))
        }

        // 5. Sync events.
        var events: [DeviceEvent] = []
        if policyChanged {
            events.append(DeviceEvent(type: .policySynced, occurredAt: instant, metadata: DeviceEventMetadata(policyVersion: bundle.policyVersion)))
        }
        if scheduleChanged {
            events.append(DeviceEvent(type: .scheduleSynced, occurredAt: instant, metadata: DeviceEventMetadata(scheduleVersion: bundle.scheduleVersion)))
        }
        if !events.isEmpty { _ = try? outbox.append(contentsOf: events) }

        // 6. Enforce, 7. notify, 8. upload.
        var outcome = enforce(state: updated, at: instant, policyChanged: policyChanged, scheduleChanged: scheduleChanged, error: nil)
        outcome.breakReplay = replay
        outcome.notificationsPlanned = await replanNotifications(state: cache.load() ?? updated, at: instant)
        if scheduleChanged, hadSchedule {
            await notifyScheduleChanged(version: bundle.scheduleVersion)
        }
        outcome.eventsFlushed = await flushOutbox()
        await reportDeviceState(engineState: outcome.engineState.state, at: instant)
        WorkModeLog.sync.info("sync finished: \(outcome.expectedState.state.rawValue, privacy: .public), rescheduled=\(outcome.activitiesRescheduled), replayed=\(replay.replayed), notifications=\(outcome.notificationsPlanned)")
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
        let engine = WorkModeEngine(options: options, timezone: timeZone.identifier, employeeId: state.employee?.id)
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

        // 1. DeviceActivity schedules (when they differ from what was last scheduled, or the last registration failed).
        if permission.isApproved {
            let entries = planner.plan(now: instant, shifts: state.shifts, activeBreak: state.activeBreakSession,
                                       policy: state.policy, breakPolicy: state.breakPolicy, timeZone: timeZone, options: options)
            let file = PlansFile(generatedAt: instant, organisationName: state.organisation?.name, entries: entries)
            let existing = plans.read()
            let planChanged = existing?.entries != file.entries || existing?.organisationName != file.organisationName
            if planChanged || (metadata?.activitiesNeedReschedule ?? false) {
                do {
                    // plans.json FIRST: a DeviceActivity callback must never find its entry missing.
                    try plans.write(file)
                    provider.cancelAllActivities()
                    try provider.scheduleActivities(file.activities)
                    metadata?.activitiesNeedReschedule = false
                    outcome.activitiesRescheduled = true
                } catch {
                    // The plan is on disk; the app's own reconcile/timers keep enforcing and the next sync retries.
                    metadata?.activitiesNeedReschedule = true
                    WorkModeLog.sync.error("scheduling activities failed: \(String(describing: error), privacy: .public)")
                }
            }
        }

        // 2. Shields right now, only when what is applied disagrees with what the engine expects.
        var applied = expected.state
        if permission.isApproved {
            let decision = ReconcileDecision.decide(
                expected: expected,
                providerState: provider.currentEngineState(),
                policy: state.policy,
                breakPolicy: state.breakPolicy,
                hasSelection: provider.hasSelection()
            )
            applied = decision.appliedState
            if decision.isChange {
                do {
                    try perform(decision.action)
                    outcome.restrictionAction = decision.action
                } catch RestrictionProviderError.notAuthorized {
                    applied = .permissionError
                } catch RestrictionProviderError.noSelection {
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

    private func perform(_ action: RestrictionAction) throws {
        switch action {
        case .applyWork(let plan):
            try provider.applyWorkRestrictions(plan: plan)
        case .applyBreak(let plan, let behaviour):
            try provider.applyBreakRestrictions(plan: plan, behaviour: behaviour)
        case .clear:
            try provider.clearRestrictions()
        case .leaveUnchanged:
            break
        }
    }

    // MARK: Notifications

    private func replanNotifications(state: CachedState, at instant: Date) async -> Int {
        guard let notifications else { return 0 }
        let timeZone = deviceInfo.timeZone
        let planned = NotificationPlanner.plan(cache: state, now: instant, timeZone: timeZone)
        await notifications.replacePlanned(planned, timeZone: timeZone)
        return planned.count
    }

    private func notifyScheduleChanged(version: Int) async {
        guard let notifications else { return }
        if let metadata, metadata.lastScheduleChangeNoticeVersion == version { return }
        metadata?.lastScheduleChangeNoticeVersion = version
        let notice = NotificationPlanner.scheduleChanged()
        await notifications.postNow(id: NotificationPlanner.scheduleChangedIdentifier, title: notice.title, body: notice.body)
    }

    // MARK: Upload

    private func flushOutbox() async -> Int {
        do {
            // Batches of ≤ 200, de-duplicated by clientEventId; a batch the server refuses outright
            // (400 VALIDATION_ERROR …) is dropped, never retried forever; transient failures keep it queued.
            let flushed = try await outbox.flush(isPermanentFailure: APIError.isPermanentRejection) { [api] batch in
                _ = try await api.postEvents(batch)
            }
            if flushed > 0 { touchServerContact(at: now()) }
            return flushed
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
            touchServerContact(at: instant)
        } catch {
            WorkModeLog.sync.error("device state report failed: \(String(describing: error), privacy: .public)")
        }
    }

    private func touchServerContact(at instant: Date) {
        metadata?.lastServerContactAt = instant
    }
}
