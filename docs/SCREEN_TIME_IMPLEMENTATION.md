# Screen Time implementation (iOS)

How the ClockOff iPhone app enforces shifts with Apple's Screen Time frameworks — FamilyControls,
ManagedSettings and DeviceActivity — and what that enforcement can and cannot promise. Read
[`IOS_SETUP.md`](IOS_SETUP.md) first for targets, signing and the simulator workflow, and
[`WORK_MODE_STATE_MACHINE.md`](WORK_MODE_STATE_MACHINE.md) / [`BREAK_RULES.md`](BREAK_RULES.md) for the
rules the device applies.

Everything here is implemented; the parts that genuinely cannot run in the iOS Simulator are called out in
§10, with the device script in §11.

## 1. Where things live

| Layer                                    | Target                                                     | Files                                                                                                                                                                                                                                                         | Frameworks                         |
| ---------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Engine, rules, storage, decisions        | `ClockOffCore` (SPM library, no Apple Screen Time imports) | `Engine/WorkModeEngine.swift`, `WorkModeTransitions.swift`, `Breaks/BreakRules.swift`, `BreakLedger.swift`, `Restrictions/ActivityPlanner.swift`, `ShieldApplier.swift`, `SelectionStore.swift`, `MonitorEventHandler.swift`, `ShieldCopy.swift`, `Storage/*` | Foundation, os                     |
| ManagedSettings / FamilyControls adapter | `ClockOffScreenTime` (SPM library)                         | `ManagedSettingsShieldStore.swift`, `SelectionCodec.swift`, `ScreenTimeAuthorization.swift`                                                                                                                                                                   | ManagedSettings, FamilyControls    |
| Apple provider, picker, controller       | `ClockOffApp`                                              | `Restrictions/AppleScreenTimeRestrictionProvider.swift`, `ScreenTimeSelectionPicker.swift`, `RestrictionProviderSupport.swift`, `WorkMode/WorkModeController.swift`, `UIWorkState.swift`, `BreakStarting.swift`                                               | + DeviceActivity, Combine, SwiftUI |
| Monitor extension                        | `ClockOffDeviceActivityMonitor`                            | `DeviceActivityMonitorExtension.swift` (wires `MonitorEventHandler`)                                                                                                                                                                                          | DeviceActivity + the two libraries |
| Shield UI                                | `ClockOffShieldConfiguration`                              | `ShieldConfigurationExtension.swift` (`ShieldCopy`)                                                                                                                                                                                                           | ManagedSettingsUI, UIKit           |
| Shield buttons                           | `ClockOffShieldAction`                                     | `ShieldActionExtension.swift` (`SharedFlags`)                                                                                                                                                                                                                 | ManagedSettings                    |

Every _decision_ is in `ClockOffCore` and unit-tested in the simulator with in-memory shield stores
(`InMemoryShieldStores`) and temporary App Group directories. The Apple-specific code is a thin, logic-free
layer over those decisions, so the simulator tests cover what the device will do.

The engine (`WorkModeEngine.computeExpectedState`, `diffStates`, `replayTransitions`,
`mergeShiftIntervals`) is a field-for-field port of `packages/shared/src/workMode/`. It runs the shared
fixture file `docs/fixtures/workmode-cases.json` (all 100 cases) in `WorkModeFixtureTests`; the copy in the
test bundle must be byte-identical to the docs file (`make sync-fixtures`, the test checks the SHA-256).
`BreakRules.canStartBreak` / `computeBreakAllowance` / `expiredBreakSessionClosures` port
`packages/shared/src/breaks/breakRules.ts` with the same precedence, rounding and messages.

## 2. Authorisation

- The app asks once, on onboarding screen 6, with
  `AuthorizationCenter.shared.requestAuthorization(for: .individual)`. The employee is the device owner,
  so the _individual_ authorisation is the right one: no Family Sharing, no parent/child roles.
- `AuthorizationCenter.shared.$authorizationStatus` (Combine) is observed for the life of the process.
  `AuthorizationStatus` is mapped to `RestrictionAuthorizationStatus` (`notDetermined` / `approved` /
  `denied`; an unknown future value counts as not determined, never as approved).
