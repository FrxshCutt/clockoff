# Break Rules (§6.3)

Source: `packages/shared/src/breaks/` (`breakRules.ts`, `breakTypes.ts`, `clockSkew.ts`).
Import: `@workmode/shared/breaks/breakRules` (re-exports the types and clock-skew helpers) or the
`@workmode/shared` barrel.

The break rules are pure functions over **absolute UTC instants**. They take no clock, perform no I/O and
never look at a timezone; the server passes its own `now`, and the device may run the same functions
against its cached policy for an optimistic UI. The server's answer is always the authoritative one.

## Vocabulary

| Term                                   | Meaning                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Break policy** (`BreakPolicyLike`)   | Mirror of the Prisma `BreakPolicy` row: `breaksEnabled`, `maxBreaksPerShift`, `maxBreakDurationMinutes`, `maxTotalBreakMinutes`, `minGapBetweenBreaksMinutes`, `minMinutesAfterShiftStart`, `employeeTriggeredAllowed`, `scheduledBreaksAllowed`, `restrictionBehaviour`, `relaxedCategories`. Use `breakPolicyFromRecord(row)` to parse the JSON `relaxedCategories` column. |
| **Shift window** (`ShiftWindowLike`)   | `{ id, startsAt, endsAt }`. Breaks must fit inside it.                                                                                                                                                                                                                                                                                                                        |
| **Break session** (`BreakSessionLike`) | `{ id, shiftId, startedAt, plannedEndsAt, endedAt?, status }`. Sessions whose `shiftId` differs from the shift are ignored.                                                                                                                                                                                                                                                   |
| **Effective end**                      | Where a session's time stops counting: `min(endedAt ?? plannedEndsAt, plannedEndsAt, shift.endsAt)`, never before `startedAt`. The Work Mode state machine ends a break at the same instant.                                                                                                                                                                                  |
| **Trigger** (`BreakTrigger`)           | `EMPLOYEE` (button in the app), `SCHEDULED` (a `ScheduledBreak` firing), `MANAGER` (manager console).                                                                                                                                                                                                                                                                         |
| **Allowance**                          | What is left for this shift: breaks and minutes.                                                                                                                                                                                                                                                                                                                              |

### How a session is read at instant `now`

`cap = min(plannedEndsAt, shift.endsAt)` (never before `startedAt`).

| Row                                        | Treated as                                         |
| ------------------------------------------ | -------------------------------------------------- |
| `endedAt` set (any status)                 | ended at `min(endedAt, cap)`                       |
| `status = ENDED`, no `endedAt` (defensive) | ended at `cap`                                     |
| `status = ACTIVE`, `cap <= now`            | **expired-but-not-closed** → ended at `cap`        |
| `status = ACTIVE`, `cap > now`             | in progress; has consumed `now − startedAt` so far |

A break therefore never counts past its `plannedEndsAt` or the shift end. A device that reports
`BREAK_ENDED` late, or with a clock that is behind, changes nothing in the allowance; a shift shortened
mid-break stops the break's minutes at the new shift end.

A session **blocks** a new break at `now` when its projected end (the row above, with a running session
projected to its `cap`) is after `now`. With the server's own `now` that is exactly "an unexpired running
break". When a _past_ instant is validated (a break the device started offline, see below) it also covers a
break that was running at that instant but has ended since, and a break recorded _after_ that instant:
**breaks never overlap**, and an offline break is never slotted in before a break the server already holds.

Every session counts as **one break taken**. Minutes are **rounded up per session** to whole minutes
(a 30-second break counts as 1 minute; a session whose effective end is at its start counts 0). Active
sessions count elapsed-so-far.

`maxTotalBreakMinutes = 0` means no break minutes at all (`BREAK_LIMIT_REACHED`), not "unlimited".

## `canStartBreak(input)`

```ts
canStartBreak({ policy, shift, existingSessions, now, requestedDurationMinutes?, trigger })
  → { ok: true, startsAt, plannedEndsAt, durationMinutes, remaining: { breaks, minutes }, behaviour }
  | { ok: false, code, message, details }
```

