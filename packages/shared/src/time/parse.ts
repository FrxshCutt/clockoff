/**
 * Lenient parsers for the date/time strings managers type or upload (§6.4, CSV import §7). They normalise
 * to the canonical wire formats used everywhere else in this module:
 *   - local date  → `YYYY-MM-DD`
 *   - local time  → `HH:mm` (24-hour, zero padded)
 * They never touch timezones; conversion to instants happens in `zone.ts`.
 */
import type { DateFormat } from "../enums";

/** `YYYY-MM-DD` local calendar date (no timezone). */
export type LocalDateString = string;
/** `HH:mm` 24-hour local wall-clock time (no timezone). */
export type LocalTimeString = string;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Smallest 4-digit year `parseDateString` accepts; earlier years are treated as typos. */
export const MIN_PARSE_YEAR = 1900;
/** Largest 4-digit year `parseDateString` accepts; later years are treated as typos. */
export const MAX_PARSE_YEAR = 2999;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Number of days in `month` (1–12) of `year`. */
export function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

/** True when year/month/day denote a real proleptic-Gregorian calendar date. */
export function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

/**
 * Milliseconds since the epoch for proleptic-Gregorian components read as UTC ("floating" time). Unlike
 * `Date.UTC`, years 0–99 are NOT remapped to 1900–1999, so `0026-10-06` stays in year 26. Out-of-range
 * components roll over the way `Date.UTC` does (`day = 32` is the 1st of the next month), which is what
 * calendar arithmetic such as `addLocalDays` relies on. `month` is 1–12.
 */