- The value reported to the server is derived with `RestrictionAuthorizationStatus.permissionState(previous:)`:
  a denial _after_ an approval is `REVOKED`, a first denial is `DENIED`.
- **Revocation** (Settings › Screen Time › Apps with Screen Time access › ClockOff off, or Screen Time turned
  off altogether): iOS removes the app's ManagedSettings on its side. The provider additionally
  1. clears both shield stores (`ShieldApplier.clearAll`) so nothing on our side claims otherwise,
  2. writes `engineState = PERMISSION_ERROR` (source `provider`) to the App Group `state.json`,
  3. calls `onAuthorizationStatusChange` and posts `Notification.Name.clockOffAuthorizationStatusDidChange`.
     `WorkModeController.handleAuthorizationChange` then queues one `PERMISSION_NEEDS_ATTENTION` event
     (`metadata.permissionState = REVOKED`, `reason = PERMISSION_REVOKED`), records `lastPermissionState`, reconciles,
     and publishes `UIWorkState.actionRequired(.screenTimeNotAllowed(.revoked))`. The Home card shows
     "Action required" with a button to `WorkModeController.settingsURL` (`UIApplication.openSettingsURLString`).
     The next `/device/state` check-in carries `permissionState: REVOKED` and `restrictionEngineState: PERMISSION_ERROR`.
- **Honesty rule.** The device never reports an active state it cannot prove. `currentEngineState()`
  returns `PERMISSION_ERROR` whenever authorisation is not approved, whatever the cache says (§5).

## 3. Opaque tokens and the app picker

Apple's `FamilyActivityPicker` returns a `FamilyActivitySelection` of opaque `ApplicationToken` /
`ActivityCategoryToken` / `WebDomainToken` values. The app can store them and hand them back to
`ManagedSettingsStore`, but it **cannot** read which apps they are, **cannot** pre-select anything, and
**cannot** map a Work Policy category (`SOCIAL_MEDIA`, `GAMES`, …) onto a token.

Consequences, and what the app does about them:

- The picker cannot be pre-populated from the policy. `SelectionPickerSheet` shows the policy's categories
  as guidance ("Your workplace blocks Social Media, Games, Streaming — pick those categories…") and the
  employee selects them. Save is disabled until the selection is non-empty.
- The selection is persisted by `SelectionCodec.save` → `SelectionStore` as
  `selection-work.json` in the App Group container (JSON `Codable` form of `FamilyActivitySelection`,
  format tag `FamilyActivitySelection.json.v1`), written atomically with
  `completeUntilFirstUserAuthentication` protection so the monitor extension can read it while the phone is
  locked after its first unlock.
- **Only counts leave the phone.** `SelectionSummary { categoryCount, applicationCount, webDomainCount }`
  is stored next to the payload; `AppleScreenTimeRestrictionProvider.selectionCounts()` reports it in
  `/device/state` (`selectionCounts`) and in the `SELECTION_CONFIGURED` event. The payload is never decoded
  by `ClockOffCore`, never logged and never sent (§12 privacy).
- `Notification.Name.clockOffSelectionDidChange` is posted after a save; the controller reconciles so a shift
  already in progress is shielded immediately.
- Leaving the workplace / signing out deletes both selection files (`SelectionStore.removeAll`).

## 4. Two shield stores

ClockOff writes to two named `ManagedSettingsStore`s (`ManagedSettingsStore.Name.work` =
`online.clockoff.shields.work`, `.breakRelaxed` = `online.clockoff.shields.breakRelaxed`). Apple unions the
settings of every store, so "at most one store populated at a time" is the invariant `ShieldApplier` keeps:

| Intent                                                 | `ShieldApplier`                       | work store                                      | break store          |
| ------------------------------------------------------ | ------------------------------------- | ----------------------------------------------- | -------------------- |
| Shift in progress (`WORK`)                             | `applyWork()`                         | work selection                                  | cleared              |
| Break, `RELAX_ALL`                                     | `applyBreak(.relaxAll)`               | cleared                                         | cleared              |
| Break, `RELAX_CATEGORIES` with a `breakKept` selection | `applyBreak(.relaxCategories(kept:))` | cleared                                         | breakKept selection  |
| Break, `RELAX_CATEGORIES` without one                  | same                                  | work selection (fallback)                       | cleared              |
| Break, `KEEP_RESTRICTIONS`                             | `applyBreak(.keepRestrictions)`       | work selection (applied only if not already up) | cleared              |
| Off shift, override, revocation, leave                 | `clearAll()`                          | `clearAllSettings()`                            | `clearAllSettings()` |

`ManagedSettingsShieldStore.apply` sets `shield.applications`, `shield.webDomains`,
`shield.applicationCategories = .specific(categoryTokens, except: [])` and `shield.webDomainCategories`
from the selection. `clearShields` is `clearAllSettings()`, so nothing else can linger in a store.
`isShielding` reads the store back (`shield.applications` / `webDomains` / category policies), never a
cached flag.

Applying is idempotent: the monitor extension re-applies at every interval start and the controller on every
foreground without flapping.

## 5. `currentEngineState()` — never claim what the stores do not show

`AppleScreenTimeRestrictionProvider.currentEngineState()` combines three sources, in this order:

1. authorisation: not approved → `PERMISSION_ERROR`;
2. the stores, read back: break store populated and work store empty → `ON_BREAK`; anything populated →
   the recorded active state (or `WORKING` when nothing is recorded);
3. both stores empty → the state the app or extension last recorded in `state.json` (`engineState`) —
   **unless** that state is an active one. An active recorded state with empty stores is reported as
   `UNKNOWN`, except for the one legitimate case: an `ON_BREAK` whose cached session lifts every category
   (`RELAX_ALL`, or `RELAX_CATEGORIES` listing all categories) has no shields by design.

`WorkModeController.reconcile()` feeds that into `ReconcileDecision.decide`:

| Expected (engine)        | Provider reports              | Decision                                                | Reason recorded on the events     |
| ------------------------ | ----------------------------- | ------------------------------------------------------- | --------------------------------- |
| `WORK`                   | `UNKNOWN`                     | apply work, log "UNKNOWN → corrected"                   | `UNKNOWN_CORRECTED`               |
| `WORK`                   | `OFF_SHIFT` / `ON_BREAK` / …  | apply work                                              | `RECONCILE`                       |
| `WORK`                   | `WORKING` / `SHIFT_ENDING`    | nothing                                                 | —                                 |
| `NONE`                   | any active state or `UNKNOWN` | clear                                                   | `RECONCILE` / `UNKNOWN_CORRECTED` |
| `BREAK_RELAXED`          | not `ON_BREAK`                | apply the break behaviour                               | `RECONCILE`                       |
| `PERMISSION_ERROR`       | shields still up              | clear                                                   | `RECONCILE`                       |
| anything needing shields | no work selection             | nothing; `PERMISSION_ERROR`, `selectionIncomplete` flag | `SELECTION_MISSING`               |

Engine state and `WORK_MODE_STARTED` / `WORK_MODE_ENDED` events are written **only when something actually
changed**, in one coordinated `state.json` write (`WorkModeController.record`), so a sync running at the same
time sees the new state and does not repeat the events.

## 6. Breaks and `RELAX_CATEGORIES`: the two-selection approach

Because tokens are opaque, the device cannot derive "the work selection minus the relaxed categories". A
break policy with `RELAX_CATEGORIES` therefore needs a **second selection**, `breakKept`
(`selection-breakKept.json`): the subset of the work selection that must _stay_ blocked during breaks. The
employee makes it with the same picker (`SelectionConfiguring.configureSelection(kind: .breakKept)`, title
"Keep blocked on breaks"). `RestrictionPlan.requiresBreakSubsetSelection` says whether a policy needs it.

Until it exists, a `RELAX_CATEGORIES` break falls back to `KEEP_RESTRICTIONS` — the shields stay fully up
rather than lifting more than the policy allows — and `SharedFlags.selectionIncomplete` is set, which
`WorkModeController.needsBreakSelection` surfaces as "Selection incomplete" with a button to run the second
picker. The server is not told which categories were kept (it cannot be known); the break is reported
normally.