It never throws for input that matches its types; an instant that is not a valid `Date` is refused
with `VALIDATION_ERROR`. `code` is always an `ApiErrorCode` (`BREAK_REFUSAL_CODES`), so a refusal maps 1:1 onto
the API error envelope. `throwIfCannotStartBreak(input)` does exactly that conversion (`AppError` with the
same code / message / details; HTTP status from `ERROR_HTTP_STATUS`). `breakRefusalToAppError(refusal)`
converts a refusal you already hold.

### Precedence of checks

The first failing check decides the code. The order is: _policy gates → input → shift bounds → state →
limits → timing_, so the message always names the most fundamental reason.

| #   | Code                          | Condition                                                                                            | `details`                                                                                               |
| --- | ----------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | `BREAKS_DISABLED`             | `breaksEnabled` false                                                                                | `{ reason: "BREAKS_DISABLED" }`                                                                         |
| 1   | `BREAKS_DISABLED`             | `maxBreakDurationMinutes < 1` (policy allows no duration)                                            | `{ reason: "NO_BREAK_DURATION" }`                                                                       |
| 2   | `EMPLOYEE_BREAKS_NOT_ALLOWED` | trigger `EMPLOYEE` and `employeeTriggeredAllowed` false                                              | `{ trigger: "EMPLOYEE" }`                                                                               |
| 2   | `BREAKS_DISABLED`             | trigger `SCHEDULED` and `scheduledBreaksAllowed` false                                               | `{ reason: "SCHEDULED_BREAKS_NOT_ALLOWED" }`                                                            |
| 3   | `VALIDATION_ERROR`            | `now`, `shift.startsAt`/`endsAt` or an instant of one of this shift's sessions is not a valid `Date` | `{ field: "now" \| "shift.startsAt" \| "shift.endsAt" \| "existingSessions", value }` (session id)      |
| 3   | `VALIDATION_ERROR`            | `requestedDurationMinutes` present but not a whole number ≥ 1                                        | `{ field: "requestedDurationMinutes", value }`                                                          |
| 4   | `BREAK_TOO_LONG`              | `requestedDurationMinutes > maxBreakDurationMinutes`                                                 | `{ requestedDurationMinutes, maxBreakDurationMinutes }`                                                 |
| 5   | `NOT_ON_SHIFT`                | `now < shift.startsAt`                                                                               | `{ reason: "SHIFT_NOT_STARTED", shiftStartsAt, shiftEndsAt }`                                           |
| 5   | `NOT_ON_SHIFT`                | `now >= shift.endsAt`                                                                                | `{ reason: "SHIFT_ENDED", … }`                                                                          |
| 5   | `NOT_ON_SHIFT`                | less than 1 minute of shift left                                                                     | `{ reason: "SHIFT_ENDING", … }`                                                                         |
| 6   | `BREAK_ALREADY_ACTIVE`        | a session of this shift is running at `now`                                                          | `{ reason: "BREAK_IN_PROGRESS", sessionId, startedAt, plannedEndsAt }`                                  |
| 6   | `BREAK_ALREADY_ACTIVE`        | a session starts after `now` (only when validating a past instant)                                   | `{ reason: "LATER_BREAK_RECORDED", … }`                                                                 |
| 7   | `BREAK_LIMIT_REACHED`         | `breaksTaken >= maxBreaksPerShift`                                                                   | `{ reason: "MAX_BREAKS_PER_SHIFT", breaksTaken, maxBreaksPerShift, minutesUsed, maxTotalBreakMinutes }` |
| 7   | `BREAK_LIMIT_REACHED`         | `maxTotalBreakMinutes − minutesUsed < 1`                                                             | `{ reason: "MAX_TOTAL_BREAK_MINUTES", … }`                                                              |
| 8   | `BREAK_TOO_SOON`              | `now < shift.startsAt + minMinutesAfterShiftStart`                                                   | `{ reason: "MIN_MINUTES_AFTER_SHIFT_START", eligibleAt, waitMinutes }`                                  |
| 8   | `BREAK_TOO_SOON`              | `now < lastBreakEnd + minGapBetweenBreaksMinutes`                                                    | `{ reason: "MIN_GAP_BETWEEN_BREAKS", eligibleAt, waitMinutes }`                                         |

When several sessions block (step 6), the one that starts first is reported. `waitMinutes` is
`eligibleAt − now` rounded up to whole minutes (always ≥ 1).

