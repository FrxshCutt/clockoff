# Sync and offline behaviour (iOS)

How the ClockOff iPhone app keeps its copy of the schedule fresh, what it does without a connection, and how
the two meet again. Code: `apps/ios/ClockOffApp/Sync/` (`SyncCoordinator`, `BreakReplayer`,
`BreakSessionMerge`, `ConnectivityMonitor`, `SyncStaleness`), `Notifications/`, `Persistence/`, `App/AppModel.swift`.
Enforcement itself is described in [`SCREEN_TIME_IMPLEMENTATION.md`](SCREEN_TIME_IMPLEMENTATION.md); the break
rules the server applies to late (offline) requests are in [`BREAK_RULES.md`](BREAK_RULES.md).

The one rule everything below follows: **the phone enforces from its cache, never from the network.** The engine,
`WorkModeController`, the DeviceActivity schedules and the three extensions read `state.json` and `plans.json`
in the App Group container. A sync only replaces what is in the cache; losing the network changes nothing
about what is enforced.

## 1. Triggers

| Trigger                 | Where                                                                      | What runs                                                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Launch (set-up phone)   | `AppModel.start()` → `startMain`                                           | `WorkModeController.start()` (reconcile from cache at once), then `sync(.launch)` (also `GET /me`)                                                       |
| Foreground              | `scenePhase == .active`                                                    | `sync(.foreground)`; the controller re-checks the shields itself on `didBecomeActive`                                                                    |
| Pull to refresh         | Home / Schedule                                                            | `sync(.pullToRefresh)`                                                                                                                                   |
| Background refresh      | `BGAppRefreshTask` `online.clockoff.app.refresh` (`BackgroundRefresh`)     | `sync(.backgroundRefresh)`; the next refresh is requested ≥ 15 min ahead every time the app backgrounds or a task runs. iOS decides when it really runs. |
| Silent push             | `content-available: 1` (`AppDelegate.didReceiveRemoteNotification`)        | `sync(.silentPush)`                                                                                                                                      |
| Connectivity restored   | `NWPathMonitor` (`NetworkPathConnectivityMonitor`) unsatisfied → satisfied | `sync(.connectivity)`: replay offline breaks, flush the outbox                                                                                           |
| Setup / repair finished | onboarding screen 8, Setup Repair sheet                                    | `sync(.setup)` / `sync(.repair)`                                                                                                                         |

Concurrent triggers coalesce: `SyncCoordinator` is an actor and a sync requested while one is in flight simply
awaits the running one. After every sync `AppModel` calls `WorkModeController.reconcile(reason: "SYNC")`, so the
shields and the Home card follow the fresh cache immediately.

## 2. One sync, step by step

1. **Replay offline breaks** (`BreakReplayer`, §4) — before `GET /sync`, so the server's answer already reflects them.
2. **`GET /sync`** → `SyncBundle` (policy, break policy, shifts −1 … +14 days, versions, active overrides, active
   break, allowance, server time). On failure: enforce from the cache (step 5), still flush the outbox, return the
   error (the Home line says "Couldn't reach ClockOff").
3. **`GET /me`** on launch, setup, or when the cache lost the profile.
4. **Version diff and cache update.** `policyVersion` (PolicyVersion id) and `scheduleVersion` (monotonic per
   employee) are compared with the cache; `lastPolicySyncAt` / `lastScheduleSyncAt` move only when they changed,
   and POLICY_SYNCED / SCHEDULE_SYNCED are queued only then. `activeOverrides` are stored as the engine's override
   input (the controller's next reconcile applies a lifting override by clearing the shields; a TEMPORARY_EXCEPTION
   by applying its relaxation). The active break is merged, not copied (§4). `lastSyncAt` moves only on success.
5. **Enforce from the cache** (`SyncCoordinator.enforce`):
   - `WorkModeEngine.computeExpectedState` with the device's permission state.
   - **Re-plan DeviceActivity when the plan changed.** `ActivityPlanner` produces the `plans.json` entries (one per
     merged working interval, ≤ 18, plus the running break). If they differ from the file on disk — or the last
     registration failed (`SyncMetadataStore.activitiesNeedReschedule`) — the file is **written first**, then
     `cancelAllActivities` + `scheduleActivities`. A monitor-extension callback therefore never finds its entry
     missing. A failed registration keeps the file and sets the retry flag; the app's own reconcile and timers keep
     enforcing meanwhile. Unchanged versions re-plan nothing (tested).
   - **Shields now**, through `ReconcileDecision.decide` (the same provider-state-aware rules
     `WorkModeController` uses): apply work, apply the break behaviour, clear, or leave alone. A missing selection
     during a shift records `PERMISSION_ERROR` and never applies anything.
   - Record the applied engine state and queue the implied WORK_MODE_STARTED / WORK_MODE_ENDED (only on a real
     transition, with `reason`), plus PERMISSION_NEEDS_ATTENTION when approval was lost since the last report.
