/**
 * Plain (framework-free) types for the break rules (§6.3). They mirror the Prisma models `BreakPolicy`,
 * `BreakSession` and `Shift` structurally so that a Prisma row, a cached policy on the device or a test
 * fixture can all be passed in without conversion. Every instant is an absolute UTC `Date`; timezones are
 * only ever applied at the edges (display, CSV parsing), never inside the rules.
 */
import type {
  BreakEndReason,
  BreakRestrictionBehaviour,
  BreakSessionStatus,
  EffectiveRestriction,
  RestrictionCategory,
} from "../enums";
import type { ApiErrorCode } from "../errors";

/** Structural mirror of `BreakPolicy` with `relaxedCategories` already parsed from JSON. */
export interface BreakPolicyLike {
  breaksEnabled: boolean;
  maxBreaksPerShift: number;
  maxBreakDurationMinutes: number;
  maxTotalBreakMinutes: number;
  minGapBetweenBreaksMinutes: number;
  minMinutesAfterShiftStart: number;
  employeeTriggeredAllowed: boolean;
  scheduledBreaksAllowed: boolean;
  restrictionBehaviour: BreakRestrictionBehaviour;
  relaxedCategories: readonly RestrictionCategory[];
}

/**
 * A `BreakPolicy` row as it comes out of Prisma (or any JSON transport): `relaxedCategories` is an
 * untyped JSON value. Convert with `breakPolicyFromRecord()`.
 */
export type BreakPolicyRecordLike = Omit<BreakPolicyLike, "relaxedCategories"> & {
  relaxedCategories: unknown;
};

/**
 * Structural mirror of the `BreakSession` columns the rules need. A session's time counts from `startedAt`
 * to its **effective end** = `min(endedAt ?? plannedEndsAt, plannedEndsAt, shift.endsAt)` (never before
 * `startedAt`) — the same end the Work Mode state machine uses. A late or skewed `endedAt` report therefore
 * never changes the allowance.
 */
export interface BreakSessionLike {
  id: string;
  shiftId: string;
  startedAt: Date;
  plannedEndsAt: Date;
  endedAt?: Date | null;
  status: BreakSessionStatus;
}

/** The shift window a break must fit inside. Structural mirror of `Shift` (id, startsAt, endsAt). */
export interface ShiftWindowLike {
  id: string;
  startsAt: Date;
  endsAt: Date;
}

/** Who (or what) is asking for the break. */
export const BREAK_TRIGGERS = ["EMPLOYEE", "SCHEDULED", "MANAGER"] as const;
export type BreakTrigger = (typeof BREAK_TRIGGERS)[number];

export interface CanStartBreakInput {
  policy: BreakPolicyLike;
  shift: ShiftWindowLike;
  /** Every break session of this shift (other shifts' sessions are ignored). */
  existingSessions: readonly BreakSessionLike[];
  /**
   * Authoritative instant on the server clock. The break starts at exactly this instant if approved. For a
   * mobile request use `breakStartInstant(requestedAt, receivedAt, skew)` (never later than the receive time).
   */
  now: Date;
  /** Whole minutes ≥ 1. Omitted → `policy.maxBreakDurationMinutes`. */
  requestedDurationMinutes?: number | null;
  trigger: BreakTrigger;
}

/** The behaviour snapshot stored on a `BreakSession` when it starts (`restrictionBehaviour`, `relaxedCategories`). */
export interface BreakBehaviour {
  restrictionBehaviour: BreakRestrictionBehaviour;
  /** Only populated for `RELAX_CATEGORIES`; normalised (valid, de-duplicated, canonical order). */
  relaxedCategories: RestrictionCategory[];
}

/**
 * What the restriction engine applies while a given break session is active. Same mapping as the Work Mode
 * state machine (`computeExpectedState`, §6.2) so the dashboard and the device never disagree.
 */
export interface BreakRestriction extends BreakBehaviour {
  /**
   * The restriction *profile*: `BREAK_RELAXED` for RELAX_ALL and for RELAX_CATEGORIES with ≥ 1 category,
   * `WORK` for KEEP_RESTRICTIONS and RELAX_CATEGORIES with an empty list. Never `NONE` — a break is not
   * "off shift".
   */
  effectiveRestriction: EffectiveRestriction;
  /** `false` when every category is lifted (RELAX_ALL, or RELAX_CATEGORIES listing every category). */
  restrictionsShouldBeActive: boolean;
  /** Every category whose restriction is lifted during this break (all of them for RELAX_ALL). */
  liftedCategories: RestrictionCategory[];
}

export interface BreakStartApproval {
  ok: true;
  /** Equal to `input.now`. */
  startsAt: Date;
  /** Absolute UTC instant; never later than `shift.endsAt`. Nothing depends on the app being open. */
  plannedEndsAt: Date;
  /** Whole minutes this break counts against the allowance: `ceil((plannedEndsAt - startsAt) / 1 min)`. */
  durationMinutes: number;
  /** Allowance left for the rest of the shift once this break has been taken in full. */
  remaining: { breaks: number; minutes: number };
  /** Snapshot to persist on the session so a policy change mid-break does not alter it. */
  behaviour: BreakBehaviour;
}

/** Every code a refusal can carry. Each one is an `ApiErrorCode`, so refusals map 1:1 to API errors. */
export const BREAK_REFUSAL_CODES = [
  "BREAKS_DISABLED",
  "EMPLOYEE_BREAKS_NOT_ALLOWED",
  "VALIDATION_ERROR",
  "BREAK_TOO_LONG",
  "NOT_ON_SHIFT",
  "BREAK_ALREADY_ACTIVE",
  "BREAK_LIMIT_REACHED",
  "BREAK_TOO_SOON",
] as const satisfies readonly ApiErrorCode[];
export type BreakRefusalCode = (typeof BREAK_REFUSAL_CODES)[number];