Boundaries are inclusive on the eligible side: a break may start at exactly `startsAt + minMinutesAfterShiftStart`
and at exactly `lastBreakEnd + minGap`; one millisecond earlier is `BREAK_TOO_SOON`. `lastBreakEnd` is the
latest effective end across the shift's sessions (an expired-but-not-closed session ends at its cap). A
running session stops blocking at exactly its cap.

**Trigger differences**

- `MANAGER` bypasses **only** `EMPLOYEE_BREAKS_NOT_ALLOWED` and both `BREAK_TOO_SOON` rules. It never
  bypasses `breaksEnabled`, the input checks, the shift bounds, the active-break / no-overlap check, the
  per-break cap or the limits. Exceptional cases are what Overrides (§7) are for.
- `SCHEDULED` requires `scheduledBreaksAllowed` and is otherwise subject to every rule, including timing.
  The shift editor should validate scheduled-break offsets against the policy so a planned break is never
  silently refused.
- `EMPLOYEE` is subject to everything.

### Duration and `plannedEndsAt`

1. `duration = clampBreak(policy, requestedDurationMinutes, minutesRemaining)` =
   `min(requested ?? maxBreakDurationMinutes, maxBreakDurationMinutes, minutesRemaining)`, floored to whole
   minutes and never negative. An explicit request _above_ the per-break cap is refused (`BREAK_TOO_LONG`,
   step 4) rather than clamped, because it means the client is working from a stale policy. A request that
   exceeds only the _remaining total_ is clamped silently and the shortened `durationMinutes` is returned.
2. `startsAt = now` and `plannedEndsAt = min(now + duration, shift.endsAt)`. **A break never extends past
   the shift end.**
3. `durationMinutes = ceil((plannedEndsAt − now) / 1 min)` — the whole minutes this break counts against
   the allowance (the same rounding `computeBreakAllowance` applies later). It is always ≥ 1 and never more
   than `minutesRemaining`.
4. `remaining = { breaks: maxBreaksPerShift − breaksTaken − 1, minutes: minutesRemaining − durationMinutes }`,
   floored at 0 — exactly what `computeBreakAllowance` reports once this break has run in full (tested over a
   grid of policies, histories and instants).
5. `behaviour = resolveBreakBehaviour(policy)` — the snapshot to persist on the new `BreakSession`
   (`restrictionBehaviour`, `relaxedCategories`).

`plannedEndsAt` is an absolute UTC instant. Nothing about ending a break depends on the app being open,
the phone staying on, or the network: the server, the device's DeviceActivity schedule and the UI countdown
all derive from the same instant.

## `computeBreakAllowance(policy, shift, sessions, now, trigger = "EMPLOYEE")`

```ts
→ { breaksTaken, breaksRemaining, minutesUsed, minutesRemaining, nextEligibleAt: Date | null, canStartNow }
```

- `minutesUsed` follows the session rules above (ended = effective length, active = elapsed-so-far,
  rounded up per session).
- `breaksRemaining = maxBreaksPerShift − breaksTaken` and `minutesRemaining = maxTotalBreakMinutes − minutesUsed`,
  floored at 0. Both are **0 when the policy grants no breaks** (`breaksEnabled` false or
  `maxBreakDurationMinutes < 1`). A trigger that is not allowed (e.g. `employeeTriggeredAllowed` false) does
  not zero them: the allowance still exists for scheduled and manager breaks.
- `nextEligibleAt` is the earliest instant the given trigger could start another break, assuming no new
  break is recorded and a running break runs to its effective end. It is in the past **exactly when**
  `canStartNow` is true; when it is in the future, a break is refused one millisecond before it and allowed at
  it. It is `null` when no further break is possible this shift: breaks disabled, trigger not allowed, count
  exhausted, fewer than 1 minute of total allowance left once a running break has run in full, the eligible
  instant falls inside the last minute of the shift, or **the shift's last start instant (`endsAt − 1 min`)
  has passed**. It is never earlier than the end of the latest recorded break, for any trigger (no overlaps);
  for `EMPLOYEE` / `SCHEDULED` it also includes `minMinutesAfterShiftStart` and `minGapBetweenBreaksMinutes`.