6. **Local notifications** are re-planned from the cache (§6) and "Schedule changed" is posted once per new
   `scheduleVersion` (never for the first schedule).
7. **Flush the outbox** (§3) and **check in** with `POST /device/state` (permission, selection counts, engine
   state, versions applied, local time, timezone). The response's `clockSkewSeconds` is cached; Settings warns
   beyond 5 minutes.

`SyncMetadataStore.lastServerContactAt` records the last successful request of any kind (Settings › Connection).

## 3. Outbox

Events live in `CachedState.outbox` (`state.json`) so the app and the DeviceActivityMonitor extension both
enqueue, and are de-duplicated by `clientEventId` (case-insensitive; the server is idempotent on it too).

- Batches of at most **200** (`POST /events`), oldest first; a batch is removed only after the server accepted it.
- **Transient failures** (no network, timeout, 5xx, 401, 429, unreadable Keychain) keep the batch and every later
  one for the next trigger. `APIClient` already retries 5xx/network errors on idempotent requests with
  exponential backoff and jitter (`BackoffPolicy`, 3 retries, 0.5 s → 8 s); the outbox adds no second retry loop.
- A batch the server **refuses outright** (400 / 413 / 415 / 422, e.g. VALIDATION_ERROR) is dropped and logged so
  one malformed event can never block later ones.
- One-off onboarding events (PERMISSION_GRANTED, PERMISSION_NEEDS_ATTENTION, SELECTION_CONFIGURED,
  SETUP_COMPLETED) are not queued again while one of the same type is still waiting.
- The queue is capped at 500 events, oldest dropped first (a phone offline for weeks must not grow without bound;
  the server re-derives state from the schedule anyway).

## 4. Breaks started or ended offline

`WorkModeController.startBreak` validates against the **cached** policy (`BreakRules.canStartBreak`, the same
rules and messages as the server) and then calls `POST /breaks/start`. When that fails transiently, the break
starts **from the local approval**: the session's id is its `clientBreakId`, the relaxation is applied, the
`break-<clientBreakId>` activity registered, BREAK_STARTED queued (`reason: OFFLINE_START`), and a
`QueuedBreakRecord { clientBreakId, shiftId, requestedAt, requestedDurationMinutes, plannedEndsAt, PENDING_START }`
is appended to `CachedState.queuedBreaks`. Ending it offline sets `endedAt` / `endReason` on the record (or, for
a break the server already knows, a `PENDING_END` record with the `serverBreakSessionId`).

`BreakReplayer` runs at the start of every sync, oldest record first:

| Record        | Request                                                                                                                                                                                       | Server answer                                                                                             | Result                                                                                                                                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PENDING_START | `POST /breaks/start` with the **original** `clientBreakId` and `requestedAt` (the server converts the tap time to its own clock and validates it there — `breakStartInstant`, BREAK_RULES.md) | ACTIVE session                                                                                            | It becomes the cached session (`BreakLedger.recordServerBreak`); if the phone had already ended it, `POST /breaks/:id/end` follows and the ended row is cached                                                                                              |
| PENDING_START | same                                                                                                                                                                                          | ENDED session (`EXPIRED` on arrival, or `POLICY_CHANGED`: the policy in force refused what the phone did) | The running local break is ended now (BREAK_ENDED, `reason: SERVER_ENDED`), the server row is cached, the shields come back on the next enforce/reconcile                                                                                                   |
| PENDING_START | same                                                                                                                                                                                          | Refusal (NOT_ON_SHIFT, BREAK_ALREADY_ACTIVE, VALIDATION_ERROR …)                                          | The record is dropped, the running local break ended (BREAK_ENDED, `reason: SERVER_REFUSED`) and the employee is told ("Your break taken offline wasn't accepted …"). The phone's own BREAK_STARTED / BREAK_ENDED events remain the record of what happened |
| PENDING_END   | `POST /breaks/:id/end { endedAt, reason }`                                                                                                                                                    | 200, or NOT_FOUND / already ended                                                                         | The record is removed either way                                                                                                                                                                                                                            |
| any           | —                                                                                                                                                                                             | transient error                                                                                           | The replay stops; every remaining record waits for the next trigger                                                                                                                                                                                         |