export const BREAKS_DISABLED_REASONS = [
  "BREAKS_DISABLED",
  "SCHEDULED_BREAKS_NOT_ALLOWED",
  "NO_BREAK_DURATION",
] as const;
export type BreaksDisabledReason = (typeof BREAKS_DISABLED_REASONS)[number];

/**
 * Which input a `VALIDATION_ERROR` refusal is about. Instants must be valid `Date`s; for `existingSessions`
 * the `value` is the offending session's id.
 */
export const BREAK_INPUT_FIELDS = [
  "now",
  "shift.startsAt",
  "shift.endsAt",
  "existingSessions",
  "requestedDurationMinutes",
] as const;
export type BreakInputField = (typeof BREAK_INPUT_FIELDS)[number];

export const NOT_ON_SHIFT_REASONS = ["SHIFT_NOT_STARTED", "SHIFT_ENDED", "SHIFT_ENDING"] as const;
export type NotOnShiftReason = (typeof NOT_ON_SHIFT_REASONS)[number];

export const BREAK_LIMIT_REASONS = ["MAX_BREAKS_PER_SHIFT", "MAX_TOTAL_BREAK_MINUTES"] as const;
export type BreakLimitReason = (typeof BREAK_LIMIT_REASONS)[number];

export const BREAK_TOO_SOON_REASONS = [
  "MIN_MINUTES_AFTER_SHIFT_START",
  "MIN_GAP_BETWEEN_BREAKS",
] as const;
export type BreakTooSoonReason = (typeof BREAK_TOO_SOON_REASONS)[number];

/**
 * `BREAK_IN_PROGRESS`: a session of this shift covers `now`. `LATER_BREAK_RECORDED`: a session starts after
 * `now` — only possible when re-validating a past instant (offline reconciliation); breaks never overlap.
 */
export const BREAK_ALREADY_ACTIVE_REASONS = ["BREAK_IN_PROGRESS", "LATER_BREAK_RECORDED"] as const;
export type BreakAlreadyActiveReason = (typeof BREAK_ALREADY_ACTIVE_REASONS)[number];

interface RefusalBase<C extends BreakRefusalCode, D> {
  ok: false;
  code: C;
  message: string;
  details: D;
}

export type BreakRefusal =
  | RefusalBase<"BREAKS_DISABLED", { reason: BreaksDisabledReason }>
  | RefusalBase<"EMPLOYEE_BREAKS_NOT_ALLOWED", { trigger: "EMPLOYEE" }>
  | RefusalBase<"VALIDATION_ERROR", { field: BreakInputField; value: unknown }>
  | RefusalBase<
      "BREAK_TOO_LONG",
      { requestedDurationMinutes: number; maxBreakDurationMinutes: number }
    >
  | RefusalBase<
      "NOT_ON_SHIFT",
      { reason: NotOnShiftReason; shiftStartsAt: Date; shiftEndsAt: Date }
    >
  | RefusalBase<
      "BREAK_ALREADY_ACTIVE",
      { reason: BreakAlreadyActiveReason; sessionId: string; startedAt: Date; plannedEndsAt: Date }
    >
  | RefusalBase<
      "BREAK_LIMIT_REACHED",
      {
        reason: BreakLimitReason;
        breaksTaken: number;
        maxBreaksPerShift: number;
        minutesUsed: number;
        maxTotalBreakMinutes: number;
      }
    >
  | RefusalBase<
      "BREAK_TOO_SOON",
      { reason: BreakTooSoonReason; eligibleAt: Date; waitMinutes: number }
    >;

export type CanStartBreakResult = BreakStartApproval | BreakRefusal;

export interface BreakAllowance {
  /** Sessions of this shift, ended or active (an expired-but-unclosed session counts as ended). */
  breaksTaken: number;
  /** `maxBreaksPerShift − breaksTaken`, floored at 0; 0 when the policy grants no breaks at all. */
  breaksRemaining: number;
  /** Whole minutes, rounded up per session; active sessions count elapsed-so-far. */
  minutesUsed: number;
  /** `maxTotalBreakMinutes − minutesUsed`, floored at 0; 0 when the policy grants no breaks at all. */
  minutesRemaining: number;
  /**
   * Earliest instant at which the given trigger could start another break, or `null` when no further break
   * is possible during this shift (including once the shift has ended). It is in the past exactly when
   * `canStartNow` is true. Assumes an active break runs to its effective end. Never earlier than the end of
   * the latest recorded break.
   */
  nextEligibleAt: Date | null;
  canStartNow: boolean;
}

/**
 * A write the server must make to close an `ACTIVE` session whose time is up (see
 * `expiredBreakSessionClosures`). Required before inserting a new `ACTIVE` session because of the
 * `break_sessions_one_active_per_shift` partial unique index, and by the periodic sweep.
 */
export interface BreakSessionClosure {
  sessionId: string;
  /** The session's effective end: `min(plannedEndsAt, shift.endsAt)`, never before `startedAt`. */
  endedAt: Date;
  /** `SHIFT_ENDED` when the shift end cut the break short (shift shortened mid-break), else `EXPIRED`. */
  endReason: Extract<BreakEndReason, "EXPIRED" | "SHIFT_ENDED">;
}