- `canStartNow` is literally `canStartBreak({ …, trigger, now }).ok`.
- Throws `AppError("VALIDATION_ERROR")` when an instant is not a valid `Date` (a programming error).

## `expiredBreakSessionClosures(shift, sessions, now)`

```ts
→ Array<{ sessionId, endedAt, endReason: "EXPIRED" | "SHIFT_ENDED" }>   // ordered by startedAt
```

The `ACTIVE` sessions of `shift` (without `endedAt`) whose cap has passed, and the write that closes each:
`status = ENDED`, `endedAt` = its cap, `endReason = SHIFT_ENDED` when the shift end cut the break short
(the shift was shortened mid-break), otherwise `EXPIRED`. The rules already read these rows as ended there,
so persisting the closures never changes an allowance (tested). The server uses it in two places:

- the **periodic sweep** that auto-ends expired breaks;
- the **break-start transaction**, before inserting a new `ACTIVE` row: the partial unique index
  `break_sessions_one_active_per_shift` still sees an expired-but-unclosed row as `ACTIVE`, even though the
  rules (correctly) let a new break start.

## Restriction behaviour during a break

```ts
resolveBreakBehaviour(policy)            → { restrictionBehaviour, relaxedCategories }   // snapshot to store
breakRestrictionForSession(session)      → { restrictionBehaviour, relaxedCategories, effectiveRestriction, restrictionsShouldBeActive, liftedCategories }
isCategoryRelaxedDuringBreak(behaviour, category) → boolean
parseRelaxedCategories(json)             → RestrictionCategory[]   // unknown dropped, de-duplicated, canonical order
```

| `restrictionBehaviour`              | `effectiveRestriction` | `restrictionsShouldBeActive` | `liftedCategories`          |
| ----------------------------------- | ---------------------- | ---------------------------- | --------------------------- |
| `RELAX_ALL`                         | `BREAK_RELAXED`        | `false`                      | every `RestrictionCategory` |
| `RELAX_CATEGORIES` (≥ 1, not all)   | `BREAK_RELAXED`        | `true`                       | the listed categories       |
| `RELAX_CATEGORIES` (every category) | `BREAK_RELAXED`        | `false`                      | every `RestrictionCategory` |
| `RELAX_CATEGORIES` (empty list)     | `WORK`                 | `true`                       | none                        |
| `KEEP_RESTRICTIONS`                 | `WORK`                 | `true`                       | none                        |

This is the same mapping as the Work Mode state machine's `ON_BREAK` output (`computeExpectedState`, §6.2),
checked by a parity test. A break is never reported as `NONE`: `NONE` means "off shift" or a manager
override, and a relaxed break must not be confused with either.

`breakRestrictionForSession` reads the **session's stored snapshot**, never the live policy — see
"Policy change mid-break".

## Worked examples

Shift 09:00–15:00 UTC. Default policy: 2 breaks, 15 min each, 30 min total, 60 min gap, 60 min after start.