Because the bundle is fetched **after** the replay, the server's `activeBreakSession` normally already includes
the replayed break. When the replay could not run (still offline), `BreakSessionMerge` keeps the local session
while a `QueuedBreakRecord` exists for it, so the sync neither erases a local break nor revives one the phone has
ended but not yet reported. Expiries are never replayed: the server sweeps them.

## 5. Stale detection

- **Banner** (Home, every state): after **1 hour** without a successful sync — "Last synced 2h ago · changes will
  apply when online" (`SyncStaleness`). Settings › Connection shows "Connected — sync delayed" at the same threshold.
- **SYNC DELAYED card**: `WorkModeController` replaces the OFF SHIFT card after **6 hours** without a sync, or when
  the cache has never synced; during a shift the saved schedule is still enforced and shown.
- A failed sync never moves `lastSyncAt`; `lastSyncErrorCode` is kept for the Home status line.

## 6. Local notifications

`NotificationPlanner` (pure) turns the cache into requests with deterministic identifiers, and
`UserNotificationScheduler` replaces every pending `wm.*` request on each re-plan, so re-planning never
duplicates:

| Identifier                        | When                                                              | Text                      |
| --------------------------------- | ----------------------------------------------------------------- | ------------------------- |
| `wm.shift-<firstShiftId>-warning` | interval start − `preShiftWarningMinutes` (0 disables)            | Shift begins soon         |
| `wm.shift-<firstShiftId>-start`   | merged working-interval start                                     | Work Mode activated       |
| `wm.shift-<firstShiftId>-end`     | merged working-interval end                                       | Work Mode ended           |
| `wm.break-<clientBreakId>-ending` | `plannedEndsAt` − 2 min                                           | Break ending soon         |
| `wm.break-<clientBreakId>-ended`  | `plannedEndsAt`                                                   | Break ended               |
| `wm.schedule-changed`             | immediately, once per new `scheduleVersion`                       | Schedule changed          |
| `wm.permission-attention`         | immediately when Screen Time access is lost (once per regression) | Work Mode needs attention |

Only future moments are planned, within 7 days, at most 60 pending (iOS caps at 64). A break the shift end cuts
short gets no break notifications ("Work Mode ended" covers it). Nothing is planned without a Work Policy (nothing
would be enforced). Re-planning happens after every sync, after a break starts or ends in the app, and whenever the
controller's state changes. Permission is requested once, right after Screen Time is allowed on onboarding screen 6,
never earlier; without it the scheduler silently does nothing. Notifications are never tied to phone
interaction (§12): there is no "you opened a blocked app" notice.

## 7. Background limits

- **Background refresh** is best effort: iOS schedules it by its own heuristics (often never in the simulator).
  It only keeps the cache fresh; shifts start and end on time through DeviceActivity regardless.
- **Silent push** is also best effort (throttled by APNs and iOS; dropped while Low Power Mode is on). The server
  sends one whenever the schedule, policy or an override changes for the employee (`getPushProvider().sendSilent`),
  provided the APNs environment is configured (`APNS_*`; `Noop` otherwise). The app registers its token with
  `POST /device/push-token` and `environment: sandbox | production` from `CLOCKOFF_PUSH_ENVIRONMENT`.
- The sync itself needs no background mode: it runs in the foreground, in the refresh task, or on the push.

## 8. Reboot, force-quit, time changes

- DeviceActivity schedules survive termination and reboots; the monitor extension enforces at the next boundary
  from `plans.json` and `state.json` (readable after the first unlock). The app's next launch runs
  `WorkModeController.start()` → `reconcile()` from the cache before any network, so whatever happened while it
  was dead (an interval the extension handled, an expired break, a revocation) is reconciled and reported; the
  launch sync then refreshes the schedule.
- A significant time or time-zone change re-plans every activity (`plans.json` first) and reconciles.
- Everything runs on the device clock; the server stores the skew from each check-in and flags beyond 5 minutes.
  Settings tells the employee to turn on "Set Automatically".

## 9. Leaving and signing out

Leave Workplace lifts the shields and cancels every activity first, wipes `state.json`, `plans.json`, both
selection files, the shared flags, the sync metadata and onboarding progress, cancels every `wm.*` notification,
then `POST /leave-workplace` and deletes the tokens — local cleanup happens even when the server is unreachable
(the employee is told to ask a manager to disconnect the phone). Sign Out does the same without unlinking
(`POST /auth/logout`). The server ending the session (DEVICE_INACTIVE, TOKEN_REUSED, …) triggers the same wipe
and returns to Welcome with a notice.
