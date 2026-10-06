/**
 * Timezone edge helpers (§6.4). Shifts are entered as local wall-clock values in the organisation / location
 * timezone and stored as UTC instants. Everything in here converts between the two; the rest of the system
 * only ever sees UTC `Date`s.
 *
 * DST rules (deterministic, independent of the host's zone):
 *   - a local time that does not exist (spring-forward gap) is moved FORWARD by the size of the gap and
 *     flagged `NONEXISTENT_LOCAL_TIME_SHIFTED` (e.g. America/New_York 2026-03-08 02:30 → 03:30 EDT);
 *   - a local time that exists twice (fall-back overlap) resolves to the FIRST occurrence — the earlier
 *     instant, i.e. the pre-transition offset — and is flagged `AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE`
 *     (e.g. Europe/London 2026-10-25 01:30 → 01:30 BST = 00:30Z, not 01:30 GMT).
 */
import { DateTime, IANAZone } from "luxon";
import { AppError } from "../errors";
import {
  calendarToUtcMs,
  formatLocalDate,
  formatLocalTime,
  isValidCalendarDate,
  isValidLocalDate,
  isValidLocalTime,
  splitLocalDate,
  splitLocalTime,
  type LocalDateString,
  type LocalTimeString,
} from "./parse";

/**
 * Every DST adjustment a local → UTC conversion can report:
 *   - `NONEXISTENT_LOCAL_TIME_SHIFTED`: the wall-clock time was skipped by a spring-forward gap and was moved
 *     forward by the size of the gap;
 *   - `AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE`: the wall-clock time happened twice (fall-back overlap) and the
 *     first (earlier) occurrence was used.
 */
export const LOCAL_TIME_WARNINGS = [
  "NONEXISTENT_LOCAL_TIME_SHIFTED",
  "AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE",
] as const;
/** One of `LOCAL_TIME_WARNINGS`. */
export type LocalTimeWarning = (typeof LOCAL_TIME_WARNINGS)[number];

/** ISO weekday: 1 = Monday … 7 = Sunday (Luxon convention). */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Wall-clock components in some timezone. `month` is 1–12 (unlike JS `Date`). */
export interface WallClock {
  /** Full year, e.g. 2026 (never two-digit). */
  year: number;
  /** 1 = January … 12 = December. */
  month: number;
  /** Day of the month, 1–31. */
  day: number;
  /** 0–23. */
  hour: number;
  /** 0–59. */
  minute: number;
  /** 0–59 (milliseconds are dropped). */
  second: number;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------------------------------------
// Timezone identifiers
// ---------------------------------------------------------------------------------------------------------

const KNOWN_VALID_ZONES = new Set<string>();
const MAX_CACHED_ZONES = 2_000;

/**
 * True for IANA zone identifiers the runtime can resolve (`Europe/London`, `UTC`, `America/New_York`…).
 * Fixed offsets (`+01:00`) are rejected: they are not IANA names and carry no DST rules.
 */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  if (KNOWN_VALID_ZONES.has(tz)) return true;
  if (/^[+-]/.test(tz)) return false;
  // `isValidZone` constructs an Intl.DateTimeFormat on every call (~100 µs), and every helper here validates
  // its zone, so remember positive answers. Bounded so arbitrary user input cannot grow it without limit.
  const valid = IANAZone.isValidZone(tz);
  if (valid && KNOWN_VALID_ZONES.size < MAX_CACHED_ZONES) KNOWN_VALID_ZONES.add(tz);
  return valid;
}

/** Every `/`-separated segment starts with a capital, as in all IANA names (`America/Port-au-Prince`). */
const IANA_CASED_RE = /^[A-Z][^/]*(?:\/[A-Z][^/]*)*$/;

/**
 * The zone's identifier with its proper letter case (`europe/london` → `Europe/London`), or `null` when
 * `tz` is not a valid zone. Store this rather than raw user input.
 *
 * It never swaps a correctly spelled identifier for a different one. ICU (behind `Intl`) "canonicalises"
 * several current IANA names to legacy aliases — `Asia/Kolkata` → `Asia/Calcutta`, `Europe/Kyiv` →
 * `Europe/Kiev`, `Asia/Ho_Chi_Minh` → `Asia/Saigon` — so a valid alias whose `/`-separated segments each
 * start with a capital (as every IANA name does) is returned exactly as given. Only an alias with a
 * lower-case segment (`asia/kolkata`), whose spelling cannot be recovered, falls back to the ICU identifier
 * (`Asia/Calcutta`, the same zone).
 */