| `now`                   | Sessions                                  | Trigger            | Result                                                                         |
| ----------------------- | ----------------------------------------- | ------------------ | ------------------------------------------------------------------------------ |
| 09:00                   | —                                         | EMPLOYEE           | `BREAK_TOO_SOON` (MIN_MINUTES_AFTER_SHIFT_START, eligibleAt 10:00, wait 60)    |
| 09:59:59.999            | —                                         | EMPLOYEE           | `BREAK_TOO_SOON` (wait 1)                                                      |
| 10:00                   | —                                         | EMPLOYEE           | ok, 10:00–10:15, remaining { 1 break, 15 min }                                 |
| 09:00                   | —                                         | MANAGER            | ok, 09:00–09:15 (manager bypasses timing)                                      |
| 11:00                   | 10:00–10:15 ended                         | EMPLOYEE           | `BREAK_TOO_SOON` (MIN_GAP_BETWEEN_BREAKS, eligibleAt 11:15)                    |
| 11:15                   | 10:00–10:15 ended                         | EMPLOYEE           | ok, 11:15–11:30, remaining { 0, 0 }                                            |
| 10:45                   | 10:00–10:15, `endedAt` reported as 10:40  | EMPLOYEE           | 15 min used; next eligible 11:15 (late report capped at `plannedEndsAt`)       |
| 14:00                   | two ended breaks                          | any                | `BREAK_LIMIT_REACHED` (MAX_BREAKS_PER_SHIFT)                                   |
| 14:00                   | 15 + 15 min ended, policy allows 5 breaks | EMPLOYEE           | `BREAK_LIMIT_REACHED` (MAX_TOTAL_BREAK_MINUTES)                                |
| 14:00                   | 15 + 5 min ended, policy allows 5 breaks  | EMPLOYEE           | ok, clamped to 10 min (14:00–14:10)                                            |
| 14:59:00                | —                                         | EMPLOYEE           | ok, 14:59–15:00, `durationMinutes` 1                                           |
| 14:59:01                | —                                         | MANAGER            | `NOT_ON_SHIFT` (SHIFT_ENDING); allowance `nextEligibleAt` null                 |
| 14:58:30                | —                                         | EMPLOYEE           | ok, ends 15:00, `durationMinutes` 2 (90 s rounded up)                          |
| 15:00                   | 14:50 active                              | MANAGER            | `NOT_ON_SHIFT` (SHIFT_ENDED) — shift bound wins over the stale row             |
| 11:05                   | 11:00–11:15 active                        | MANAGER            | `BREAK_ALREADY_ACTIVE` (BREAK_IN_PROGRESS)                                     |
| 11:20                   | 10:00–10:15 **ACTIVE, never closed**      | EMPLOYEE           | ok — expired row counts as ended at 10:15; 15 min used; gap satisfied at 11:15 |
| 11:00 (validated later) | 11:05–11:20 already recorded              | EMPLOYEE / MANAGER | `BREAK_ALREADY_ACTIVE` (LATER_BREAK_RECORDED) — no overlaps                    |
| 12:00                   | — , `employeeTriggeredAllowed=false`      | EMPLOYEE / MANAGER | `EMPLOYEE_BREAKS_NOT_ALLOWED` / ok                                             |
| 12:00                   | — , `breaksEnabled=false`                 | any                | `BREAKS_DISABLED`                                                              |
| 12:00                   | — , request 16 min                        | EMPLOYEE           | `BREAK_TOO_LONG`                                                               |

## Edge cases and how they are handled

**Break immediately after shift start** — `BREAK_TOO_SOON` with `eligibleAt = startsAt + minMinutesAfterShiftStart`.
The device can show "available at 10:00" straight from `details.eligibleAt`, or from `computeBreakAllowance().nextEligibleAt`.

**Limit reached** — `BREAK_LIMIT_REACHED`; `details.reason` says whether it was the count or the total minutes.
Limits beat timing in precedence so the employee is never told to "wait 15 minutes" for a break they cannot have.

**Closing the app / phone restart / internet loss** — `plannedEndsAt` is absolute. The device schedules the
end of the relaxation with DeviceActivity at that instant (device clock, see below) and the rules treat any
`ACTIVE` row whose `plannedEndsAt` has passed as ended at `plannedEndsAt`. A device that reconnects and
reports `BREAK_ENDED` late changes nothing in the allowance (the effective end is capped at `plannedEndsAt`);
a device that never reports it still gets the right allowance. The sweep persists the end with
`expiredBreakSessionClosures` (`endReason = EXPIRED`).

**Shift ends mid-break** — impossible for an approved break (`plannedEndsAt ≤ shift.endsAt`). If a shift is
_shortened_ while a break is running, the break's minutes stop at the new `endsAt` straight away, the
device's schedule-sync applies the new end, and `expiredBreakSessionClosures` closes the session at the new
shift end with `endReason = SHIFT_ENDED`. Any attempt after `endsAt` is `NOT_ON_SHIFT`, and the allowance's
`nextEligibleAt` is `null`.

**Policy change mid-break** — the running break completes under the behaviour snapshot stored on the
`BreakSession` (`restrictionBehaviour`, `relaxedCategories`, taken from `canStartBreak().behaviour`).
`breakRestrictionForSession` only ever reads that snapshot. The **next** break is evaluated against the
new policy: `computeBreakAllowance(newPolicy, …)` and `canStartBreak({ policy: newPolicy, … })` use the new
limits against the same session history, so a tightened limit can mean no further breaks today.

