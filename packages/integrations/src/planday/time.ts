import { calendarToUtcMs } from "@clockoff/shared/time/parse";
import type { ShiftTimeWarning } from "@clockoff/shared/time/shift";
import {
  canonicalTimeZone,
  instantToWallClock,
  isValidWallClock,
  localDateOf,
  resolveWallClock,
  type LocalTimeWarning,
  type WallClock,
} from "@clockoff/shared/time/zone";
import { MAX_SHIFT_DURATION_MS, MIN_SHIFT_DURATION_MS } from "./constants";
import { PlandayError } from "./errors";

/**
 * Planday date-time handling (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §4.8, notes §10.3). Planday does not
 * document whether shift times are UTC, offset-bearing or local wall-clock, so the rule is provisional until the
 * demo-portal gate: a value with `Z` or `±hh:mm` is an instant; a value without is wall-clock time in the shift's
 * IANA zone (else the portal's), resolved by the shared DST rules (gap → moved forward, overlap → first
 * occurrence). A shift's `date` refers to its start, so it must equal the local date of the parsed start: a
 * mismatch means the encoding assumption is wrong for the portal and fails the whole page.
 */

const INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})$/i;
const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:?00)?)?$/i;

/** Why a date-time string could not be turned into an instant. */
export type PlandayTimeErrorReason = "MALFORMED" | "INVALID_ZONE";

/** Thrown by `parsePlandayDateTime`; record-level (the caller skips the record with INVALID_TIME). */
export class PlandayTimeError extends Error {
  readonly reason: PlandayTimeErrorReason;

  constructor(reason: PlandayTimeErrorReason) {
    super(`Planday date-time could not be read (${reason})`);
    this.name = "PlandayTimeError";
    this.reason = reason;
  }
}

export interface ParsedPlandayDateTime {
  readonly instant: Date;
  /** Set when a wall-clock value fell into a DST gap (moved forward) or overlap (first occurrence). */
  readonly warning?: LocalTimeWarning;
}

function fractionMs(fraction: string | undefined): number {
  if (!fraction) return 0;
  return Math.floor(Number(`0.${fraction}`) * 1000);
}

function wallClockFrom(match: RegExpExecArray): WallClock | null {
  const wc: WallClock = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: match[6] ? Number(match[6]) : 0,
  };
  return isValidWallClock(wc) ? wc : null;
}

function offsetMinutes(token: string): number | null {
  if (token.toUpperCase() === "Z") return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(token);
  if (!m) return null;
  const hours = Number(m[2]);
  const minutes = Number(m[3]);
  if (hours > 18 || minutes > 59) return null;
  return (m[1] === "-" ? -1 : 1) * (hours * 60 + minutes);
}

/**
 * Parses one Planday date-time. With `Z` or an offset the value is an instant and `zone` is not used; without, it
 * is wall-clock time in `zone`, which must be an IANA zone. Throws {@link PlandayTimeError}.
 */
export function parsePlandayDateTime(value: string, zone: string): ParsedPlandayDateTime {
  const trimmed = value.trim();
  const instantMatch = INSTANT_RE.exec(trimmed);
  if (instantMatch) {
    const wc = wallClockFrom(instantMatch);
    const offset = offsetMinutes(instantMatch[8] as string);
    if (!wc || offset === null) throw new PlandayTimeError("MALFORMED");
    const floating = calendarToUtcMs(wc.year, wc.month, wc.day, wc.hour, wc.minute, wc.second);
    return { instant: new Date(floating - offset * 60_000 + fractionMs(instantMatch[7])) };
  }
  const wallMatch = WALL_CLOCK_RE.exec(trimmed);
  if (!wallMatch) throw new PlandayTimeError("MALFORMED");
  const wc = wallClockFrom(wallMatch);
  if (!wc) throw new PlandayTimeError("MALFORMED");
  const canonical = canonicalTimeZone(zone);
  if (!canonical) throw new PlandayTimeError("INVALID_ZONE");
  const resolved = resolveWallClock(wc, canonical);
  const instant = new Date(resolved.instant.getTime() + fractionMs(wallMatch[7]));
  return resolved.warning ? { instant, warning: resolved.warning } : { instant };
}

/**
 * A Planday `format: date` value (`YYYY-MM-DD`, also accepted with a midnight time part) as `YYYY-MM-DD`, or null
 * when it is not one.
 */
