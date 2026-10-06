/**
 * Shift-level helpers built on the zone primitives (§6.4): turning what a manager typed
 * (`date`, `startTime`, `endTime`, `timezone`) into stored UTC instants, and rendering them back.
 */
import { DateTime, IANAZone } from "luxon";
import { AppError } from "../errors";
import { minutesBetween } from "./intervals";
import {
  calendarToUtcMs,
  isValidLocalDate,
  isValidLocalTime,
  type LocalDateString,
  type LocalTimeString,
} from "./parse";
import {
  addLocalDays,
  assertTimeZone,
  instantToWallClock,
  localToInstant,
  type LocalTimeWarning,
} from "./zone";

/** Warning codes carried by a built shift, prefixed by which end of the shift they concern. */
export type ShiftTimeWarning = `START_${LocalTimeWarning}` | `END_${LocalTimeWarning}`;

/** What a manager typed for one shift (the local wall-clock form of the create-shift API). */
export interface BuildShiftInstantsInput {
  /** Local calendar date the shift starts on, `YYYY-MM-DD`. */
  date: LocalDateString;
  /** `HH:mm` */
  startTime: LocalTimeString;
  /** `HH:mm`. When `endTime <= startTime` the shift ends on the next local day. */
  endTime: LocalTimeString;
  /** IANA zone the manager entered the times in (location zone, else organisation zone). */
  timezone: string;
}

/** A typed shift resolved to UTC instants by `buildShiftInstants`. */
export interface ShiftInstants {
  /** UTC instant the shift starts (inclusive). */
  startsAt: Date;
  /** UTC instant the shift ends (exclusive). Always after `startsAt`. */
  endsAt: Date;
  /** True when the shift ends on the local day after `date` (including `endTime === startTime`, a 24h shift). */
  isOvernight: boolean;
  /** Local date the shift ends on (`date` or `date + 1`). */
  endDate: LocalDateString;
  /** Absolute minutes between the instants — 420 or 540 for an 8h nominal shift on a DST night. */
  durationMinutes: number;
  /** DST adjustments applied to either end, in order start then end; usually empty. */
  warnings: ShiftTimeWarning[];
  /** Present when `startTime` did not exist locally and was moved forward. */
  normalisedStartTime?: LocalTimeString;
  /** Present when `endTime` did not exist locally and was moved forward. */
  normalisedEndTime?: LocalTimeString;
}

function invalidField(field: string, value: unknown, expected: string): AppError {
  return new AppError("VALIDATION_ERROR", `${field} must be a valid ${expected} value`, {
    details: { field, value },
  });
}

/**
 * Resolves a manager-entered shift to UTC instants. `endTime <= startTime` means the shift ends on the next
 * local day (overnight; equal times = 24h). Nonexistent local times move forward by the DST gap, ambiguous
 * ones take the first occurrence (see `zone.ts`), and each case is reported in `warnings`. Europe/London
 * 22:00–06:00 is 7h starting 2026-03-28 (spring forward) and 9h starting 2026-10-24 (fall back).
 *
 * Throws `AppError("VALIDATION_ERROR")` for malformed inputs (`details.field` is `date`, `startTime` or
 * `endTime`), or when DST normalisation leaves the end at or before the start (`details.reason`
 * `SHIFT_END_NOT_AFTER_START`; only possible for a sub-hour shift that starts inside a spring-forward gap).
 * Throws `AppError("INVALID_TIMEZONE")` for unknown zones.
 */
export function buildShiftInstants(input: BuildShiftInstantsInput): ShiftInstants {
  assertTimeZone(input.timezone);
  if (!isValidLocalDate(input.date)) throw invalidField("date", input.date, "YYYY-MM-DD");
  if (!isValidLocalTime(input.startTime)) throw invalidField("startTime", input.startTime, "HH:mm");
  if (!isValidLocalTime(input.endTime)) throw invalidField("endTime", input.endTime, "HH:mm");
  const start = localToInstant({
    date: input.date,
    time: input.startTime,
    timezone: input.timezone,
  });
  const isOvernight = input.endTime <= input.startTime;
  const endDate = isOvernight ? addLocalDays(input.date, 1) : input.date;
  const end = localToInstant({ date: endDate, time: input.endTime, timezone: input.timezone });

  const warnings: ShiftTimeWarning[] = [];
  if (start.warning) warnings.push(`START_${start.warning}`);
  if (end.warning) warnings.push(`END_${end.warning}`);

  if (end.instant.getTime() <= start.instant.getTime()) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Shift end must be after its start once DST is applied",
      {
        details: {
          reason: "SHIFT_END_NOT_AFTER_START",
          startsAt: start.instant.toISOString(),
          endsAt: end.instant.toISOString(),
          warnings,
        },
      },
    );
  }

  const result: ShiftInstants = {
    startsAt: start.instant,
    endsAt: end.instant,
    isOvernight,
    endDate,
    durationMinutes: minutesBetween(start.instant, end.instant),
    warnings,
  };
  if (start.normalisedLocalTime) result.normalisedStartTime = start.normalisedLocalTime;
  if (end.normalisedLocalTime) result.normalisedEndTime = end.normalisedLocalTime;
  return result;
}

/** Options for `formatShiftRange`. */
export interface FormatShiftRangeOptions {
  /** BCP 47 locale for weekday/month names. Default `en-GB`. */
  locale?: string;
  /** Append the year to the date part (`Tue 6 Oct 2026, …`). Default false. */
  includeYear?: boolean;
}

const MS_PER_DAY = 86_400_000;

function localDayIndex(instant: Date, tz: string): number {
  const wc = instantToWallClock(instant, tz);
  return Math.round(calendarToUtcMs(wc.year, wc.month, wc.day) / MS_PER_DAY);
}

/**
 * Human-readable range in `timezone`, e.g. `Tue 6 Oct, 09:00–15:00`, or `Sat 24 Oct, 22:00–06:00 (+1)`
 * when the shift ends on a later local day (the number is the day difference). Times are 24-hour; names
 * follow `opts.locale`. Throws `AppError("INVALID_TIMEZONE")` / `AppError("VALIDATION_ERROR")` for an
 * unknown zone or invalid `Date`s.
 */
export function formatShiftRange(
  startsAt: Date,
  endsAt: Date,
  timezone: string,
  opts: FormatShiftRangeOptions = {},
): string {
  assertTimeZone(timezone);
  const zone = IANAZone.create(timezone);
  const locale = opts.locale ?? "en-GB";
  const start = DateTime.fromJSDate(startsAt, { zone }).setLocale(locale);
  const end = DateTime.fromJSDate(endsAt, { zone }).setLocale(locale);
  if (!start.isValid || !end.isValid) {
    throw new AppError("VALIDATION_ERROR", "formatShiftRange requires valid instants", {
      details: { startsAt: String(startsAt), endsAt: String(endsAt) },
    });
  }
  const datePart = start.toFormat(opts.includeYear ? "ccc d LLL yyyy" : "ccc d LLL");
  const dayDiff = localDayIndex(endsAt, timezone) - localDayIndex(startsAt, timezone);
  const suffix = dayDiff > 0 ? ` (+${dayDiff})` : "";
  return `${datePart}, ${start.toFormat("HH:mm")}–${end.toFormat("HH:mm")}${suffix}`;
}
