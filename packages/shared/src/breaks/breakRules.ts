/**
 * Break rules (§6.3). Pure functions over absolute UTC instants — no I/O, no clocks, no timezones.
 * The server passes its own `now`; the device may evaluate the same functions against its cached policy
 * for optimistic UI, but the server result is authoritative (see docs/BREAK_RULES.md).
 *
 * Check precedence in `canStartBreak` (first failing check wins):
 *   1. BREAKS_DISABLED              policy.breaksEnabled false, or no usable break duration
 *   2. EMPLOYEE_BREAKS_NOT_ALLOWED  trigger EMPLOYEE while employeeTriggeredAllowed is false
 *      BREAKS_DISABLED              trigger SCHEDULED while scheduledBreaksAllowed is false (reason SCHEDULED_BREAKS_NOT_ALLOWED)
 *   3. VALIDATION_ERROR             an instant is not a valid Date, or requestedDurationMinutes is present but
 *                                   not a whole number ≥ 1
 *   4. BREAK_TOO_LONG               requestedDurationMinutes > maxBreakDurationMinutes
 *   5. NOT_ON_SHIFT                 now < shift.startsAt / now ≥ shift.endsAt / < 1 minute of shift left
 *   6. BREAK_ALREADY_ACTIVE         a session of this shift is still running at `now` (or, when a past instant is
 *                                   re-validated, a later break is already recorded — breaks never overlap)
 *   7. BREAK_LIMIT_REACHED          maxBreaksPerShift used up, or < 1 minute of maxTotalBreakMinutes left
 *   8. BREAK_TOO_SOON               minMinutesAfterShiftStart / minGapBetweenBreaksMinutes (skipped for MANAGER)
 * MANAGER bypasses 2 and 8 only — never policy enablement, shift bounds, the active-break check or the limits.
 *
 * A session's time counts from `startedAt` to its effective end `min(endedAt ?? plannedEndsAt, plannedEndsAt,
 * shift.endsAt)` (never before `startedAt`), the same end the Work Mode state machine uses.
 */
import { RESTRICTION_CATEGORIES } from "../enums";
import type {
  BreakRestrictionBehaviour,
  EffectiveRestriction,
  RestrictionCategory,
} from "../enums";
import { AppError } from "../errors";
import type {
  BreakAllowance,
  BreakBehaviour,
  BreakPolicyLike,
  BreakPolicyRecordLike,
  BreakRefusal,
  BreakRestriction,
  BreakSessionClosure,
  BreakSessionLike,
  BreakStartApproval,
  BreakTrigger,
  CanStartBreakInput,
  CanStartBreakResult,
  ShiftWindowLike,
} from "./breakTypes";

export * from "./breakTypes";
export * from "./clockSkew";

const MS_PER_MINUTE = 60_000;