### Starting and ending a break (`WorkModeController`)

1. `startBreak(requestedDurationMinutes:)` first runs `BreakRules.throwIfCannotStartBreak` against the
   **cached** policy and the cached active session (instant feedback, same refusals as the server, no network).
2. It then calls `BreakStarting.startBreak(clientBreakId:shiftId:requestedAt:requestedDurationMinutes:)`
   (`POST /breaks/start`, idempotent on `clientBreakId`).
   - Success: the server row becomes the cached active session (`BreakLedger.recordServerBreak`).
   - A transient failure (`APIError.isTransient`: no network, timeout, 5xx; or `CREDENTIALS_UNAVAILABLE`):
     the break starts **offline** from the local approval (`BreakLedger.startLocalBreak`): the session's `id`
     is the `clientBreakId`, and a `QueuedBreakRecord { clientBreakId, shiftId, requestedAt,
requestedDurationMinutes, plannedEndsAt, status: PENDING_START }` is appended to
     `CachedState.queuedBreaks` for the sync layer to replay with the **same** `clientBreakId` and
     `requestedAt` (the server validates that instant itself, see BREAK_RULES.md "online and offline").
   - Any other error (a server refusal such as `BREAK_TOO_SOON`) is rethrown and nothing is started.
3. The relaxation is applied now (`applyBreakRestrictions`), the `plans.json` entry for
   `break-<clientBreakId>` is written **before** `scheduleBreak` registers the DeviceActivity (§7), and a
   `BREAK_STARTED` event is queued (`breakSessionId` for a server break, `clientBreakId` + `reason:
OFFLINE_START` for a local one). The controller arms its own timer for the exact `plannedEndsAt`.
4. `endBreakEarly()` calls `BreakStarting.endBreak(id:endedAt:reason: EMPLOYEE_ENDED)` for a server break;
   offline (or for a break that never reached the server) the end is recorded on the queued record
   (`PENDING_END` with `serverBreakSessionId`, or kept with the pending start). The session is closed,
   `BREAK_ENDED` queued, the break activity cancelled, and `reconcile()` restores the work shields.
5. Expiry: when the app is alive, `reconcile()` closes a break whose time is up
   (`BreakLedger.closeExpiredBreak` → `BREAK_EXPIRED` at `plannedEndsAt`, or `BREAK_ENDED` /
   `SHIFT_ENDED` when the shift end cut it short) and restores the shields. When it is not, the monitor
   extension does the same at the end of the `break-*` activity (§7). Expiries are never `POST`ed: the server
   sweeps them.
6. **Shift end always ends an active break** — in the engine (effective end = min(planned end, shift end)),
   in `reconcile()`, and in the monitor's `intervalDidEnd(shift-*)`.

The sync engineer's replay contract: for each `QueuedBreakRecord`, `POST /breaks/start` with the stored
`clientBreakId` / `shiftId` / `requestedAt` / `requestedDurationMinutes`; on success set
`serverBreakSessionId` and, if `endedAt` is set, `POST /breaks/:id/end { endedAt, reason: endReason }`;
then remove the record (`BreakLedger.recordServerBreak` does the first part when the start succeeds while
the break is still running). A refusal means the local break is dropped and the employee is told.

## 7. DeviceActivity scheduling and its limits

`ActivityPlanner.plan` turns the cached schedule into `PlanEntry`s; `WorkModeController.replanActivities()`
(and the sync layer) writes them to `plans.json` and registers them through
`RestrictionProvider.scheduleActivities`:

- **One activity per merged working interval**, not per shift (`WorkModeEngine.mergeShiftIntervals`), so
  back-to-back shifts never flap. Name: `shift-<firstShiftId>-v<version>` where `version` is the sum of the
  merged shifts' versions — any edit changes the name, so a callback for a stale schedule finds no
  `plans.json` entry and is ignored (`MonitorEventHandler` "stale activity").
