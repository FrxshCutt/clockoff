import type { BreakPolicyLike } from "@workmode/shared/breaks/breakRules";
import { AppError } from "@workmode/shared/errors";
import { minutesBetween, overlaps, type ShiftTimeWarning } from "@workmode/shared/time/time";
import {
  SHIFT_LIMITS,
  type ScheduledBreakInput,
  type ShiftWarning,
} from "@workmode/validation/shifts";

/**
 * Pure shift rules shared by the shifts service and the CSV import commit: duration bounds, overlap
 * detection, scheduled-break placement and the advisory warnings the API returns. No I/O.
 */

/** Occurrences of a recurring series are materialised this far ahead (the job keeps topping up). */
export const RECURRENCE_HORIZON_DAYS = 56;

export const MS_PER_MINUTE = 60_000;
export const MS_PER_DAY = 86_400_000;

export interface IntervalLike {
  id: string;
  startsAt: Date;
  endsAt: Date;
}

/**
 * Enforces the 15-minute minimum (Apple DeviceActivity cannot schedule anything shorter → SHIFT_TOO_SHORT)
 * and the 24-hour maximum (VALIDATION_ERROR, `details.reason = "SHIFT_TOO_LONG"`). Returns the absolute
 * length in minutes.
 */
export function assertShiftDuration(startsAt: Date, endsAt: Date): number {
  if (endsAt.getTime() <= startsAt.getTime()) {
    throw new AppError("VALIDATION_ERROR", "A shift must end after it starts", {
      details: { field: "endsAt" },
    });
  }
  const minutes = minutesBetween(startsAt, endsAt);
  if (minutes < SHIFT_LIMITS.minDurationMinutes) {
    throw new AppError(
      "SHIFT_TOO_SHORT",
      `A shift must last at least ${SHIFT_LIMITS.minDurationMinutes} minutes`,
      { details: { durationMinutes: minutes, minDurationMinutes: SHIFT_LIMITS.minDurationMinutes } },
    );
  }
  if (minutes > SHIFT_LIMITS.maxDurationMinutes) {
    throw new AppError("VALIDATION_ERROR", "A shift may not last longer than 24 hours", {
      details: {
        reason: "SHIFT_TOO_LONG",
        durationMinutes: minutes,
        maxDurationMinutes: SHIFT_LIMITS.maxDurationMinutes,
      },
    });
  }
  return minutes;
}

/** Ids of `others` whose half-open interval overlaps `[startsAt, endsAt)`. Adjacent shifts do not overlap. */
export function conflictingShiftIds(
  startsAt: Date,
  endsAt: Date,
  others: readonly IntervalLike[],
  excludeIds?: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const other of others) {
    if (excludeIds?.has(other.id)) continue;
    if (overlaps(startsAt, endsAt, other.startsAt, other.endsAt)) out.push(other.id);
  }
  return out;
}

export function shiftOverlapError(conflictingIds: readonly string[]): AppError {
  return new AppError(
    "SHIFT_OVERLAP",
    conflictingIds.length === 1
      ? "The employee already has a shift during this time"
      : `The employee already has ${conflictingIds.length} shifts during this time`,
    { details: { conflictingShiftIds: [...conflictingIds] } },
  );
}

/** Throws SHIFT_OVERLAP (409) unless `allowOverlap` or nothing collides. */
export function assertNoOverlap(
  startsAt: Date,
  endsAt: Date,
  others: readonly IntervalLike[],
  options: { allowOverlap?: boolean | undefined; excludeIds?: ReadonlySet<string> } = {},
): void {
  if (options.allowOverlap) return;
  const ids = conflictingShiftIds(startsAt, endsAt, others, options.excludeIds);
  if (ids.length > 0) throw shiftOverlapError(ids);
}

/**
 * Sorts scheduled breaks by offset and checks they fit inside a shift of `durationMinutes` without
 * overlapping each other (VALIDATION_ERROR otherwise). Returns a new array.
 */
export function normaliseScheduledBreaks(
  breaks: readonly ScheduledBreakInput[] | undefined,
  durationMinutes: number,
): ScheduledBreakInput[] {
  if (!breaks || breaks.length === 0) return [];
  const sorted = [...breaks]
    .map((b) => ({
      offsetMinutesFromStart: b.offsetMinutesFromStart,
      durationMinutes: b.durationMinutes,
    }))
    .sort((a, b) => a.offsetMinutesFromStart - b.offsetMinutesFromStart);
  let previousEnd = -1;
  sorted.forEach((b, index) => {
    const end = b.offsetMinutesFromStart + b.durationMinutes;
    if (end > durationMinutes) {
      throw new AppError("VALIDATION_ERROR", "Scheduled breaks must fit inside the shift", {
        details: {
          field: "scheduledBreaks",
          index,
          reason: "SCHEDULED_BREAK_OUTSIDE_SHIFT",
          shiftDurationMinutes: durationMinutes,
        },
      });
    }
    if (b.offsetMinutesFromStart < previousEnd) {
      throw new AppError("VALIDATION_ERROR", "Scheduled breaks must not overlap each other", {
        details: { field: "scheduledBreaks", index, reason: "SCHEDULED_BREAKS_OVERLAP" },
      });
    }
    previousEnd = end;
  });
  return sorted;
}

/** Breaks that still fit a (possibly shorter, DST-affected) occurrence of `durationMinutes`. */
export function breaksFitting(
  breaks: readonly ScheduledBreakInput[],
  durationMinutes: number,
): ScheduledBreakInput[] {
  return breaks.filter((b) => b.offsetMinutesFromStart + b.durationMinutes <= durationMinutes);
}