/** A break shorter than this is never started; a shift with less than this left refuses breaks (SHIFT_ENDING). */
export const MIN_BREAK_DURATION_MINUTES = 1;

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`);
}

function minutesToMs(minutes: number): number {
  return minutes * MS_PER_MINUTE;
}

/** Whole minutes, rounded up; never negative. */
function ceilMinutes(ms: number): number {
  return ms <= 0 ? 0 : Math.ceil(ms / MS_PER_MINUTE);
}

function isValidInstant(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

// ─────────────────────────────────────────────────────────────────────────────
// Session accounting
// ─────────────────────────────────────────────────────────────────────────────

interface SessionSpan {
  session: BreakSessionLike;
  startMs: number;
  /** Effective end for accounting so far: the session's end, or `now` while it is running. */
  endMs: number;
  /** The session's effective end (for a running session: where it will stop). Equal to `endMs` once over. */
  projectedEndMs: number;
}

/**
 * Resolves what a session means at `now`. Its time is capped at `min(plannedEndsAt, shift.endsAt)` (and
 * never ends before it starts):
 * - any session with `endedAt` is ended at `endedAt` (capped), whatever `status` says;
 * - ENDED without `endedAt` (defensive) is ended at the cap;
 * - ACTIVE whose cap has passed ("expired-but-not-closed": app killed, offline, phone restarted, shift
 *   shortened) is ended at the cap — the planned end is an absolute instant and needs no device report;
 * - ACTIVE otherwise is in progress and has consumed `now − startedAt` so far.
 */
function spanOf(session: BreakSessionLike, nowMs: number, shiftEndMs: number): SessionSpan {
  const startMs = session.startedAt.getTime();
  const capMs = Math.max(startMs, Math.min(session.plannedEndsAt.getTime(), shiftEndMs));
  if (session.endedAt) {
    const endMs = Math.max(startMs, Math.min(session.endedAt.getTime(), capMs));
    return { session, startMs, endMs, projectedEndMs: endMs };
  }
  switch (session.status) {
    case "ENDED":
      return { session, startMs, endMs: capMs, projectedEndMs: capMs };
    case "ACTIVE":
      if (capMs <= nowMs) return { session, startMs, endMs: capMs, projectedEndMs: capMs };
      return { session, startMs, endMs: Math.max(startMs, nowMs), projectedEndMs: capMs };
    default:
      return assertNever(session.status);
  }
}

interface ShiftBreakSummary {
  /**
   * The session that prevents a break from starting at `now`: the earliest-starting session whose projected
   * end is after `now`. With a server `now` that is exactly an unexpired running break; when a past instant
   * is re-validated (offline reconciliation) it can also be a break recorded after that instant.
   */
  blocking: SessionSpan | null;
  breaksTaken: number;
  /** Rounded up per session; running sessions by elapsed-so-far. */
  minutesUsed: number;
  /** Same, but a running session is counted to its effective end. */
  projectedMinutesUsed: number;
  /** Latest projected end across sessions, or null when there are none. */
  lastEndMs: number | null;
}

function sessionsOfShift(
  sessions: readonly BreakSessionLike[],
  shift: ShiftWindowLike,
): BreakSessionLike[] {
  return sessions.filter((s) => s.shiftId === shift.id);
}

function summarise(
  sessions: readonly BreakSessionLike[],
  shift: ShiftWindowLike,
  nowMs: number,
): ShiftBreakSummary {
  const shiftEndMs = shift.endsAt.getTime();
  let blocking: SessionSpan | null = null;
  let breaksTaken = 0;
  let minutesUsed = 0;
  let projectedMinutesUsed = 0;
  let lastEndMs: number | null = null;
  for (const session of sessionsOfShift(sessions, shift)) {
    const span = spanOf(session, nowMs, shiftEndMs);
    breaksTaken += 1;
    minutesUsed += ceilMinutes(span.endMs - span.startMs);
    projectedMinutesUsed += ceilMinutes(span.projectedEndMs - span.startMs);
    if (lastEndMs === null || span.projectedEndMs > lastEndMs) lastEndMs = span.projectedEndMs;
    if (span.projectedEndMs > nowMs && (blocking === null || span.startMs < blocking.startMs))
      blocking = span;
  }
  return { blocking, breaksTaken, minutesUsed, projectedMinutesUsed, lastEndMs };
}

/**
 * Every instant the rules read must be a valid `Date`; otherwise the arithmetic silently produces NaN and
 * an approval with an invalid `plannedEndsAt`. Only this shift's sessions are checked.
 */
function invalidInstantRefusal(
  shift: ShiftWindowLike,
  sessions: readonly BreakSessionLike[],
  now: Date,
): BreakRefusal | null {
  const message = (what: string) => `${what} must be a valid instant.`;
  if (!isValidInstant(now))
    return refuse("VALIDATION_ERROR", message("now"), { field: "now", value: now });
  if (!isValidInstant(shift.startsAt))
    return refuse("VALIDATION_ERROR", message("shift.startsAt"), {
      field: "shift.startsAt",
      value: shift.startsAt,
    });
  if (!isValidInstant(shift.endsAt))
    return refuse("VALIDATION_ERROR", message("shift.endsAt"), {
      field: "shift.endsAt",
      value: shift.endsAt,
    });
  for (const s of sessionsOfShift(sessions, shift)) {
    const endedAtOk = s.endedAt === null || s.endedAt === undefined || isValidInstant(s.endedAt);
    if (!isValidInstant(s.startedAt) || !isValidInstant(s.plannedEndsAt) || !endedAtOk) {
      return refuse(
        "VALIDATION_ERROR",
        "Every break session must have valid startedAt / plannedEndsAt / endedAt instants.",
        { field: "existingSessions", value: s.id },
      );
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minutes a break may run for: `min(requested ?? maxBreakDuration, maxBreakDuration, remainingAllowance)`,
 * floored to whole minutes and never negative. Pure helper; the shift-end clamp lives in `canStartBreak`.
 */
export function clampBreak(
  policy: Pick<BreakPolicyLike, "maxBreakDurationMinutes">,
  requestedDurationMinutes: number | null | undefined,
  remainingAllowanceMinutes: number,
): number {
  const perBreakMax = wholeMinutes(policy.maxBreakDurationMinutes);
  const requested =
    requestedDurationMinutes === null || requestedDurationMinutes === undefined
      ? perBreakMax
      : wholeMinutes(requestedDurationMinutes);
  return Math.min(requested, perBreakMax, wholeMinutes(remainingAllowanceMinutes));
}

function wholeMinutes(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function policyGrantsBreaks(policy: BreakPolicyLike): boolean {
  return (
    policy.breaksEnabled &&
    wholeMinutes(policy.maxBreakDurationMinutes) >= MIN_BREAK_DURATION_MINUTES
  );
}

function triggerAllowed(policy: BreakPolicyLike, trigger: BreakTrigger): boolean {
  switch (trigger) {
    case "EMPLOYEE":
      return policy.employeeTriggeredAllowed;
    case "SCHEDULED":
      return policy.scheduledBreaksAllowed;
    case "MANAGER":
      return true;
    default:
      return assertNever(trigger);
  }
}

/**
 * Decides whether a break may start at `input.now` and, if so, exactly when it must end. Never throws for
 * input that matches its types; an instant that is not a valid `Date` is refused with VALIDATION_ERROR.
 */
export function canStartBreak(input: CanStartBreakInput): CanStartBreakResult {
  const { policy, shift, now, trigger } = input;

  // 1–2. Policy-level gates (independent of time and state).
  if (!policy.breaksEnabled) {
    return refuse("BREAKS_DISABLED", "Breaks are disabled by the break policy.", {
      reason: "BREAKS_DISABLED",
    });
  }
  if (!policyGrantsBreaks(policy)) {
    return refuse("BREAKS_DISABLED", "The break policy allows no break duration.", {
      reason: "NO_BREAK_DURATION",
    });
  }
  if (!triggerAllowed(policy, trigger)) {
    switch (trigger) {
      case "EMPLOYEE":
        return refuse(
          "EMPLOYEE_BREAKS_NOT_ALLOWED",
          "Employees cannot start breaks under this break policy.",
          { trigger: "EMPLOYEE" },
        );
      case "SCHEDULED":
        return refuse("BREAKS_DISABLED", "Scheduled breaks are not allowed by the break policy.", {
          reason: "SCHEDULED_BREAKS_NOT_ALLOWED",
        });
      case "MANAGER":
        break; // always allowed
      default:
        return assertNever(trigger);
    }
  }

  // 3–4. Input checks.
  const invalid = invalidInstantRefusal(shift, input.existingSessions, now);
  if (invalid) return invalid;
  const requested = input.requestedDurationMinutes ?? null;
  if (requested !== null) {
    if (
      typeof requested !== "number" ||
      !Number.isInteger(requested) ||
      requested < MIN_BREAK_DURATION_MINUTES
    ) {
      return refuse(
        "VALIDATION_ERROR",
        "requestedDurationMinutes must be a whole number of minutes ≥ 1.",
        { field: "requestedDurationMinutes", value: requested },
      );
    }
    if (requested > policy.maxBreakDurationMinutes) {
      return refuse(
        "BREAK_TOO_LONG",
        `Breaks are limited to ${policy.maxBreakDurationMinutes} minutes under this break policy.`,
        {
          requestedDurationMinutes: requested,
          maxBreakDurationMinutes: policy.maxBreakDurationMinutes,
        },
      );
    }
  }

  // 5. Shift bounds — nobody bypasses these.
  const nowMs = now.getTime();
  const shiftStartMs = shift.startsAt.getTime();
  const shiftEndMs = shift.endsAt.getTime();
  const shiftDetails = { shiftStartsAt: shift.startsAt, shiftEndsAt: shift.endsAt };
  if (nowMs < shiftStartMs) {
    return refuse("NOT_ON_SHIFT", "The shift has not started yet.", {
      reason: "SHIFT_NOT_STARTED",
      ...shiftDetails,
    });
  }
  if (nowMs >= shiftEndMs) {
    return refuse("NOT_ON_SHIFT", "The shift has ended.", {
      reason: "SHIFT_ENDED",
      ...shiftDetails,
    });
  }
  if (shiftEndMs - nowMs < minutesToMs(MIN_BREAK_DURATION_MINUTES)) {
    return refuse("NOT_ON_SHIFT", "The shift is ending; there is no time left for a break.", {
      reason: "SHIFT_ENDING",
      ...shiftDetails,
    });
  }

  // 6. Active break (breaks never overlap).
  const summary = summarise(input.existingSessions, shift, nowMs);
  if (summary.blocking) {
    const { session, startMs } = summary.blocking;
    const inProgress = startMs <= nowMs;
    return refuse(
      "BREAK_ALREADY_ACTIVE",
      inProgress
        ? "A break is already in progress."
        : "A later break is already recorded for this shift.",
      {
        reason: inProgress ? "BREAK_IN_PROGRESS" : "LATER_BREAK_RECORDED",
        sessionId: session.id,
        startedAt: session.startedAt,
        plannedEndsAt: session.plannedEndsAt,
      },
    );
  }

  // 7. Limits.
  const limitDetails = {
    breaksTaken: summary.breaksTaken,
    maxBreaksPerShift: policy.maxBreaksPerShift,
    minutesUsed: summary.minutesUsed,
    maxTotalBreakMinutes: policy.maxTotalBreakMinutes,
  };
  if (summary.breaksTaken >= policy.maxBreaksPerShift) {
    return refuse(
      "BREAK_LIMIT_REACHED",
      `All ${policy.maxBreaksPerShift} breaks for this shift have been used.`,
      { reason: "MAX_BREAKS_PER_SHIFT", ...limitDetails },
    );
  }
  const minutesRemaining = Math.max(0, policy.maxTotalBreakMinutes - summary.minutesUsed);
  if (minutesRemaining < MIN_BREAK_DURATION_MINUTES) {
    return refuse(
      "BREAK_LIMIT_REACHED",
      `All ${policy.maxTotalBreakMinutes} break minutes for this shift have been used.`,
      { reason: "MAX_TOTAL_BREAK_MINUTES", ...limitDetails },
    );
  }

  // 8. Timing (MANAGER bypasses).
  if (trigger !== "MANAGER") {
    const afterStartMs = shiftStartMs + minutesToMs(policy.minMinutesAfterShiftStart);
    if (nowMs < afterStartMs) {
      return tooSoon(
        "MIN_MINUTES_AFTER_SHIFT_START",
        afterStartMs,
        nowMs,
        policy.minMinutesAfterShiftStart,
      );
    }
    if (summary.lastEndMs !== null) {
      const gapMs = summary.lastEndMs + minutesToMs(policy.minGapBetweenBreaksMinutes);
      if (nowMs < gapMs)
        return tooSoon("MIN_GAP_BETWEEN_BREAKS", gapMs, nowMs, policy.minGapBetweenBreaksMinutes);
    }
  }

  // Duration: per-break cap, then total allowance, then the shift end (never past it). Both clamps keep at
  // least one minute (checks 5 and 7), so `durationMinutes` is always ≥ 1 and ≤ the remaining allowance.
  const durationMinutes = clampBreak(policy, requested, minutesRemaining);
  const plannedEndMs = Math.min(nowMs + minutesToMs(durationMinutes), shiftEndMs);
  const countedMinutes = ceilMinutes(plannedEndMs - nowMs);
  return {
    ok: true,
    startsAt: new Date(nowMs),
    plannedEndsAt: new Date(plannedEndMs),
    durationMinutes: countedMinutes,
    remaining: {
      breaks: Math.max(0, policy.maxBreaksPerShift - summary.breaksTaken - 1),
      minutes: Math.max(0, minutesRemaining - countedMinutes),
    },
    behaviour: resolveBreakBehaviour(policy),
  };
}

function refuse<C extends BreakRefusal["code"]>(
  code: C,
  message: string,
  details: Extract<BreakRefusal, { code: C }>["details"],
): BreakRefusal {
  return { ok: false, code, message, details } as BreakRefusal;
}

function tooSoon(
  reason: "MIN_MINUTES_AFTER_SHIFT_START" | "MIN_GAP_BETWEEN_BREAKS",
  eligibleMs: number,
  nowMs: number,
  ruleMinutes: number,
): BreakRefusal {
  const waitMinutes = ceilMinutes(eligibleMs - nowMs);
  const message =
    reason === "MIN_MINUTES_AFTER_SHIFT_START"
      ? `Breaks can start ${ruleMinutes} minutes after the shift begins (in ${waitMinutes} min).`
      : `Breaks must be ${ruleMinutes} minutes apart (next one in ${waitMinutes} min).`;
  return refuse("BREAK_TOO_SOON", message, {
    reason,
    eligibleAt: new Date(eligibleMs),
    waitMinutes,
  });
}

/**
 * Allowance snapshot for the dashboard and the device UI. `trigger` defaults to EMPLOYEE because that is
 * what the employee-facing "Take a break" button needs; pass MANAGER for the manager console.
 * Throws `AppError(VALIDATION_ERROR)` when an instant is not a valid `Date` (a programming error — Prisma
 * rows and parsed requests always carry valid instants).
 */
export function computeBreakAllowance(
  policy: BreakPolicyLike,
  shift: ShiftWindowLike,
  sessions: readonly BreakSessionLike[],
  now: Date,
  trigger: BreakTrigger = "EMPLOYEE",
): BreakAllowance {
  const invalid = invalidInstantRefusal(shift, sessions, now);
  if (invalid) throw breakRefusalToAppError(invalid);
  const nowMs = now.getTime();
  const summary = summarise(sessions, shift, nowMs);
  const grants = policyGrantsBreaks(policy);
  const canStartNow = canStartBreak({ policy, shift, existingSessions: sessions, now, trigger }).ok;
  return {
    breaksTaken: summary.breaksTaken,
    breaksRemaining: grants ? Math.max(0, policy.maxBreaksPerShift - summary.breaksTaken) : 0,
    minutesUsed: summary.minutesUsed,
    minutesRemaining: grants ? Math.max(0, policy.maxTotalBreakMinutes - summary.minutesUsed) : 0,
    nextEligibleAt: nextEligibleAt(policy, shift, summary, nowMs, trigger),
    canStartNow,
  };
}

/**
 * Mirrors `canStartBreak` over time, assuming no new session is recorded and running sessions run to their
 * effective end. Invariant (tested exhaustively): `canStartBreak(now).ok` ⇔ `nextEligibleAt ≤ now`, and for a
 * future `nextEligibleAt` the break is refused before it and allowed exactly at it.
 */
function nextEligibleAt(
  policy: BreakPolicyLike,
  shift: ShiftWindowLike,
  summary: ShiftBreakSummary,
  nowMs: number,
  trigger: BreakTrigger,
): Date | null {
  if (!policyGrantsBreaks(policy) || !triggerAllowed(policy, trigger)) return null;
  if (summary.breaksTaken >= policy.maxBreaksPerShift) return null;
  if (policy.maxTotalBreakMinutes - summary.projectedMinutesUsed < MIN_BREAK_DURATION_MINUTES)
    return null;

  const shiftStartMs = shift.startsAt.getTime();
  // The last instant a break can start: one whole minute of shift must remain.
  const lastStartMs = shift.endsAt.getTime() - minutesToMs(MIN_BREAK_DURATION_MINUTES);
  // Once that instant has passed, no further break is possible this shift.
  if (nowMs > lastStartMs) return null;
  // Breaks never overlap: nobody (not even MANAGER) can start before the latest break has ended.
  let eligibleMs = Math.max(shiftStartMs, summary.lastEndMs ?? shiftStartMs);
  if (trigger !== "MANAGER") {
    eligibleMs = Math.max(eligibleMs, shiftStartMs + minutesToMs(policy.minMinutesAfterShiftStart));
    if (summary.lastEndMs !== null) {
      eligibleMs = Math.max(
        eligibleMs,
        summary.lastEndMs + minutesToMs(policy.minGapBetweenBreaksMinutes),
      );
    }
  }
  if (eligibleMs > lastStartMs) return null;
  return new Date(eligibleMs);
}

/**
 * The `ACTIVE` sessions of `shift` whose time is up at `now` (effective end `min(plannedEndsAt,
 * shift.endsAt)` ≤ now) and the write that closes each one, ordered by `startedAt`. The rules already treat
 * these rows as ended; this tells the server how to persist that — in the periodic sweep, and in the
 * break-start transaction before inserting a new `ACTIVE` row (`break_sessions_one_active_per_shift`).
 * Sessions of other shifts, sessions that already have `endedAt`, and running sessions are not returned.
 */
export function expiredBreakSessionClosures(
  shift: ShiftWindowLike,
  sessions: readonly BreakSessionLike[],
  now: Date,
): BreakSessionClosure[] {
  const invalid = invalidInstantRefusal(shift, sessions, now);
  if (invalid) throw breakRefusalToAppError(invalid);
  const nowMs = now.getTime();
  const shiftEndMs = shift.endsAt.getTime();
  const closures: Array<BreakSessionClosure & { startMs: number }> = [];
  for (const session of sessionsOfShift(sessions, shift)) {
    if (session.status !== "ACTIVE" || session.endedAt) continue;
    const span = spanOf(session, nowMs, shiftEndMs);
    if (span.projectedEndMs > nowMs) continue; // still running
    closures.push({
      sessionId: session.id,
      endedAt: new Date(span.projectedEndMs),
      endReason: session.plannedEndsAt.getTime() > shiftEndMs ? "SHIFT_ENDED" : "EXPIRED",
      startMs: span.startMs,
    });
  }
  return closures
    .sort((a, b) => a.startMs - b.startMs)
    .map(({ sessionId, endedAt, endReason }) => ({ sessionId, endedAt, endReason }));
}

/** `canStartBreak`, but a refusal becomes an `AppError` carrying the same code/message/details. */
export function throwIfCannotStartBreak(input: CanStartBreakInput): BreakStartApproval {
  const result = canStartBreak(input);
  if (!result.ok) throw breakRefusalToAppError(result);
  return result;
}

export function breakRefusalToAppError(refusal: BreakRefusal): AppError {
  return new AppError(refusal.code, refusal.message, { details: refusal.details });
}

// ─────────────────────────────────────────────────────────────────────────────
// Restriction behaviour during a break
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalises an untyped JSON value (Prisma `Json` column, cached policy, request body) into a list of
 * known restriction categories: unknown entries dropped, duplicates removed, canonical order.
 */
export function parseRelaxedCategories(value: unknown): RestrictionCategory[] {
  if (!Array.isArray(value)) return [];
  const present = new Set<string>(value.filter((v): v is string => typeof v === "string"));
  return RESTRICTION_CATEGORIES.filter((c) => present.has(c));
}

/** Converts a Prisma `BreakPolicy` row (JSON `relaxedCategories`) into a `BreakPolicyLike`. */
export function breakPolicyFromRecord(record: BreakPolicyRecordLike): BreakPolicyLike {
  return {
    breaksEnabled: record.breaksEnabled,
    maxBreaksPerShift: record.maxBreaksPerShift,
    maxBreakDurationMinutes: record.maxBreakDurationMinutes,
    maxTotalBreakMinutes: record.maxTotalBreakMinutes,
    minGapBetweenBreaksMinutes: record.minGapBetweenBreaksMinutes,
    minMinutesAfterShiftStart: record.minMinutesAfterShiftStart,
    employeeTriggeredAllowed: record.employeeTriggeredAllowed,
    scheduledBreaksAllowed: record.scheduledBreaksAllowed,
    restrictionBehaviour: record.restrictionBehaviour,
    relaxedCategories: parseRelaxedCategories(record.relaxedCategories),
  };
}

/**
 * The behaviour snapshot to copy onto a new `BreakSession`. `relaxedCategories` is only meaningful for
 * RELAX_CATEGORIES and is emptied otherwise, so stored sessions are unambiguous.
 */
export function resolveBreakBehaviour(policy: {
  restrictionBehaviour: BreakRestrictionBehaviour;
  /** `BreakPolicyLike.relaxedCategories` or a raw JSON value — both are normalised. */
  relaxedCategories: unknown;
}): BreakBehaviour {
  const behaviour = policy.restrictionBehaviour;
  switch (behaviour) {
    case "RELAX_ALL":
    case "KEEP_RESTRICTIONS":
      return { restrictionBehaviour: behaviour, relaxedCategories: [] };
    case "RELAX_CATEGORIES":
      return {
        restrictionBehaviour: behaviour,
        relaxedCategories: parseRelaxedCategories(policy.relaxedCategories),
      };
    default:
      return assertNever(behaviour);
  }
}

/**
 * What the restriction engine applies while `session` is active. Reads the snapshot stored on the
 * session — never the current policy — so a policy change mid-break does not alter a running break.
 * Same mapping as the Work Mode state machine's ON_BREAK output (`effectiveRestriction`,
 * `restrictionsShouldBeActive`, `relaxation.liftedCategories`).
 */
export function breakRestrictionForSession(session: {
  restrictionBehaviour: BreakRestrictionBehaviour;
  relaxedCategories: unknown;
}): BreakRestriction {
  const behaviour = resolveBreakBehaviour(session);
  switch (behaviour.restrictionBehaviour) {
    case "RELAX_ALL":
      return {
        ...behaviour,
        effectiveRestriction: "BREAK_RELAXED",
        restrictionsShouldBeActive: false,
        liftedCategories: [...RESTRICTION_CATEGORIES],
      };
    case "KEEP_RESTRICTIONS":
      return {
        ...behaviour,
        effectiveRestriction: "WORK",
        restrictionsShouldBeActive: true,
        liftedCategories: [],
      };
    case "RELAX_CATEGORIES": {
      const lifted = behaviour.relaxedCategories;
      const effectiveRestriction: EffectiveRestriction =
        lifted.length > 0 ? "BREAK_RELAXED" : "WORK";
      return {
        ...behaviour,
        effectiveRestriction,
        restrictionsShouldBeActive: lifted.length < RESTRICTION_CATEGORIES.length,
        liftedCategories: [...lifted],
      };
    }
    default:
      return assertNever(behaviour.restrictionBehaviour);
  }
}

/** `true` when `category` is unblocked during a break with the given behaviour snapshot. */
export function isCategoryRelaxedDuringBreak(
  behaviour: BreakBehaviour,
  category: RestrictionCategory,
): boolean {
  switch (behaviour.restrictionBehaviour) {
    case "RELAX_ALL":
      return true;
    case "KEEP_RESTRICTIONS":
      return false;
    case "RELAX_CATEGORIES":
      return behaviour.relaxedCategories.includes(category);
    default:
      return assertNever(behaviour.restrictionBehaviour);
  }
}