export function calendarToUtcMs(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, minute, second, 0);
  return d.getTime();
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Formats calendar components as `YYYY-MM-DD`. */
export function formatLocalDate(year: number, month: number, day: number): LocalDateString {
  return `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
}

/** Formats wall-clock components as `HH:mm`. */
export function formatLocalTime(hour: number, minute: number): LocalTimeString {
  return `${pad2(hour)}:${pad2(minute)}`;
}

/** Strict guard for the canonical `YYYY-MM-DD` form (also rejects impossible dates such as 2026-02-30). */
export function isValidLocalDate(value: unknown): value is LocalDateString {
  if (typeof value !== "string") return false;
  const m = ISO_DATE_RE.exec(value);
  if (!m) return false;
  return isValidCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** Strict guard for the canonical `HH:mm` form (00:00–23:59). */
export function isValidLocalTime(value: unknown): value is LocalTimeString {
  return typeof value === "string" && HHMM_RE.test(value);
}

/** Splits a validated `YYYY-MM-DD` into numbers. Throws on malformed input — validate first. */
export function splitLocalDate(date: LocalDateString): {
  year: number;
  month: number;
  day: number;
} {
  const m = ISO_DATE_RE.exec(date);
  if (!m || !isValidCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]))) {
    throw new TypeError(
      `splitLocalDate: expected a valid YYYY-MM-DD date, got ${JSON.stringify(date)}`,
    );
  }
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** Splits a validated `HH:mm` into numbers. Throws on malformed input — validate first. */
export function splitLocalTime(time: LocalTimeString): { hour: number; minute: number } {
  const m = HHMM_RE.exec(time);
  if (!m) {
    throw new TypeError(`splitLocalTime: expected HH:mm, got ${JSON.stringify(time)}`);
  }
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

function toHHmm(hour: number, minute: number): LocalTimeString | null {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return formatLocalTime(hour, minute);
}

/** `9pm`, `9:30 pm`, `9.30 p.m.`, `9:30:15 PM` (seconds dropped). */
const AMPM_SEPARATED_RE = /^(\d{1,2})(?:[:.](\d{2})(?::[0-5]\d)?)?\s*([ap])\.?\s*m\.?$/;
/** `930pm`, `1230 am`. */
const AMPM_COMPACT_RE = /^(\d{1,2})(\d{2})\s*([ap])\.?\s*m\.?$/;

/**
 * Parses a human-entered time of day into `HH:mm`, or `null` when it cannot be understood.
 *
 * Accepted forms (case-insensitive, surrounding whitespace ignored):
 *   - 24-hour: `HH:mm`, `H:mm`, `HH:mm:ss` (seconds dropped), `HH.mm` / `H.mm`, `HHmm`, `Hmm`;
 *   - 12-hour: `9am`, `9 am`, `9 a.m.`, `9:30pm`, `9.30 p.m.`, `9:30:00 PM` (seconds dropped), `930pm`;
 *     `12am` / `12:15am` → `00:00` / `00:15` (midnight hour), `12pm` → `12:00` (noon).
 * Rejected: `24:00`, bare hours without am/pm (`9`), `0am` / `13pm`, minutes or seconds above 59, words
 * (`noon`), anything else.
 */
export function parseTimeString(input: string): LocalTimeString | null {
  if (typeof input !== "string") return null;
  const s = input.trim().toLowerCase();
  if (!s) return null;

  const ampm = AMPM_SEPARATED_RE.exec(s) ?? AMPM_COMPACT_RE.exec(s);
  if (ampm) {
    const h12 = Number(ampm[1]);
    const minute = ampm[2] === undefined ? 0 : Number(ampm[2]);
    if (h12 < 1 || h12 > 12) return null;
    const isPm = ampm[3] === "p";
    const hour = (h12 % 12) + (isPm ? 12 : 0);
    return toHHmm(hour, minute);
  }

  // 24-hour with ':' (optionally seconds) or '.' separator.
  const sep = /^(\d{1,2})[:.](\d{2})(?::([0-5]\d))?$/.exec(s);
  if (sep) {
    return toHHmm(Number(sep[1]), Number(sep[2]));
  }

  // Compact HHmm / Hmm.
  const compact = /^(\d{3,4})$/.exec(s);
  if (compact) {
    const digits = compact[1]!;
    const hour = Number(digits.slice(0, digits.length - 2));
    const minute = Number(digits.slice(-2));
    return toHHmm(hour, minute);
  }

  return null;
}

function resolveYear(raw: string): number | null {
  if (raw.length === 4) {
    const y = Number(raw);
    return y >= MIN_PARSE_YEAR && y <= MAX_PARSE_YEAR ? y : null;
  }
  if (raw.length === 2) {
    // Two-digit years are always this century: shift rotas never refer to the 1900s.
    return 2000 + Number(raw);
  }
  return null;
}

/**
 * Parses a human-entered calendar date into `YYYY-MM-DD`, or `null` when it cannot be understood.
 *
 * Year-first dates (`YYYY-MM-DD`, `YYYY/M/D`, `YYYY.MM.DD`) are unambiguous and accepted for every
 * `format`. Otherwise the three numeric fields are separated by `/`, `-` or `.` (the same separator twice)
 * and read in the organisation's order — never guessed from the values:
 *   - `DMY`: `DD/MM/YYYY`, `D/M/YY`, `DD-MM-YYYY`, `DD.MM.YYYY`
 *   - `MDY`: `MM/DD/YYYY`, `M/D/YY`, `MM-DD-YYYY`, `MM.DD.YYYY`
 *   - `YMD`: year-first only (a two-digit year first, `26/10/06`, is rejected as ambiguous).
 * Two-digit years map to 20YY. Impossible dates (`31/02/2026`, `29/02/2027`, `31/04/2026`) and four-digit
 * years outside [MIN_PARSE_YEAR, MAX_PARSE_YEAR] return `null`.
 */
export function parseDateString(input: string, format: DateFormat): LocalDateString | null {
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (!s) return null;

  const m = /^(\d{1,4})([/.-])(\d{1,2})\2(\d{1,4})$/.exec(s);
  if (!m) return null;
  const a = m[1]!;
  const b = m[3]!;
  const c = m[4]!;

  let year: number | null;
  let month: number;
  let day: number;
  if (a.length === 4) {
    // Year first: unambiguous whatever the organisation's order.
    if (c.length > 2) return null;
    year = resolveYear(a);
    month = Number(b);
    day = Number(c);
  } else {
    switch (format) {
      case "DMY": {
        if (a.length > 2) return null;
        day = Number(a);
        month = Number(b);
        year = resolveYear(c);
        break;
      }
      case "MDY": {
        if (a.length > 2) return null;
        month = Number(a);
        day = Number(b);
        year = resolveYear(c);
        break;
      }
      case "YMD": {
        return null;
      }
      default: {
        const _exhaustive: never = format;
        throw new TypeError(`parseDateString: unknown date format ${String(_exhaustive)}`);
      }
    }
  }

  if (year === null) return null;
  return isValidCalendarDate(year, month, day) ? formatLocalDate(year, month, day) : null;
}