export function parsePlandayDate(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const m = DATE_RE.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const wc: WallClock = { year, month, day, hour: 0, minute: 0, second: 0 };
  return isValidWallClock(wc) ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * An HR date such as `deactivationDate` (`format: date`, sometimes a date-time) as the instant it takes effect:
 * a date-time with an offset is that instant; a bare date or a wall-clock date-time is read in `zone` (the
 * portal's, else UTC). Returns null for null, empty or unreadable values.
 */
export function parsePlandayEffectiveDate(
  value: string | null | undefined,
  zone: string,
): Date | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  // A bare date takes effect at the start of that day in the zone.
  const text = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00` : trimmed;
  try {
    return parsePlandayDateTime(text, canonicalTimeZone(zone) ?? "UTC").instant;
  } catch {
    return null;
  }
}

/** Why a shift's times were rejected (record-level INVALID_TIME, §4.8). */
export type ShiftTimeInvalidReason =
  | "MISSING_TIME"
  | "MALFORMED_TIME"
  | "INVALID_ZONE"
  | "END_NOT_AFTER_START"
  | "TOO_LONG"
  | "TOO_SHORT";

export type ShiftInstantsResult =
  | {
      readonly ok: true;
      readonly startsAt: Date;
      readonly endsAt: Date;
      /** The IANA zone used: the shift's `timeZone`, else the portal's (canonical spelling). */
      readonly timezone: string;
      /** The local start date differs from the local end date in `timezone`. */
      readonly isOvernight: boolean;
      /** `YYYY-MM-DD` of `startsAt` in `timezone` (compared with the shift's `date`). */
      readonly localStartDate: string;
      /** The first DST adjustment applied (start before end), e.g. `START_AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE`. */
      readonly timeWarning: ShiftTimeWarning | null;
    }
  | {
      readonly ok: false;
      readonly reason: ShiftTimeInvalidReason;
    };

/** The time fields of a raw Planday shift. */
export interface RawShiftTimes {
  readonly startDateTime: string | null;
  readonly endDateTime: string | null;
  readonly timeZone: string | null;
}

/**
 * Resolves a shift's start and end (§4.8): both required; the zone is the shift's `timeZone` (it must be IANA: a
 * Windows id is not mapped, notes §10.3 rule 3), else the portal's; `end > start`; at most 25 h; at least 15 min.
 * Never throws for bad times: the caller skips the record with INVALID_TIME.
 */
export function toShiftInstants(
  raw: RawShiftTimes,
  portalZone: string | null,
): ShiftInstantsResult {
  if (!raw.startDateTime || !raw.endDateTime) return { ok: false, reason: "MISSING_TIME" };
  const shiftZone = raw.timeZone && raw.timeZone.trim() !== "" ? raw.timeZone.trim() : null;
  const zoneInput = shiftZone ?? portalZone;
  const timezone = zoneInput ? canonicalTimeZone(zoneInput) : null;
  if (!timezone) return { ok: false, reason: "INVALID_ZONE" };
  let start: ParsedPlandayDateTime;
  let end: ParsedPlandayDateTime;
  try {
    start = parsePlandayDateTime(raw.startDateTime, timezone);
    end = parsePlandayDateTime(raw.endDateTime, timezone);
  } catch (err) {
    if (err instanceof PlandayTimeError) {
      return {
        ok: false,
        reason: err.reason === "INVALID_ZONE" ? "INVALID_ZONE" : "MALFORMED_TIME",
      };
    }
    throw err;
  }
  const duration = end.instant.getTime() - start.instant.getTime();
  if (duration <= 0) return { ok: false, reason: "END_NOT_AFTER_START" };
  if (duration > MAX_SHIFT_DURATION_MS) return { ok: false, reason: "TOO_LONG" };
  if (duration < MIN_SHIFT_DURATION_MS) return { ok: false, reason: "TOO_SHORT" };
  const localStartDate = localDateOf(start.instant, timezone);
  const localEndDate = localDateOf(end.instant, timezone);
  const timeWarning: ShiftTimeWarning | null = start.warning
    ? `START_${start.warning}`
    : end.warning
      ? `END_${end.warning}`
      : null;
  return {
    ok: true,
    startsAt: start.instant,
    endsAt: end.instant,
    timezone,
    isOvernight: localStartDate !== localEndDate,
    localStartDate,
    timeWarning,
  };
}

/**
 * The encoding cross-check (§4.8): when the shift has a `date`, it must equal the local date of its parsed start.
 * Throws PLANDAY_INVALID_RESPONSE `TIME_ENCODING_MISMATCH`, which fails the page before anything of it is written.
 * It catches, for example, UTC times sent without `Z` for shifts starting within the UTC offset of midnight.
 */
export function assertShiftDateMatchesStart(
  date: string | null,
  times: ShiftInstantsResult,
  pathTemplate?: string,
): void {
  if (date === null || !times.ok) return;
  if (date !== times.localStartDate) {
    throw new PlandayError("PLANDAY_INVALID_RESPONSE", {
      reason: "TIME_ENCODING_MISMATCH",
      ...(pathTemplate !== undefined ? { pathTemplate } : {}),
    });
  }
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * `yyyy-mm-ddThh:mm:ssZ`, the documented format of HR and Scheduling date-time filters (`deactivatedFrom`,
 * `deletedFrom`; notes §9.2, §9.3).
 */
export function formatPlandayUtcDateTime(instant: Date): string {
  return `${instant.toISOString().slice(0, 19)}Z`;
}

/**
 * `YYYY-MM-DDTHH:mm` wall-clock time in `zone`: the Punch Clock list's documented `from` / `to` example format
 * (notes §9.4; their zone is undocumented, Q43, so the portal zone is used).
 */
export function formatPlandayWallClock(instant: Date, zone: string): string {
  const wc = instantToWallClock(instant, zone);
  return `${wc.year}-${pad2(wc.month)}-${pad2(wc.day)}T${pad2(wc.hour)}:${pad2(wc.minute)}`;
}