export function canonicalTimeZone(tz: string): string | null {
  if (!isValidTimeZone(tz)) return null;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-GB", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  if (resolved.toLowerCase() === tz.toLowerCase()) return resolved;
  return IANA_CASED_RE.test(tz) ? tz : resolved;
}

/** Throws `AppError("INVALID_TIMEZONE")` unless `tz` is a valid IANA zone. */
export function assertTimeZone(tz: string): void {
  if (!isValidTimeZone(tz)) {
    throw new AppError("INVALID_TIMEZONE", `Unknown timezone ${JSON.stringify(tz)}`, {
      details: { timezone: tz },
    });
  }
}

function zoneOf(tz: string): IANAZone {
  assertTimeZone(tz);
  return IANAZone.create(tz);
}

function assertInstant(value: Date, name: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new AppError("VALIDATION_ERROR", `${name} must be a valid Date`, {
      details: { field: name },
    });
  }
}

// ---------------------------------------------------------------------------------------------------------
// Wall-clock ⇄ instant
// ---------------------------------------------------------------------------------------------------------

/**
 * Wall-clock components encoded as a UTC timestamp ("floating" time). Pure arithmetic, no zone. Years 0–99
 * are kept as is (see `calendarToUtcMs`).
 */
export function wallClockToFloatingMs(wc: WallClock): number {
  return calendarToUtcMs(wc.year, wc.month, wc.day, wc.hour, wc.minute, wc.second);
}