/**
 * Advisory warnings (never errors) when scheduled breaks would be refused by the resolved break policy
 * when they fire — the break rules answer BREAK_TOO_SOON / BREAK_LIMIT_REACHED / BREAK_TOO_LONG at
 * run time, so the manager is told now rather than discovering it on the day.
 */
export function scheduledBreakWarnings(
  breaks: readonly ScheduledBreakInput[],
  policy: BreakPolicyLike | null,
): ShiftWarning[] {
  if (breaks.length === 0 || !policy) return [];
  const warnings: ShiftWarning[] = [];
  if (!policy.breaksEnabled) {
    warnings.push({
      code: "SCHEDULED_BREAKS_NOT_ALLOWED",
      message: "The employee's break policy has breaks disabled, so scheduled breaks will not start.",
    });
    return warnings;
  }
  if (!policy.scheduledBreaksAllowed) {
    warnings.push({
      code: "SCHEDULED_BREAKS_NOT_ALLOWED",
      message: "The employee's break policy does not allow scheduled breaks, so they will not start.",
    });
  }
  const sorted = [...breaks].sort((a, b) => a.offsetMinutesFromStart - b.offsetMinutesFromStart);
  let previousEnd: number | null = null;
  let total = 0;
  sorted.forEach((b, index) => {
    if (b.offsetMinutesFromStart < policy.minMinutesAfterShiftStart) {
      warnings.push({
        code: "SCHEDULED_BREAK_BEFORE_MIN_START",
        message: `Break ${index + 1} starts ${b.offsetMinutesFromStart} minutes into the shift; the break policy requires at least ${policy.minMinutesAfterShiftStart} minutes, so it would be refused (BREAK_TOO_SOON).`,
      });
    }
    if (
      previousEnd !== null &&
      b.offsetMinutesFromStart - previousEnd < policy.minGapBetweenBreaksMinutes
    ) {
      warnings.push({
        code: "SCHEDULED_BREAK_GAP_TOO_SHORT",
        message: `Break ${index + 1} starts ${b.offsetMinutesFromStart - previousEnd} minutes after the previous one; the break policy requires a gap of ${policy.minGapBetweenBreaksMinutes} minutes, so it would be refused (BREAK_TOO_SOON).`,
      });
    }
    if (b.durationMinutes > policy.maxBreakDurationMinutes) {
      warnings.push({
        code: "SCHEDULED_BREAK_TOO_LONG",
        message: `Break ${index + 1} lasts ${b.durationMinutes} minutes; the break policy allows at most ${policy.maxBreakDurationMinutes}, so it will be shortened.`,
      });
    }
    previousEnd = b.offsetMinutesFromStart + b.durationMinutes;
    total += b.durationMinutes;
  });
  if (sorted.length > policy.maxBreaksPerShift) {
    warnings.push({
      code: "SCHEDULED_BREAKS_EXCEED_LIMIT",
      message: `${sorted.length} breaks are scheduled but the break policy allows ${policy.maxBreaksPerShift} per shift; later breaks would be refused (BREAK_LIMIT_REACHED).`,
    });
  }
  if (total > policy.maxTotalBreakMinutes) {
    warnings.push({
      code: "SCHEDULED_BREAKS_EXCEED_TOTAL",
      message: `${total} minutes of breaks are scheduled but the break policy allows ${policy.maxTotalBreakMinutes} minutes per shift in total.`,
    });
  }
  return warnings;
}

const DST_WARNING_MESSAGES: Record<ShiftTimeWarning, string> = {
  START_NONEXISTENT_LOCAL_TIME_SHIFTED:
    "The start time does not exist on that date (clocks go forward); the shift starts at the next valid time.",
  START_AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE:
    "The start time happens twice on that date (clocks go back); the first occurrence was used.",
  END_NONEXISTENT_LOCAL_TIME_SHIFTED:
    "The end time does not exist on that date (clocks go forward); the shift ends at the next valid time.",
  END_AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE:
    "The end time happens twice on that date (clocks go back); the first occurrence was used.",
};

/** Maps `buildShiftInstants` / `expandShiftSeries` DST codes to API warnings (de-duplicated). */
export function dstWarnings(
  codes: readonly ShiftTimeWarning[],
  context?: { date?: string },
): ShiftWarning[] {
  const seen = new Set<ShiftTimeWarning>();
  const out: ShiftWarning[] = [];
  for (const code of codes) {
    if (seen.has(code)) continue;
    seen.add(code);
    const prefix = context?.date ? `${context.date}: ` : "";
    out.push({ code, message: `${prefix}${DST_WARNING_MESSAGES[code]}` });
  }
  return out;
}

/**
 * One scheduled break of `breakMinutes` centred in a shift of `durationMinutes` (CSV `break_minutes`
 * column). Null when there is no break or it does not fit.
 */
export function centredBreak(
  durationMinutes: number,
  breakMinutes: number | undefined,
): ScheduledBreakInput | null {
  if (breakMinutes === undefined || breakMinutes <= 0) return null;
  if (breakMinutes >= durationMinutes) return null;
  return {
    offsetMinutesFromStart: Math.floor((durationMinutes - breakMinutes) / 2),
    durationMinutes: breakMinutes,
  };
}

/** Whole-day difference `b - a` between two `YYYY-MM-DD` strings (pure calendar arithmetic). */
export function daysBetweenLocalDates(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / MS_PER_DAY);
}
