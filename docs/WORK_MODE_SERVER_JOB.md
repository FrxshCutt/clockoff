# Work Mode server job (§10)

The server-side half of Work Mode: a tick that runs every minute, keeps every employee's
`EmployeeWorkState` in step with the state machine, emits the ActivityEvents only the server can know
about, starts scheduled breaks, expires overrides, nudges phones to re-sync and sends the manager digest.
Read `WORK_MODE_STATE_MACHINE.md` (what "expected state" means) and `BREAK_RULES.md` (how a break is
read) first.

Code: `apps/web/src/server/workState/workStateJob.ts` (`runWorkModeTick`), `apps/web/src/jobs/main.ts`
(the runner), `apps/web/src/app/api/jobs/tick/route.ts` (HTTP trigger),
`apps/web/src/server/realtime/pushBridge.ts` (bus → silent push), `apps/web/src/server/digest/` (digest).

## Running it

| How | When to use it |
| --- | --- |
| `pnpm --filter @workmode/web jobs` (`tsx src/jobs/main.ts`) | The default: a long-running process beside the web app. node-cron `* * * * *` while `JOBS_ENABLED` is `true` (default). Runs one tick immediately at start-up so a fresh deploy catches up. |
| `POST /api/jobs/tick` with `Authorization: Bearer <CRON_SECRET>` | Platforms with an external scheduler (Vercel Cron, GitHub Actions, Kubernetes CronJob). Set `JOBS_ENABLED=false` on the web app in that case. The route has `maxDuration = 300`. Response: `{ ok: true, report }`. |

Both may run at the same time: every write in the tick is guarded (see *Idempotency*), so overlapping
ticks never double-emit. The in-process runner also has an overlap guard — a tick still running when the
next minute fires is skipped with a warning (nothing is lost; the next tick catches up).

Shutdown: `SIGTERM` / `SIGINT` stop the scheduler, let the running tick finish, flush debounced pushes
and disconnect Prisma. Logs are structured pino lines (`module: "jobs"` / `"workModeTick"`), ids and counts
only — never names, emails or tokens.

Environment: `JOBS_ENABLED`, `CRON_SECRET` (32+ chars in production), `APNS_*` for real pushes
(otherwise the Noop provider logs and drops them), email provider settings for the digest. See
`ENVIRONMENT.md`.

## What one tick does

`runWorkModeTick(now)` runs these steps in order and returns a `WorkModeTickReport` with a counter per step
and the ids of organisations whose evaluation failed (`errors`; the others continue).

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

| Column | Value |
| --- | --- |
| `expectedState`, `expectedRestriction` | `ExpectedState.state` / `.effectiveRestriction` |
| `expectedComputedAt` | `now` |
| `nextTransitionAt` | `ExpectedState.nextTransitionAt` (null when nothing is scheduled) |
| `activeShiftId`, `activeBreakSessionId` | from the expected state |
| `breaksTakenCount`, `breakMinutesUsed` | sessions of the active shift so far, each read as the break rules read it (`min(endedAt ?? now, plannedEndsAt, shift.endsAt)`) |
| `state`, `stateSince`, `source` | the **displayed state** — rule below |
| `attentionReason` | the badge's reason when it needs a manager — rule below |
| `lastUpdatedAt` | `now` |

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

Thresholds live in `DEVICE_STATUS_THRESHOLDS` (`@workmode/shared/status/deriveDeviceStatus`).

**Server-owned ActivityEvents** emitted by this step:

| Event | When | Dedupe guard |
| --- | --- | --- |
| `DEVICE_SYNC_DELAYED` | the badge becomes `SYNC_DELAYED` / `OFFLINE` | once per episode: the write that first stores the `Device sync delayed` marker in `attentionReason` is a guarded `UPDATE … WHERE attention_reason NOT LIKE '%marker%'`; only the tick whose update affected a row records the event. The episode ends when the device syncs again (marker cleared) and a new silence starts a new one. |
| `POLICY_RESOLUTION_WARNING` | `resolveForEmployees` reports `AMBIGUOUS_TEAM_ASSIGNMENT` | once per `(employee, kind:resolutionWarningKey)` per 24 h, keyed in `metadata.resolutionWarningKey`. |

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
counted in `errors` without stopping the tick.

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

The in-process bus is keyed by organisation, so the job process bridges every organisation with an active
device at start-up (`startPushBridge`), and the web process bridges lazily (`ensureOrganisationBridged`)
from the mobile endpoints, the overrides service, the SSE route and each tick. On shutdown
`flushPushBridge()` delivers what is still pending.

## Idempotency and concurrency

The tick is safe to run twice at once (node-cron and an external cron, or two replicas) and safe to re-run
for the same minute:

| Write | Guard |
| --- | --- |
| break closure | `UPDATE break_sessions … WHERE status = 'ACTIVE'`; events only for rows this call changed |
| scheduled break start | `clientBreakId = scheduled:<id>` unique; the shift row is `SELECT … FOR UPDATE` while a break starts |
| work-state row | plain upsert of the latest evaluation (last writer wins — both compute the same thing) |
| `DEVICE_SYNC_DELAYED` | guarded update on the `attentionReason` marker |
| `POLICY_RESOLUTION_WARNING` | lookup by `(employee, metadata.resolutionWarningKey, 24 h)` before insert |
| `OVERRIDE_EXPIRED` | guarded claim of `expiredEventEmittedAt` |
| digest | advisory lock + latest `COMPLIANCE_DIGEST` row within the hour |
| recurrences / completion | owned by the shifts service, idempotent by construction |

A tick never deletes anything and never writes device-reported fields.

## Report

```jsonc
{
  "now": "2026-10-06T08:00:00.000Z", "durationMs": 412,
  "organisations": 3, "employeesEvaluated": 41, "stateRowsChanged": 5, "transitions": 2,
  "breaksExpired": 1, "breaksEndedByShift": 0, "scheduledBreaksStarted": 1, "scheduledBreaksSkipped": 0,
  "syncDelayedEpisodes": 0, "resolutionWarnings": 0, "overridesExpired": 1, "digestsSent": 1,
  "recurrencesCreated": 0, "shiftsCompleted": 3,
  "errors": []            // organisation ids (or "overrides" / "recurrences" / "shifts") whose step failed
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
- **No digest**: there is one at most per hour per organisation, only for employees with a shift *today*
  (organisation / location time zone), only to OWNER / ADMIN members; email also needs
  `digestEmail !== false` on the membership.

## Tests

`apps/web/test/integration/workStateJob.test.ts` covers: evaluation + idempotent re-run, expired break
auto-end emitting `BREAK_EXPIRED` once, breaks of ended shifts, `OVERRIDE_EXPIRED` once (never for revoked
rows), `DEVICE_SYNC_DELAYED` once per episode, scheduled break start once, the hourly digest with the
in-app / email recipients and opt-out, `POLICY_RESOLUTION_WARNING` once per day, the push bridge's
debounced silent push with the decrypted token, and `POST /api/jobs/tick` authentication. Run it with
`cd apps/web && npx dotenv -e ../../.env -c -- npx vitest run --project integration test/integration/workStateJob.test.ts`.
