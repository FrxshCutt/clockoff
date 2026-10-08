# Work Mode server job (§10)

The server-side half of Work Mode: a tick that runs every minute, keeps every employee's
`EmployeeWorkState` in step with the state machine, emits the ActivityEvents only the server can know
about, starts scheduled breaks, expires overrides, nudges phones to re-sync and sends the manager digest.
Read `WORK_MODE_STATE_MACHINE.md` (what "expected state" means) and `BREAK_RULES.md` (how a break is
read) first.

Code: `apps/web/src/server/workState/workStateJob.ts` (`runWorkModeTick`), `apps/web/src/worker/` (the worker
process that runs it: `jobs.ts`, `scheduler.ts`, `cli.ts`), `apps/web/src/server/realtime/pushBridge.ts`
(bus → silent push), `apps/web/src/server/digest/` (digest).

## Running it

The tick runs in the **worker** process, never in the web app (`docs/DEPLOYMENT.md`, `docs/DECISIONS.md` D-024).
The worker splits it into jobs, each under its own Postgres advisory lock:

| Job                 | Every  | Runs                                                                                                        |
| ------------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| `work-mode-tick`    | 1 min  | steps 1–3 below: `runWorkModeTick(now, { sweepOverrides: false, scheduleUpkeep: false })`                   |
| `override-expiry`   | 1 min  | step 4: `sweepExpiredOverrides(now)`                                                                        |
| `schedule-upkeep`   | 1 min  | step 5: `runScheduleUpkeep(minuteStart)`, only after that minute's `work-mode-tick` finished on some worker |
| `integrations-sync` | 15 min | scheduled workforce-provider syncs (a documented no-op until a provider registers; `docs/INTEGRATIONS.md`)  |