- `DeviceActivitySchedule(intervalStart:, intervalEnd:, repeats: false, warningTime:)` with
  `DateComponents` carrying calendar, time zone, year, month, day, hour and minute
  (`deviceComponents(for:in:)` + `AppleScreenTimeRestrictionProvider.minuteComponents`).
  `warningTime` = the policy's `preShiftWarningMinutes` → `intervalWillStartWarning` → `SHIFT_STARTING_SOON`.
- `scheduleActivities` stops every activity whose name is ours (`ActivityNaming.isOurs`), skips plans whose
  end has already passed, then starts the rest. Failures are collected and thrown as
  `RestrictionProviderError.schedulingFailed`; the app keeps enforcing with its own reconcile/timers.
- **`plans.json` is written before `startMonitoring`** so a callback can never find the file missing.

Apple's limits and what they mean for ClockOff:

| Limit                                            | Effect                                                                                                                                                    | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Minimum interval 15 minutes (`intervalTooShort`) | A shift interval under 15 min is not registered (the API refuses such shifts anyway). A break shorter than 15 min cannot have its own exact end activity. | `BreakActivitySchedule.make`: `intervalStart` = start floored to the minute, `intervalEnd` = max(`plannedEndsAt`, start + 15 min) rounded up to the minute; the **true** `plannedEndsAt` is in the `plans.json` entry. The app ends the break exactly on time while it is alive; **with the app closed, a break under 15 minutes is restored within 15 minutes of its start**, not at `plannedEndsAt`. The server state is exact regardless. |
| At most 20 monitored activities                  | Not every shift in a 14-day sync window can be registered.                                                                                                | `ActivityPlanner` registers the next **18** shift intervals within a 7-day horizon and keeps **2 slots** for break activities; every sync (and every launch/time change) re-plans, so the window rolls forward.                                                                                                                                                                                                                              |
| Schedules follow the device clock and time zone  | See §9.                                                                                                                                                   |                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `startMonitoring` with a start in the past       | Allowed; `intervalDidStart` fires immediately.                                                                                                            | This is how a shift already in progress is (re)registered on every sync; the monitor's apply is idempotent.                                                                                                                                                                                                                                                                                                                                  |

## 8. The three extensions

The monitor extension is woken by iOS at interval boundaries even when the app is not running or after a
reboot. It has a small memory budget, so it links only Foundation, DeviceActivity, `ClockOffCore` and the
thin `ClockOffScreenTime` adapter (ManagedSettings + FamilyControls are needed to decode the selection
tokens). No UIKit, no networking, no SwiftUI. All of its logic is `MonitorEventHandler` (tested in
`MonitorEventHandlerTests`):