**Timezone change** — every input is a `Date` (an instant). Two callers describing the same instant in
different offsets get byte-identical results (tested). Shift rows carry a `timezone` for display only.

**Device clock manipulation** — see "Clock skew" below. Eligibility is always decided on a server-clock
instant: the server's receive time, or for a break the device started offline the tap time converted to
server time (`breakStartInstant`), which is never later than the receive time. A phone set 45 minutes ahead
that believes it is past `minMinutesAfterShiftStart` is still refused `BREAK_TOO_SOON`; a phone set back
cannot stretch a break, because `plannedEndsAt` was fixed by the server and a late `endedAt` is capped
(all tested).

**Invalid input** — an instant that is not a valid `Date` is refused with `VALIDATION_ERROR` rather than
producing a break with an invalid end; the other functions throw `AppError("VALIDATION_ERROR")`.

## Starting a break through the API (online and offline)

The mobile contract (`packages/validation/src/mobile.ts`, route registry) is:

```
POST /api/mobile/v1/breaks/start   { clientBreakId, shiftId, requestedAt, requestedDurationMinutes? }
  → 201 { breakSession, allowance }   |   error envelope { error: { code, message, details } }
POST /api/mobile/v1/breaks/:id/end  { endedAt, reason: "EMPLOYEE_ENDED" | "EXPIRED" | "SHIFT_ENDED" }
  → 200 { breakSession, allowance }
```

`requestedAt` is the device time of the tap. The request has no trigger: the mobile endpoint is always
`EMPLOYEE`. The manager console uses `MANAGER`; a firing `ScheduledBreak` uses `SCHEDULED` with
`requestedDurationMinutes = durationMinutes`.

A device may start a break while offline using its **cached policy** and its own `canStartBreak` result
(optimistic). It sends the same request when it reconnects, with the original `clientBreakId` and
`requestedAt`. The handler is the same for both cases. In one transaction, serialised per shift (for example
`SELECT … FOR UPDATE` on the shift row), with `receivedAt` = the server clock:

1. **Idempotency** — if a session with this `clientBreakId` exists, return it (with a fresh allowance)
   unchanged. No second row is ever created for the same `clientBreakId`; a unique violation on
   `client_break_id` from a concurrent retry is answered the same way.
2. **Load** the shift (it must belong to the employee), the break policy **currently assigned** to the
   employee (`breakPolicyFromRecord`, not the one the device cached) and the shift's sessions.
3. **Close expired rows** — persist `expiredBreakSessionClosures(shift, sessions, receivedAt)`. This is
   required before step 6 because of `break_sessions_one_active_per_shift`.
4. **Start instant** — `startAt = breakStartInstant(requestedAt, receivedAt, device.lastClockSkewSeconds)`
   = `min(receivedAt, requestedAt − skew)`. Online this is the receive time minus network latency. For an
   offline break it is the moment the employee tapped, on the server clock, so the break is checked and
   counted where it really happened instead of being granted again from `receivedAt`. It is never in the
   future. Backdating cannot gain anything: an earlier start is checked against the same history and ends
   earlier (tested).
5. **Validate** — `throwIfCannotStartBreak({ policy, shift, existingSessions, now: startAt, requestedDurationMinutes, trigger: "EMPLOYEE" })`.
   Validating a past instant is the same call: a break the server already holds at or after `startAt` refuses
   with `BREAK_ALREADY_ACTIVE` (`BREAK_IN_PROGRESS` / `LATER_BREAK_RECORDED`). A refusal is returned as the
   ordinary error envelope and **nothing is written**. For an offline break the device ends its local break
   at once and shows the message; its own `BREAK_STARTED` / `BREAK_ENDED` events (`POST /events`) remain the
   record of what happened on the phone. Writing a session for a refused break would overlap a recorded
   break or fall outside the shift.
6. **Insert** — `startedAt = approval.startsAt`, `plannedEndsAt`, `restrictionBehaviour` /
   `relaxedCategories` from `approval.behaviour`, `breakPolicyId`, `deviceId`, `clientBreakId`. `status` is
   `ACTIVE` when `plannedEndsAt > receivedAt`; otherwise (an offline break that has already run its course)
   `ENDED` with `endedAt = plannedEndsAt` and `endReason = EXPIRED`. A unique violation on
   `break_sessions_one_active_per_shift` (two different starts racing) maps to `BREAK_ALREADY_ACTIVE`.