| How                                                   | When to use it                                                                                                                                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm worker` (`tsx src/worker/main.ts`, root `.env`) | Local development: a long-running process beside `pnpm dev`. Starts with a catch-up pass at once, then fires at every wall-clock minute.                                                                                        |
| Railway service `worker` (`node main.mjs`)            | Production: always on, restarted on failure. Its first pass waits until the database's migrations are up to date.                                                                                                               |
| `pnpm worker run <job>` / `node main.mjs run <job>`   | One extra run now, under the job's lock (exit 0 ok, 1 error, 3 locked elsewhere, 4 migrations pending). `list` prints the jobs. In production it runs in the worker container (`docs/DEPLOYMENT.md` › Worker one-off commands). |
| `runWorkModeTick(now)` without options                | Tests and scripts: all five steps in one call.                                                                                                                                                                                  |

Two workers (or a scheduled run beside a manual one) never double-emit: every write in the tick is guarded (see
_Idempotency_), each scheduled run holds its job's advisory lock (another worker gets `skipped_locked`) and claims
its minute slot in `worker_job_runs` (a slot already run elsewhere is `skipped_already_ran`). Within one worker a
lane that is still busy when the next minute fires skips that minute (`skipped_overlap`, with a warning); nothing
is lost, the next pass catches up.

Shutdown: on `SIGTERM` / `SIGINT` the worker stops scheduling, hands over push leadership, lets running jobs finish
for up to `SHUTDOWN_GRACE_MS`, marks its heartbeat stopped, releases its locks, flushes the event bus and
disconnects Prisma. Logs are structured pino lines (`service: "clockoff-worker"`; `module: "worker"` with one
`job finished` line per run, and `"workModeTick"` inside the tick), ids and counts only — never names, emails or
tokens. Every minute the worker also writes a `worker_heartbeats` row; `GET /api/health` reports it with
`worker.jobs` (`ok` when `work-mode-tick` succeeded within 3 minutes).

Environment: `DIRECT_URL` (the lock session and the realtime LISTEN session; required in production),
`WORKER_JOBS_ENABLED` (`false` pauses every job), `SHUTDOWN_GRACE_MS`, `APNS_*` for real pushes (otherwise the
Noop provider logs and drops them), email provider settings for the digest. See `ENVIRONMENT.md`.

## What one tick does

`runWorkModeTick(now)` runs these steps in order and returns a `WorkModeTickReport` with a counter per step
and the ids of organisations whose evaluation failed (`errors`; the others continue). In production the worker
runs steps 1–3 as `work-mode-tick`, step 4 as `override-expiry` and step 5 as `schedule-upkeep` (table above).

### 1. Break sweep — `sweepExpiredBreakSessions`

Every `ACTIVE` BreakSession whose time is up is closed:

- shift still `SCHEDULED`: the pure `expiredBreakSessionClosures(shift, sessions, now)` decides — effective
  end `min(plannedEndsAt, shift.endsAt)` ≤ now → `ENDED` with `endReason = EXPIRED`, or `SHIFT_ENDED` when
  the shift end cut the break short (a shortened shift ends its running break);
- shift cancelled / completed / deleted: `ENDED` / `SHIFT_ENDED` at `min(now, plannedEndsAt, shift.endsAt)`.

Each closure is applied with `UPDATE … WHERE status = 'ACTIVE'`; only the closures **this** tick applied get
a SYSTEM ActivityEvent (`BREAK_EXPIRED`, or `BREAK_ENDED` with `endReason: SHIFT_ENDED`). The same helper
runs inside `POST /breaks/start` before a new row is inserted (the partial unique index
`break_sessions_one_active_per_shift` would otherwise reject it), so whichever path runs first wins and the
other sees nothing to do.

### 2. Scheduled breaks — `startDueScheduledBreaks`

A `ScheduledBreak` row (offset + duration on a shift) fires when its window
`[shift.startsAt + offset, min(+duration, shift.endsAt))` contains `now`. The job starts it server-side
through the same `startBreak` as the mobile endpoint, with `trigger: "SCHEDULED"`,
`requestedAt = window start`, `clientBreakId = scheduled:<scheduledBreakId>` (the idempotency key — a
later tick finds the row and does nothing) and `actorType: SYSTEM`. The break policy decides: when
`scheduledBreaksAllowed` is false or a limit refuses it, the break is skipped (`scheduledBreaksSkipped`) and
retried on the next tick while the window is open. Devices learn about it through `activeBreakSession` in
`GET /sync` (and the silent push is not needed: the device's own schedule already contains the window).

### 3. Evaluation — `evaluateOrganisation` + `persistEvaluation`

**Candidates** (`findJobCandidates`): ACTIVE, non-deleted employees with a `SCHEDULED` shift overlapping
`[now − 1 day, now + 1 day]`, or an `ACTIVE` break, or covered by an active override (employee-specific, or
every active employee of an organisation under an org-wide `EMERGENCY_POLICY_OVERRIDE`), or whose stored
state has not settled back to `OFF_SHIFT` yet. Everyone else is left alone (their row stays `OFF_SHIFT`).

Per organisation the job loads once: shifts in `[now − 1 day, now + 2 days]` (two days ahead so
`nextTransitionAt` is meaningful), every session of those shifts, overrides not expired at `now`, each
employee's most recently seen active device, the stored work-state rows, and the policy resolution for all
candidates in one call (`resolveForEmployees` from the policies service). Per employee it runs
`computeExpectedState({ now, shifts, breakSessions, overrides, permissionState: device.permissionState,
timezone, options })` — `preShiftWarningMinutes` comes from the resolved policy version's restriction
config (15 when none resolves), `shiftEndingWarningMinutes` is 5 — then `deriveDeviceStatus` for the badge.

**Columns written** on `EmployeeWorkState`:

| Column                                  | Value                                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `expectedState`, `expectedRestriction`  | `ExpectedState.state` / `.effectiveRestriction`                                                                                |
| `expectedComputedAt`                    | `now`                                                                                                                          |
| `nextTransitionAt`                      | `ExpectedState.nextTransitionAt` (null when nothing is scheduled)                                                              |
| `activeShiftId`, `activeBreakSessionId` | from the expected state                                                                                                        |
| `breaksTakenCount`, `breakMinutesUsed`  | sessions of the active shift so far, each read as the break rules read it (`min(endedAt ?? now, plannedEndsAt, shift.endsAt)`) |
| `state`, `stateSince`, `source`         | the **displayed state** — rule below                                                                                           |
| `attentionReason`                       | the badge's reason when it needs a manager — rule below                                                                        |
| `lastUpdatedAt`                         | `now`                                                                                                                          |

`reportedState` / `reportedAt` are owned by the device paths (`POST /device/state`, `POST /events`) and are
never touched by the job.

**Displayed `state` rule** (`deriveDisplayedState`):

1. no device report yet → `state = expectedState`, `source = SERVER_COMPUTED`;
2. the expectation changed (state, restriction, active shift or active break differ from the stored
   expectation) and the device's last report predates `now` — the phone has not caught up with the
   transition yet → `state = expectedState`, `source = SERVER_COMPUTED`, `stateSince = now`;
3. the row is still `SERVER_COMPUTED` from an earlier transition → keep following the expectation;
4. otherwise → `state = reportedState`, `source = DEVICE_REPORT`.

A fresh report through `/device/state` or `/events` switches the row back to `DEVICE_REPORT` immediately
(`applyReportedState`) and re-evaluates. `stateSince` only moves when the displayed value changes.

**Attention reasons** (stored in `attentionReason`, surfaced by `/api/compliance/*`, feed the digest):

- device clock skew above 300 s (`Device.lastClockSkewSeconds`, from the last `/device/state` report),
- permission state ≠ `APPROVED` while a shift is active ("Work Mode cannot be enforced during the current
  shift: …"),
- reported state diverging from the expected restriction level for more than 10 minutes after the
  expectation began (`NEEDS_ATTENTION`),
- no device sync for longer than the thresholds (`SYNC_DELAYED`, then `OFFLINE`) — stored with the marker
  `Device sync delayed: …` so an episode can be recognised.

Thresholds live in `DEVICE_STATUS_THRESHOLDS` (`@clockoff/shared/status/deriveDeviceStatus`).

**Server-owned ActivityEvents** emitted by this step:

| Event                       | When                                                      | Dedupe guard                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEVICE_SYNC_DELAYED`       | the badge becomes `SYNC_DELAYED` / `OFFLINE`              | once per episode: the write that first stores the `Device sync delayed` marker in `attentionReason` is a guarded `UPDATE … WHERE attention_reason NOT LIKE '%marker%'`; only the evaluation whose update affected a row records the event (`recordSyncDelayedEpisode` in `workState.service.ts`). The same guard runs wherever an evaluation is persisted — a job tick, `GET /sync`, or `recomputeEmployeeWorkState` after a break, device event or override — so whichever path first notices the silent device owns the event and the others see the marker. The episode ends when the device syncs again (marker cleared) and a new silence starts a new one. |
| `POLICY_RESOLUTION_WARNING` | `resolveForEmployees` reports `AMBIGUOUS_TEAM_ASSIGNMENT` | once per `(employee, kind:resolutionWarningKey)` per 24 h, keyed in `metadata.resolutionWarningKey`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

`diffStates(previousExpected, expected)` is evaluated and counted in the report (`transitions`) and logged
at debug level, but the events it implies (`WORK_MODE_STARTED`, `BREAK_STARTED`, …) are **not** written by
the job: the device reports those itself through `POST /events`, and the break endpoints record
`BREAK_STARTED` / `BREAK_ENDED` when they happen. The server only owns the events in the tables of this
document (plus `BREAK_EXPIRED` / `BREAK_ENDED (SHIFT_ENDED)` from step 1 and `OVERRIDE_EXPIRED` from
step 4).

**Realtime**: every row whose displayed state, source, expectation or attention reason changed publishes
`employee.work_state.changed` on the organisation bus (ids, states and the badge only), which the dashboard
SSE stream forwards.

**Digest** (`src/server/digest`): after the organisation's employees are evaluated, those whose badge is
`NEEDS_ATTENTION` or `PERMISSIONS_MISSING` **and** who have a shift on the local calendar day are collected.
If there is at least one, `sendOrganisationDigest` creates one in-app notification (type
`COMPLIANCE_DIGEST`, `metadata.employeeIds` / `counts`, link to `/overview`) for every OWNER / ADMIN member
via `createManagerNotification`, and emails the same summary through the configured EmailProvider to the
members whose `notificationPreferences.digestEmail` is not `false`. At most once per organisation per
hour: the latest `COMPLIANCE_DIGEST` notification row is the clock, read and written under a
per-organisation transaction-level advisory lock so two concurrent ticks cannot both send.
`runWorkModeTick(now, { sendDigest: false })` skips it (tests).

### 4. Override sweep — `sweepExpiredOverrides`

`OVERRIDE_EXPIRED` is emitted for every `ManagerOverride` with `expiresAt <= now`, `revokedAt IS NULL` and
`expiredEventEmittedAt IS NULL` — including overrides that never shaped anyone's output (the state machine
alone would not notice them). The column is claimed with `UPDATE … WHERE expired_event_emitted_at IS NULL`;
only the tick whose update affected the row records the SYSTEM ActivityEvent (`occurredAt = expiresAt`,
`employeeId` null for org-wide overrides) and publishes `OVERRIDE_EXPIRED` + `override.changed` on the
bus. Revoked overrides never get it (`OVERRIDE_REVOKED` is bus-only; the revoke itself is audited).

### 5. Schedule upkeep

`materialiseRecurrences(now)` tops every recurring series up to its horizon and `markCompletedShifts(now)`
flips past `SCHEDULED` shifts to `COMPLETED`. Both belong to the shifts service; a failure is logged and
counted in `errors` without stopping the tick. As its own job (`runScheduleUpkeep`) it waits until that minute's
`work-mode-tick` has finished on some worker and uses the start of the minute as `now`, so it never completes a
shift whose breaks the break sweep has not closed yet (a completed shift would turn their `EXPIRED` closure into
`SHIFT_ENDED`).

## Push bridge (`src/server/realtime/pushBridge.ts`)

Phones must re-sync when something they cache changes. The bridge subscribes to the organisation bus and
turns `POLICY_CHANGED`, `BREAK_POLICY_CHANGED`, `SCHEDULE_CHANGED`, `OVERRIDE_CREATED`, `OVERRIDE_REVOKED`
and `OVERRIDE_EXPIRED` into **content-available (silent) pushes** through the `PushProvider`:

- affected devices: `payload.affectedEmployeeIds` for policy events, the event's `employeeId` for schedule
  and employee-scoped overrides, every active device of the organisation for an org-wide override;
- debounced **5 s per device**, so a bulk import or a series edit sends one push with the merged reasons
  (`policy_changed,schedule_changed`);
- the APNs token is decrypted (`crypto.decrypt`) only for the provider call and never logged; a token APNs
  reports as invalid is cleared from the device row (the app re-registers on next launch).

The realtime bus carries every event to every process (Postgres LISTEN/NOTIFY, D-025), so a bridge in more than
one process would push every change twice. Only the worker holding the push-leadership lease (an advisory lock)
runs the bridge, with one subscription for all organisations; the other workers stand by and retry every 5 s. The
web process never bridges. On shutdown the leader flushes pending pushes and then releases the lease, so a standby
takes over within about 5 s. A leader that loses its lock session stops at once and drops its pending pushes
rather than risk sending them twice; phones catch up at their next sync.

## Idempotency and concurrency

The tick is safe to run twice at once (two workers, or a manual `run` beside a scheduled one) and safe to re-run
for the same minute:

| Write                       | Guard                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| break closure               | `UPDATE break_sessions … WHERE status = 'ACTIVE'`; events only for rows this call changed                                                                                                                                                                                                                                                                                                                                                                     |
| scheduled break start       | `clientBreakId = scheduled:<id>` unique; the shift row is `SELECT … FOR UPDATE` while a break starts. A unique violation is recovered by `startBreak` **after** the transaction rolled back (Postgres aborts the whole transaction on it): a `clientBreakId` race re-runs the transaction so the idempotency step returns the committed row, the one-active-per-shift index maps to `BREAK_ALREADY_ACTIVE`, and a key owned by another employee is `CONFLICT` |
| work-state row              | plain upsert of the latest evaluation (last writer wins — both compute the same thing)                                                                                                                                                                                                                                                                                                                                                                        |
| `DEVICE_SYNC_DELAYED`       | guarded update on the `attentionReason` marker — the same guard for ticks and on-demand evaluations (`GET /sync`, `recomputeEmployeeWorkState`)                                                                                                                                                                                                                                                                                                               |
| `POLICY_RESOLUTION_WARNING` | lookup by `(employee, metadata.resolutionWarningKey, 24 h)` before insert                                                                                                                                                                                                                                                                                                                                                                                     |
| `OVERRIDE_EXPIRED`          | guarded claim of `expiredEventEmittedAt`                                                                                                                                                                                                                                                                                                                                                                                                                      |
| digest                      | advisory lock + latest `COMPLIANCE_DIGEST` row within the hour                                                                                                                                                                                                                                                                                                                                                                                                |
| recurrences / completion    | owned by the shifts service, idempotent by construction                                                                                                                                                                                                                                                                                                                                                                                                       |

A tick never deletes anything and never writes device-reported fields.

## Report

```jsonc
{
  "now": "2026-10-06T08:00:00.000Z",
  "durationMs": 412,
  "organisations": 3,
  "employeesEvaluated": 41,
  "stateRowsChanged": 5,
  "transitions": 2,
  "breaksExpired": 1,
  "breaksEndedByShift": 0,
  "scheduledBreaksStarted": 1,
  "scheduledBreaksSkipped": 0,
  "syncDelayedEpisodes": 0,
  "resolutionWarnings": 0,
  "overridesExpired": 1,
  "digestsSent": 1,
  "recurrencesCreated": 0,
  "shiftsCompleted": 3,
  "errors": [], // organisation ids (or "overrides" / "recurrences" / "shifts") whose step failed
}
```

## Operations

- **A phone shows the wrong state**: compare `EmployeeWorkState.expectedState` (what the server computed at
  `expectedComputedAt`) with `reportedState` / `reportedAt` (what the phone last said). `source` tells you
  which one the dashboard is showing and why (rule above). `attentionReason` names the problem when the
  server already noticed.
- **Breaks that never end**: step 1 ends them at `plannedEndsAt` (or the shift end) on the next tick; the
  `BREAK_EXPIRED` event in the activity feed is the proof.
- **Overrides that expired silently**: step 4 catches up on the next tick, even days later
  (`occurredAt` is the original `expiresAt`).
- **No pushes**: `APNS_*` unset means the Noop provider (log lines `silent push … provider: noop`). Devices
  still re-sync on their own schedule (`GET /sync` on launch / foreground).
- **No digest**: there is one at most per hour per organisation, only for employees with a shift _today_
  (organisation / location time zone), only to OWNER / ADMIN members; email also needs
  `digestEmail !== false` on the membership.

## Tests

`apps/web/test/integration/workStateJob.test.ts` covers: evaluation + idempotent re-run, expired break
auto-end emitting `BREAK_EXPIRED` once, breaks of ended shifts, `OVERRIDE_EXPIRED` once (never for revoked
rows), `DEVICE_SYNC_DELAYED` once per episode, scheduled break start once, the hourly digest with the
in-app / email recipients and opt-out, `POLICY_RESOLUTION_WARNING` once per day, and the option flags the
worker's job split uses. The worker side is covered by `workerJobs.test.ts` (each job under its lock, two
workers firing the same minute run each job once, `schedule-upkeep` waits for the tick), `workerLocks.test.ts`,
`workerHeartbeat.test.ts` and `workerLiveness.test.ts`; the bridge by `pushBridge.test.ts` (debounced silent push
with the decrypted token, leadership loss). Run one with
`cd apps/web && npx dotenv -e ../../.env -c -- npx vitest run --project integration test/integration/workStateJob.test.ts`.