| Callback                   | Activity                             | Action                                                                                                                                                                                                                                     |
| -------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `intervalWillStartWarning` | `shift-*`                            | `SharedFlags.shiftStartingSoon`, engine state `SHIFT_STARTING_SOON` (never downgrading a running Work Mode)                                                                                                                                |
| `intervalDidStart`         | `shift-*`                            | re-evaluate the cached schedule; apply the work shields (or the running break's behaviour; nothing under a lifting override or without permission); record `WORKING` (source `monitorExtension`); queue `WORK_MODE_STARTED`                |
| `intervalDidEnd`           | `shift-*`                            | if the cache says another interval already covers now, keep enforcing; else clear both stores, end a running break (`SHIFT_ENDED` → `BREAK_ENDED`, or `EXPIRED` on a tie), drop break entries, record `OFF_SHIFT`, queue `WORK_MODE_ENDED` |
| `intervalDidStart`         | `break-*`                            | no-op (the app applied the relaxation when the break started)                                                                                                                                                                              |
| `intervalDidEnd`           | `break-*`                            | if the break record is still active and its `plannedEndsAt` has passed: mark it `EXPIRED` at `plannedEndsAt`, queue `BREAK_EXPIRED`, restore the work shields (or clear if the shift has ended)                                            |
| any                        | unknown name / no `plans.json` entry | ignored                                                                                                                                                                                                                                    |

Events go through the shared outbox in `state.json`; the app uploads them on its next sync. The app and the
extension both record what they applied in `engineState`, so whichever observes a transition first emits
it and the other sees none.

**ShieldConfiguration** draws a neutral card from `plans.json` only (`ShieldCopy`): title = employer name
(else "ClockOff"), subtitle = the policy's `shieldMessage`, else "Work Mode is active until HH:mm"
(cached shift end in the device zone), else a default line; icon = the extension's `ShieldIcon` asset;
buttons "OK" and "Open ClockOff". Nothing about the shielded app is read, stored or sent.

**ShieldAction**: "OK" → `.close`. "Open ClockOff" cannot launch the app; it sets
`SharedFlags.openStatusRequested` and closes. `WorkModeController.handleDidBecomeActive` consumes the flag
on the next foreground and publishes `statusRequestedFromShield` so the UI shows the status screen.

## 9. Reboot, kill, time and clock

- **DeviceActivity schedules persist** across app termination and reboots; the extension fires at the next
  boundary. Its inputs — `state.json`, `plans.json`, `selection-*.json` — are in the App Group container
  with `completeUntilFirstUserAuthentication` protection, readable after the first unlock. (Before the
  first unlock after a reboot nothing can be read; iOS also does not run the shields' custom UI then.)
- **On launch and foreground** `WorkModeController.start()` / `handleDidBecomeActive()` run `reconcile()`:
  whatever happened while the app was dead (an interval the extension handled, a break that expired, a
  revocation) is reconciled against the stores and the cache, and a timer is armed for the next engine
  boundary (`nextTransitionAt`, or the running break's end) while the app stays alive.
- **Significant time change / time-zone change** (`UIApplication.significantTimeChangeNotification`,
  `NSSystemTimeZoneDidChange`): `handleTimeChange()` re-plans every activity (the `DateComponents` are
  rebuilt in the new zone, `plans.json` first) and reconciles.
- **Device clock dependence.** DeviceActivity fires by the phone's clock. If the clock is wrong, shifts and
  breaks start and end at the phone's idea of the time; the server cannot correct that. The device reports
  its clock with every check-in; the server stores the skew (`Device.lastClockSkewSeconds`) and flags
  `NEEDS_ATTENTION` beyond 5 minutes (`BreakRules.clockSkewAttentionThresholdSeconds`). The app's advice:
  Settings › General › Date & Time › Set Automatically.
- DST: schedules are built from UTC instants in an explicit zone, so spring-forward and fall-back nights are
  right whenever the clock is right (`DeviceComponentsTests`, the `dst-*` fixtures). A fall-back wall clock
  is ambiguous; the UTC `plannedEnd` kept in `plans.json` disambiguates for the extension.

## 10. What the simulator can and cannot do

|                                                                       | Simulator                                               | Device                         |
| --------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------ |
| `AuthorizationCenter.requestAuthorization`                            | returns without approving (status stays not determined) | real prompt                    |
| `FamilyActivityPicker`                                                | renders but has no apps to list                         | real picker                    |
| `ManagedSettingsStore` shields                                        | accepted, never enforced                                | enforced                       |
| `DeviceActivityCenter.startMonitoring`                                | may throw / never fires                                 | fires on time, survives reboot |
| `ClockOffCore` engine, rules, planner, ledger, applier, monitor logic | fully tested (`make test`)                              | same code                      |
| Release build with the real provider and no mock                      | compiles and is verified (`make build-release`)         | runs                           |

Debug builds therefore use `MockRestrictionProvider` (`DEBUG_MOCK_RESTRICTIONS`), which simulates
authorisation, selection counts, both stores and DeviceActivity's limits, and the app shows the yellow
"DEVELOPMENT MODE" banner. Release — and a Debug build with `CLOCKOFF_MOCK_RESTRICTIONS_CONDITION =` in
`Config/Local.xcconfig` — uses `AppleScreenTimeRestrictionProvider`. `make build-release` fails if the mock
reaches a Release binary.

## 11. Manual device test script

`docs/DEVICE_TESTING.md` is the owner's step-by-step version of this script, with what to check on the
Debug-only Diagnostics screen.

**Prerequisites**

- A physical iPhone (iOS 16.4+) with a Debug build: `make -C apps/ios device-install`, or Run from Xcode. It
  is signed automatically for team `78B9UY2V8C`. Device Debug builds use production and the real provider
  (`docs/IOS_SETUP.md`).
- A dashboard login to the same organisation (production: ClockOff Test).
- Console on a Mac with the phone selected, filtered on subsystem `online.clockoff.app`, to watch the logs.
- A Work Policy blocking Social Media + Games, and a break policy with 2 × 15 min breaks
  (`minMinutesAfterShiftStart` 0, `minGapBetweenBreaksMinutes` 0).
- For step 7b, a second break policy with `RELAX_CATEGORIES` [Social Media].

The numbered steps mirror the product Definition of Done items 5–10 (the repository holds no copy of that
list; this is the Screen Time end-to-end sequence those items describe).

| #   | Steps                                                                                                                                                                                                          | Expected                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | Join with the company code; on screen 6 tap "Allow Screen Time access" and approve; on screen 7 pick a social app, a game, and the Social Media and Games categories; complete setup.                          | iOS prompt shown once; `PERMISSION_GRANTED`, `SELECTION_CONFIGURED` (counts only) and `SETUP_COMPLETED` appear in the dashboard activity; device status shows selection counts (e.g. 2 categories, 2 apps), never names.                                                                                                                                                                                             |
| 6   | Schedule a shift starting in ~20 minutes. Sync (pull to refresh). **Force-quit the app.** Wait.                                                                                                                | 15 min before: Home (on reopen) says "Starting soon". At the start minute, with the app still closed, the picked apps show the ClockOff shield (employer name, "Work Mode is active until HH:mm" or the policy message). Dashboard: `WORK_MODE_STARTED` (reason `INTERVAL_STARTED`) after the phone next syncs; device status Working. Tap "Open ClockOff" on a shield, reopen the app → the status screen is shown. |
| 7   | Open the app, tap "Start Break" (15 min). Force-quit. Wait 15 min.                                                                                                                                             | The shielded apps open immediately (RELAX_ALL). `BREAK_STARTED` in the dashboard. At the planned end, with the app closed, the shields return within one minute; `BREAK_EXPIRED` after the next sync. Repeat with a 5-minute break: the shields return at ~15 minutes after the start with the app closed, at 5 minutes with it open.                                                                                |
| 7b  | Switch the employee to the `RELAX_CATEGORIES` break policy, sync, take a break **before** making the second selection; then make the "Keep blocked on breaks" selection (game + Games) and take another break. | First break: everything stays blocked and the app shows "Selection incomplete". Second break: the social app opens, the game stays shielded.                                                                                                                                                                                                                                                                         |
| 8   | Let the shift reach its end (or shorten it from the dashboard and sync) with the app closed, once during a break.                                                                                              | Shields lift at the end minute; a running break is ended with the shift (`BREAK_ENDED` then `WORK_MODE_ENDED`). Reopen: "Off shift".                                                                                                                                                                                                                                                                                 |
| 9   | During a shift, from the dashboard apply "Exempt temporarily" (15 min), then sync the phone (foreground). Let it expire.                                                                                       | Shields lift at once; Home "Work Mode paused" with the resume time; `WORK_MODE_ENDED` with the override id; at expiry shields return, `WORK_MODE_STARTED`.                                                                                                                                                                                                                                                           |
| 10  | During a shift, Settings › Screen Time › Apps with Screen Time access › turn ClockOff off. Return to the app. Then turn it back on.                                                                            | Shields are gone (iOS). The app shows "Action required — Screen Time access is off" with a Settings button; dashboard: `PERMISSION_NEEDS_ATTENTION`, device Needs attention, permission `REVOKED`, engine `PERMISSION_ERROR` — the device never claims it is enforcing. After re-enabling and reopening: shields return, `WORK_MODE_STARTED`.                                                                        |
| R   | Reboot the phone during a shift, do not open the app, unlock once.                                                                                                                                             | Shields are in force after unlock (they were applied before; a boundary that fires after the reboot is handled by the extension). Opening the app shows Working with no new events.                                                                                                                                                                                                                                  |
| O   | Turn on Airplane Mode, take a break, end it early, turn Airplane Mode off, pull to refresh.                                                                                                                    | The break starts and ends on the phone immediately; after reconnecting the sync layer replays it with the same `clientBreakId` and the dashboard shows one `BREAK_STARTED` (reason `OFFLINE_START`) and one `BREAK_ENDED`.                                                                                                                                                                                           |

## 12. APIs for the other app engineers

`WorkModeController` (`@MainActor`, `ObservableObject`; one per app, `start()` once):

```swift
init(cache: StateCache, plans: PlansStore, provider: AppRestrictionProvider, breakAPI: BreakStarting?,
     flags: SharedFlags?, isDevelopmentMode: Bool, planner: ActivityPlanner = .init(),
     timeZone: @escaping () -> TimeZone = { .current }, now: @escaping () -> Date = Date.init,
     notificationCenter: NotificationCenter = .default)
convenience init(container: DependencyContainer)          // production wiring (MobileAPIBreakClient)
@Published private(set) var state: UIWorkState               // unknown | offShift(nextShift:) | startingSoon(shift:)
                                                             // | working(shift:endsAt:allowance:relaxedByManager:)
                                                             // | onBreak(session:endsAt:remaining:) | pausedByManager(override:resumesAt:)
                                                             // | actionRequired(.screenTimeNotAllowed(PermissionState) | .appsNotChosen | .enforcementFailed)
                                                             // | syncDelayed(lastSyncAt:)
@Published private(set) var expectedState: ExpectedState?
@Published private(set) var needsBreakSelection: Bool        // offer configureSelection(kind: .breakKept)
@Published var statusRequestedFromShield: Bool               // set after "Open ClockOff" on a shield; clear when shown
@Published private(set) var isBreakRequestInFlight: Bool
let isDevelopmentMode: Bool
var breakAllowance: BreakAllowance?
var settingsURL: URL?
func start() / stop()
func handleDidBecomeActive() / handleTimeChange() / handleAuthorizationChange(_:)
@discardableResult func reconcile(reason: String = "RECONCILE") -> ReconcileOutcome
@discardableResult func replanActivities() throws -> PlansFile?
@discardableResult func startBreak(requestedDurationMinutes: Int? = nil) async throws -> BreakSession   // throws BreakRefusal | APIError
func endBreakEarly() async throws                                                                         // throws APIError(BREAK_NOT_ACTIVE) | APIError
```

```swift
protocol BreakStarting: AnyObject {
    func startBreak(clientBreakId: String, shiftId: String, requestedAt: Date, requestedDurationMinutes: Int?) async throws -> BreakSession
    func endBreak(id: String, endedAt: Date, reason: MobileBreakEndReason) async throws
}
final class MobileAPIBreakClient: BreakStarting { init(api: MobileAPI) }
```

Queued offline breaks for the sync layer: `CachedState.queuedBreaks: [QueuedBreakRecord]` (see §6);
`CachedState.isLocalBreak(_:)`, `BreakLedger.recordServerBreak(_:)`. Shared flags
(`SharedFlags.appGroup()`): `openStatusRequested`, `shiftStartingSoon`, `selectionIncomplete`,
`lastMonitorCallback`. Selection: `SelectionConfiguring.configureSelection(kind:)` presents the picker;
`Notification.Name.clockOffSelectionDidChange` follows a save.

## 13. Known limitations

- Breaks shorter than 15 minutes are restored late when the app is closed (§7). Tell managers in the policy
  editor; the app can show "Keep the app open to end your break on time" via
  `BreakRules.isBelowDeviceActivityInterval`.
- `RELAX_CATEGORIES` depends on the employee's second selection matching the policy; the device cannot verify
  it (opaque tokens). Without it the break keeps every shield.
- The server receives counts only; it cannot tell whether the chosen apps match the policy's categories.
- Everything runs on the device clock (§9).
- Shields are not shown before the first unlock after a reboot, and Screen Time extensions do not run in
  the simulator (§10).