7. **Respond** 201 with the session and `computeBreakAllowance(policy, shift, sessionsAfterWrites, receivedAt)`.

**Ending a break** — the end handler should store
`endedAt = clamp(deviceInstantToServerTime(endedAt, skew), startedAt, min(plannedEndsAt, shift.endsAt, receivedAt))`.
The rules apply the same cap (except `receivedAt`) when they count, so a late or skewed report can never
change the allowance, even if it is stored unclamped.

## DeviceActivity: the under-15-minute limitation

Apple's DeviceActivity framework refuses to monitor a `DeviceActivitySchedule` shorter than **15 minutes**
(`DeviceActivityCenter.MonitoringError.intervalTooShort`), and it runs on the **device clock**. Consequences:

- While the app is open, the app ends the break at `plannedEndsAt` itself; precision is not an issue.
- If the app is closed during a break shorter than 15 minutes, the monitor extension restores restrictions
  **within 15 minutes** of the break start, not exactly at `plannedEndsAt`. The server-side state is still
  exact; only the on-device enforcement lags. `isBelowDeviceActivityInterval(durationMinutes)` and
  `DEVICE_ACTIVITY_MIN_RELIABLE_INTERVAL_MINUTES` let the UI say so ("Keep the app open to end your break on time").
- The device must also schedule a plain `plannedEndsAt` boundary so that for breaks ≥ 15 minutes the end is
  honoured precisely even with the app closed.
- Schedules are built from `DateComponents`. The device should reschedule when the phone's time zone
  changes (or give the components an explicit time zone), so that a time-zone change does not move the
  wall-clock end of a running break.
- Managers should be told, in policy settings, that `maxBreakDurationMinutes < 15` gives slightly fuzzy
  on-device enforcement when the app is in the background.

## Clock skew

- **Server timestamps are authoritative.** Every `BreakSession` instant is written by the server; the device's
  own clock is never used to decide eligibility (an offline tap time is first converted to server time).
- **The device reports its clock** on each device-state sync; `computeClockSkewSeconds` stores the
  difference as `Device.lastClockSkewSeconds` (positive = device ahead).
- **DeviceActivity follows the device clock.** Apple schedules `DeviceActivitySchedule` intervals against the
  phone's own clock, not network time. If a phone is 20 minutes ahead, its break ends 20 real minutes early;
  if it is behind, the break ends late and restrictions are lifted longer than the policy allows. The server
  cannot correct a schedule that runs on a wrong clock, so skew is **surfaced, not hidden**:
  `clockSkewNeedsAttention(skewSeconds)` is `true` when `|skew| > CLOCK_SKEW_ATTENTION_THRESHOLD_SECONDS`
  (= `DEVICE_STATUS_THRESHOLDS.clockSkewSeconds`, 300 s — one constant shared with `deriveDeviceStatus`), and
  the manager badge derives to `NEEDS_ATTENTION` with the reason "Device clock is N s ahead of / behind
  server time".
- **Recommendation to employees** (shown in the app when skew is detected): Settings → General → Date & Time →
  turn on **Set Automatically**. iOS then keeps the clock in step with network time.
- Changing the time zone is **not** skew: the instant is unchanged, only its display differs. Skew only means
  the device's idea of "now" differs from the server's.

Helpers (`packages/shared/src/breaks/clockSkew.ts`):

```ts
computeClockSkewSeconds(deviceReportedAt, serverReceivedAt) → number   // + = device ahead; whole seconds
deviceInstantToServerTime(deviceInstant, skewSeconds)       → Date     // deviceInstant − skew (NaN skew → unchanged)
breakStartInstant(requestedAt, receivedAt, skewSeconds)     → Date     // min(receivedAt, requestedAt − skew); null skew → 0
clockSkewNeedsAttention(skewSeconds, threshold?)            → boolean  // |skew| > 300 s; null/NaN → false
isBelowDeviceActivityInterval(durationMinutes)              → boolean  // < 15 min
CLOCK_SKEW_ATTENTION_THRESHOLD_SECONDS = 300, DEVICE_ACTIVITY_MIN_RELIABLE_INTERVAL_MINUTES = 15
```