/** Inverse of `wallClockToFloatingMs` (milliseconds are dropped). */
export function floatingMsToWallClock(ms: number): WallClock {
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

/**
 * Wall-clock components of `instant` in `tz`. Throws `AppError("INVALID_TIMEZONE")` for unknown zones and
 * `AppError("VALIDATION_ERROR")` for an invalid `Date`.
 */
export function instantToWallClock(instant: Date, tz: string): WallClock {
  const zone = zoneOf(tz);
  assertInstant(instant, "instant");
  const offset = zone.offset(instant.getTime());
  return floatingMsToWallClock(instant.getTime() + offset * MS_PER_MINUTE);
}

/** Result of `resolveWallClock`. */
export interface ResolvedWallClock {
  /** The UTC instant the wall-clock resolves to. */
  instant: Date;
  /** Offset (minutes east of UTC) in force at `instant`. */
  offsetMinutes: number;
  /** Set when a DST rule was applied (gap moved forward, or overlap resolved to the first occurrence). */
  warning?: LocalTimeWarning;
  /** The wall-clock actually used; differs from the input only after a `NONEXISTENT_LOCAL_TIME_SHIFTED`. */
  wallClock: WallClock;
}

/**
 * Resolves wall-clock components in `tz` to an instant, applying the DST rules documented at the top of
 * this file: a time skipped by a spring-forward gap moves forward by the size of the gap
 * (`NONEXISTENT_LOCAL_TIME_SHIFTED`), and a time repeated by a fall-back overlap takes its first, earlier
 * occurrence (`AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE`). Throws `AppError("VALIDATION_ERROR")` unless the
 * components are a real calendar date and time of day (`isValidWallClock`), and
 * `AppError("INVALID_TIMEZONE")` for unknown zones.
 */
export function resolveWallClock(wc: WallClock, tz: string): ResolvedWallClock {
  const zone = zoneOf(tz);
  if (!isValidWallClock(wc)) {
    throw new AppError("VALIDATION_ERROR", "Invalid wall-clock components", {
      details: { field: "wallClock" },
    });
  }
  const floating = wallClockToFloatingMs(wc);
  // Offsets a day either side of the wall time bracket any transition that can affect it.
  const offsetBefore = zone.offset(floating - MS_PER_DAY);
  const offsetAfter = zone.offset(floating + MS_PER_DAY);
  const candidateOffsets =
    offsetBefore === offsetAfter ? [offsetBefore] : [offsetBefore, offsetAfter];

  const valid: Array<{ instantMs: number; offset: number }> = [];
  for (const offset of candidateOffsets) {
    const instantMs = floating - offset * MS_PER_MINUTE;
    if (zone.offset(instantMs) === offset) valid.push({ instantMs, offset });
  }

  if (valid.length === 1) {
    const only = valid[0]!;
    return { instant: new Date(only.instantMs), offsetMinutes: only.offset, wallClock: wc };
  }

  if (valid.length > 1) {
    // Fall-back overlap: take the earliest instant (first occurrence, pre-transition offset).
    const first = valid.reduce((a, b) => (a.instantMs <= b.instantMs ? a : b));
    return {
      instant: new Date(first.instantMs),
      offsetMinutes: first.offset,
      warning: "AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE",
      wallClock: wc,
    };
  }

  // Spring-forward gap: move forward by the size of the gap, then resolve with the post-transition offset.
  const gapMinutes = offsetAfter - offsetBefore;
  if (gapMinutes > 0) {
    const shiftedFloating = floating + gapMinutes * MS_PER_MINUTE;
    const instantMs = shiftedFloating - offsetAfter * MS_PER_MINUTE;
    if (zone.offset(instantMs) === offsetAfter) {
      return {
        instant: new Date(instantMs),
        offsetMinutes: offsetAfter,
        warning: "NONEXISTENT_LOCAL_TIME_SHIFTED",
        wallClock: floatingMsToWallClock(shiftedFloating),
      };
    }
  }

  // Unreachable for real tz data (would need two transitions within 48h). Defer to Luxon, which also
  // shifts forward out of gaps, so behaviour stays well defined.
  const dt = DateTime.fromObject(
    {
      year: wc.year,
      month: wc.month,
      day: wc.day,
      hour: wc.hour,
      minute: wc.minute,
      second: wc.second,
    },
    { zone },
  );
  return {
    instant: dt.toJSDate(),
    offsetMinutes: dt.offset,
    warning: "NONEXISTENT_LOCAL_TIME_SHIFTED",
    wallClock: instantToWallClock(dt.toJSDate(), tz),
  };
}

/** Input of `localToInstant`: what a person typed, plus the zone it was typed in. */
export interface LocalToInstantInput {
  /** `YYYY-MM-DD` */
  date: LocalDateString;
  /** `HH:mm` */
  time: LocalTimeString;
  /** IANA zone, e.g. `Europe/London`. */
  timezone: string;
}

/** Result of `localToInstant`. */
export interface LocalToInstantResult {
  /** The UTC instant. */
  instant: Date;
  /** Set when the local time did not exist (moved forward) or existed twice (first occurrence used). */
  warning?: LocalTimeWarning;
  /** Set only when the input time did not exist and was moved forward; the `HH:mm` actually used. */
  normalisedLocalTime?: LocalTimeString;
}

/**
 * Converts a local date + `HH:mm` in `timezone` to a UTC instant, applying the DST rules at the top of this
 * file, e.g. Europe/London `2026-03-29 01:30` → `01:30Z` (02:30 BST, `NONEXISTENT_LOCAL_TIME_SHIFTED`) and
 * `2026-10-25 01:30` → `00:30Z` (the BST occurrence, `AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE`).
 * Throws `AppError("VALIDATION_ERROR")` (`details.field` = `date` | `time`) for malformed or impossible
 * values and `AppError("INVALID_TIMEZONE")` for unknown zones.
 */
export function localToInstant(input: LocalToInstantInput): LocalToInstantResult {
  assertTimeZone(input.timezone);
  if (!isValidLocalDate(input.date)) {
    throw new AppError("VALIDATION_ERROR", `Invalid local date ${JSON.stringify(input.date)}`, {
      details: { field: "date", value: input.date },
    });
  }
  if (!isValidLocalTime(input.time)) {
    throw new AppError("VALIDATION_ERROR", `Invalid local time ${JSON.stringify(input.time)}`, {
      details: { field: "time", value: input.time },
    });
  }
  const { year, month, day } = splitLocalDate(input.date);
  const { hour, minute } = splitLocalTime(input.time);
  const resolved = resolveWallClock({ year, month, day, hour, minute, second: 0 }, input.timezone);
  const result: LocalToInstantResult = { instant: resolved.instant };
  if (resolved.warning) {
    result.warning = resolved.warning;
    if (resolved.warning === "NONEXISTENT_LOCAL_TIME_SHIFTED") {
      result.normalisedLocalTime = formatLocalTime(
        resolved.wallClock.hour,
        resolved.wallClock.minute,
      );
    }
  }
  return result;
}

/** Local calendar view of an instant, returned by `instantToLocal`. */
export interface LocalDateTimeParts {
  /** `YYYY-MM-DD` */
  date: LocalDateString;
  /** `HH:mm` */
  time: LocalTimeString;
  /** Minutes east of UTC in force at the instant (e.g. 60 for BST, -300 for EST). */
  offsetMinutes: number;
  /** 1 = Monday … 7 = Sunday. */
  weekday: IsoWeekday;
  /** Full-precision ISO-8601 with offset, e.g. `2026-10-06T09:00:00+01:00`. */
  iso: string;
}

/**
 * Local calendar view of `instant` in `timezone` (date, `HH:mm`, offset, ISO weekday, ISO string with
 * offset). Seconds are dropped from `time` but kept in `iso`.
 */
export function instantToLocal(instant: Date, timezone: string): LocalDateTimeParts {
  const zone = zoneOf(timezone);
  assertInstant(instant, "instant");
  const dt = DateTime.fromJSDate(instant, { zone });
  const iso = dt.toISO({ suppressMilliseconds: true });
  if (!dt.isValid || iso === null) {
    throw new AppError("VALIDATION_ERROR", `Cannot represent instant in ${timezone}`, {
      details: { timezone, instant: instant.toISOString() },
    });
  }
  return {
    date: formatLocalDate(dt.year, dt.month, dt.day),
    time: formatLocalTime(dt.hour, dt.minute),
    offsetMinutes: dt.offset,
    weekday: dt.weekday as IsoWeekday,
    iso,
  };
}

/**
 * Components the iOS app feeds to `DeviceActivitySchedule` (`DateComponents`) for `instant`, as the
 * wall-clock in `timezone` with the offset in force AT that instant. `month` is 1–12; milliseconds are
 * dropped. Examples (Europe/London): `2026-03-29T05:00Z` → 06:00 BST on the 29th (the spring-forward day);
 * `2026-10-25T00:30Z` and `2026-10-25T01:30Z` → 01:30 on the 25th both times (BST, then GMT).
 *
 * DST handling: a 22:00–06:00 shift yields 22:00 / 06:00 whether or not a transition happens overnight —
 * what the device schedule needs, because iOS resolves `DateComponents` against the device calendar at run
 * time. Two caveats callers must respect: (1) the device's timezone must equal `timezone` (pass the
 * device's reported zone when it differs, or the schedule fires at the wrong wall time); (2) during a
 * fall-back overlap hour the same components occur twice — the components alone cannot say which — so use
 * the UTC instant for anything that must be exact (status derivation, audit), and the components only for
 * the device schedule.
 */
export function toDeviceDateComponents(instant: Date, timezone: string): WallClock {
  return instantToWallClock(instant, timezone);
}

// ---------------------------------------------------------------------------------------------------------
// Local day / week boundaries
// ---------------------------------------------------------------------------------------------------------

function localDateTime(instant: Date, tz: string): DateTime {
  const zone = zoneOf(tz);
  assertInstant(instant, "instant");
  return DateTime.fromJSDate(instant, { zone });
}

/** First instant of the local calendar day containing `instant` (handles zones where midnight is skipped). */
export function startOfLocalDay(instant: Date, timezone: string): Date {
  return localDateTime(instant, timezone).startOf("day").toJSDate();
}

/**
 * EXCLUSIVE end of the local calendar day containing `instant` — i.e. the first instant of the next local
 * day. Pair with `startOfLocalDay` for half-open `[start, end)` queries.
 */
export function endOfLocalDay(instant: Date, timezone: string): Date {
  return localDateTime(instant, timezone)
    .startOf("day")
    .plus({ days: 1 })
    .startOf("day")
    .toJSDate();
}

/** Start-of-day instant for a `YYYY-MM-DD` in `tz`. */
function localMidnight(date: LocalDateString, tz: string): DateTime {
  const { year, month, day } = splitLocalDate(date);
  return DateTime.fromObject({ year, month, day }, { zone: IANAZone.create(tz) }).startOf("day");
}

function assertLocalDate(date: string, field: string): void {
  if (!isValidLocalDate(date)) {
    throw new AppError("VALIDATION_ERROR", `Invalid local date ${JSON.stringify(date)}`, {
      details: { field, value: date },
    });
  }
}

/**
 * Half-open instant range covering the inclusive local date span `fromDate..toDate` in `tz`:
 * `[startOfLocalDay(fromDate), startOfLocalDay(toDate + 1 day))`. Throws when `toDate < fromDate`.
 */
export function localDateRange(
  fromDate: LocalDateString,
  toDate: LocalDateString,
  timezone: string,
): [Date, Date] {
  assertTimeZone(timezone);
  assertLocalDate(fromDate, "fromDate");
  assertLocalDate(toDate, "toDate");
  if (toDate < fromDate) {
    throw new AppError("VALIDATION_ERROR", "toDate must not be before fromDate", {
      details: { fromDate, toDate },
    });
  }
  const start = localMidnight(fromDate, timezone);
  const end = localMidnight(addLocalDays(toDate, 1), timezone);
  return [start.toJSDate(), end.toJSDate()];
}

/**
 * Pure calendar arithmetic on a `YYYY-MM-DD` (no timezone involved). `n` may be negative. Throws
 * `AppError("VALIDATION_ERROR")` for an invalid date or a non-integer `n`.
 */
export function addLocalDays(date: LocalDateString, n: number): LocalDateString {
  assertLocalDate(date, "date");
  if (!Number.isInteger(n)) {
    throw new AppError("VALIDATION_ERROR", "n must be an integer number of days", {
      details: { n },
    });
  }
  const { year, month, day } = splitLocalDate(date);
  const d = new Date(calendarToUtcMs(year, month, day + n));
  return formatLocalDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** Local date of `instant` in `tz` as `YYYY-MM-DD`. */
export function localDateOf(instant: Date, timezone: string): LocalDateString {
  const wc = instantToWallClock(instant, timezone);
  return formatLocalDate(wc.year, wc.month, wc.day);
}

/**
 * Start (first instant) of the local week containing `instant`. `weekStartsOn` is an ISO weekday
 * (1 = Monday, default; 7 = Sunday).
 */
export function weekStart(instant: Date, timezone: string, weekStartsOn: IsoWeekday = 1): Date {
  if (!Number.isInteger(weekStartsOn) || weekStartsOn < 1 || weekStartsOn > 7) {
    throw new AppError("VALIDATION_ERROR", "weekStartsOn must be an ISO weekday 1–7", {
      details: { weekStartsOn },
    });
  }
  const dt = localDateTime(instant, timezone);
  const daysBack = (dt.weekday - weekStartsOn + 7) % 7;
  return dt.startOf("day").minus({ days: daysBack }).startOf("day").toJSDate();
}

/**
 * Nominal wall-clock minutes from `a` to `b` in `tz`, ignoring DST: 22:00 → 06:00 is 480 even on a
 * transition night (where the absolute `minutesBetween` is 420 or 540). This is the duration a manager
 * means when they type a shift, and the one to pass to `expandRecurrence`.
 */
export function wallClockMinutesBetween(a: Date, b: Date, timezone: string): number {
  const fa = wallClockToFloatingMs(instantToWallClock(a, timezone));
  const fb = wallClockToFloatingMs(instantToWallClock(b, timezone));
  return (fb - fa) / MS_PER_MINUTE;
}

/** True when `wc` is a real calendar date with an in-range time of day (guard for hand-built `WallClock`s). */
export function isValidWallClock(wc: WallClock): boolean {
  return (
    isValidCalendarDate(wc.year, wc.month, wc.day) &&
    Number.isInteger(wc.hour) &&
    wc.hour >= 0 &&
    wc.hour <= 23 &&
    Number.isInteger(wc.minute) &&
    wc.minute >= 0 &&
    wc.minute <= 59 &&
    Number.isInteger(wc.second) &&
    wc.second >= 0 &&
    wc.second <= 59
  );
}
