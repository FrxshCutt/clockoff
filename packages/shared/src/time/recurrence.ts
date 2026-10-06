/**
 * Recurring-shift materialisation (§6.4). A series is stored as an RFC 5545 RRULE *without* DTSTART, plus
 * the anchor (first) shift's instants. Occurrences are expanded in the LOCAL wall-clock of the series
 * timezone: a weekly 09:00 shift stays 09:00 local on both sides of a DST change, and an overnight
 * 22:00–06:00 shift keeps those local times (so its absolute length is 7h/9h on transition nights, exactly
 * like a manually entered shift). Each floating (wall-clock) occurrence is resolved to a UTC instant with the
 * DST rules in `zone.ts` (gaps shift forward, overlaps take the first occurrence).
 *
 * Why not `rrule`'s iterator: it only evaluates its stop conditions on dates that MATCH the rule, so a rule
 * that never matches (e.g. `FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30`) iterates day by day to the year 9999 —
 * ~5 s of blocked event loop per request. This module iterates periods itself, bounded by `until`, for the
 * supported subset below; the test suite cross-checks it against `rrule` on productive rules.
 *
 * Supported subset (what shift rotas need; validated by `validateRecurrenceRule`):
 *   FREQ=DAILY|WEEKLY|MONTHLY, INTERVAL, COUNT, BYMONTH, BYMONTHDAY (not with WEEKLY),
 *   BYDAY (ordinals such as `1MO` / `-1FR` only with MONTHLY), BYSETPOS (needs another BY* part), WKST.
 *
 * Entry points: `expandShiftSeries` for the typed form (date + HH:mm times, the usual API path) and
 * `expandRecurrence` when only the first shift's instants are known.
 */
import { AppError } from "../errors";
import {
  calendarToUtcMs,
  daysInMonth,
  formatLocalDate,
  isValidLocalDate,
  splitLocalDate,
  splitLocalTime,
  type LocalDateString,
  type LocalTimeString,
} from "./parse";
import { buildShiftInstants, type ShiftTimeWarning } from "./shift";
import {
  assertTimeZone,
  floatingMsToWallClock,
  instantToWallClock,
  localDateRange,
  resolveWallClock,
  wallClockToFloatingMs,
  type IsoWeekday,
} from "./zone";

/** Frequencies a shift series may use (the same set the validation package's `rruleSchema` allows). */
export const RECURRENCE_FREQUENCIES = ["DAILY", "WEEKLY", "MONTHLY"] as const;
/** One of `RECURRENCE_FREQUENCIES`. */
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

/** RFC 5545 weekday codes in ISO order: index + 1 is the ISO weekday (MO = 1 … SU = 7). */
export const RECURRENCE_WEEKDAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
/** One of `RECURRENCE_WEEKDAY_CODES`. */
export type RecurrenceWeekdayCode = (typeof RECURRENCE_WEEKDAY_CODES)[number];

/** Keys a rule may contain, in the canonical order `validateRecurrenceRule` emits them. */
export const RECURRENCE_RULE_KEYS = [
  "FREQ",
  "INTERVAL",
  "COUNT",
  "BYMONTH",
  "BYMONTHDAY",
  "BYDAY",
  "BYSETPOS",
  "WKST",
] as const;
/** One of `RECURRENCE_RULE_KEYS`. */
export type RecurrenceRuleKey = (typeof RECURRENCE_RULE_KEYS)[number];

const UNSUPPORTED_KEY_MESSAGES: Readonly<Record<string, string>> = {
  UNTIL: "UNTIL is not supported; pass the series end as `until` when expanding",
  DTSTART: "DTSTART must not be embedded in the rule; the first shift provides the start",
  TZID: "TZID must not be embedded in the rule; the series timezone provides it",
  BYHOUR: "BYHOUR is not supported; the time of day comes from the first shift",
  BYMINUTE: "BYMINUTE is not supported; the time of day comes from the first shift",
  BYSECOND: "BYSECOND is not supported; the time of day comes from the first shift",
  BYYEARDAY: "BYYEARDAY is not supported for shift series",
  BYWEEKNO: "BYWEEKNO is not supported for shift series",
  BYEASTER: "BYEASTER is not supported",
  EXDATE: "EXDATE is not supported; cancel individual shifts instead",
  RDATE: "RDATE is not supported; add individual shifts instead",
  EXRULE: "EXRULE is not supported",
};

const UNSUPPORTED_FREQUENCY_MESSAGES: Readonly<Record<string, string>> = {
  SECONDLY: "FREQ=SECONDLY is not supported; shifts recur at most daily",
  MINUTELY: "FREQ=MINUTELY is not supported; shifts recur at most daily",
  HOURLY: "FREQ=HOURLY is not supported; shifts recur at most daily",
  YEARLY: "FREQ=YEARLY is not supported; use FREQ=MONTHLY;INTERVAL=12",
};

/** Largest INTERVAL `validateRecurrenceRule` accepts. */
export const MAX_RECURRENCE_INTERVAL = 366;
/** Largest COUNT `validateRecurrenceRule` accepts (expansion is still capped by `max`). */
export const MAX_RECURRENCE_COUNT = 10_000;
/** Longest rule string (characters, after trimming) `validateRecurrenceRule` accepts. */
export const MAX_RECURRENCE_RULE_LENGTH = 512;
/** Default `max` for `expandRecurrence` / `expandShiftSeries`. */
export const DEFAULT_RECURRENCE_MAX = 400;
/** Absolute ceiling for `max` in `expandRecurrence`. */
export const RECURRENCE_HARD_MAX = 5_000;
/** `expandRecurrence` rejects windows (`until - firstStartsAt`) longer than this (~10 years). */
export const RECURRENCE_MAX_SPAN_DAYS = 3_660;

/** One BYDAY entry: a weekday, optionally with an ordinal (MONTHLY only). */
export interface RecurrenceByDay {
  /** ISO weekday, 1 = Monday … 7 = Sunday. */
  weekday: IsoWeekday;
  /** MONTHLY only: 1..5 = nth weekday of the month, -1..-5 = nth from the end. Absent = every such weekday. */
  ordinal?: number;
}

/** Structured form of a validated rule. Lists are sorted and de-duplicated; empty = part not present. */
export interface ParsedRecurrenceRule {
  /** FREQ. */
  freq: RecurrenceFrequency;
  /** INTERVAL, 1..MAX_RECURRENCE_INTERVAL (default 1). */
  interval: number;
  /** COUNT (including the first shift), or `null` when absent. */
  count: number | null;
  /** 1..12 */
  byMonth: number[];
  /** ±1..31 (negative counts from the end of the month: -1 = last day). */
  byMonthDay: number[];
  /** BYDAY entries sorted by weekday, then ordinal. */
  byDay: RecurrenceByDay[];
  /** ±1..366, positions within each period's candidate set. */
  bySetPos: number[];
  /** Week start for WEEKLY periods (RFC default MO = 1). */
  wkst: IsoWeekday;
}

/**
 * Result of `validateRecurrenceRule`: `{ ok: true, normalised, frequency, parsed }` or
 * `{ ok: false, error }`. Both arms declare every key, so `const { ok, error } = …` type-checks.
 */
export type RecurrenceValidation =
  | {
      ok: true;
      error?: undefined;
      /** Canonical form for storage: upper-case, canonical key order, no `RRULE:` prefix. */
      normalised: string;
      frequency: RecurrenceFrequency;
      parsed: ParsedRecurrenceRule;
    }
  | { ok: false; error: string; normalised?: undefined; frequency?: undefined; parsed?: undefined };

function fail(error: string): RecurrenceValidation {
  return { ok: false, error };
}

type ListResult = { ok: true; values: number[] } | { ok: false; error: string };

function parseIntList(key: string, value: string, opts: { max: number; allowNegative: boolean }): ListResult {
  const values = new Set<number>();
  for (const raw of value.split(",")) {
    if (!/^[+-]?\d{1,4}$/.test(raw)) {
      return { ok: false, error: `${key} contains a non-integer value ${JSON.stringify(raw)}` };
    }
    const n = Number(raw);
    if (n < 0 && !opts.allowNegative) return { ok: false, error: `${key} must not be negative` };
    if (n === 0 || Math.abs(n) > opts.max) {
      return {
        ok: false,
        error: `${key} values must be ${opts.allowNegative ? `±1..${opts.max}` : `1..${opts.max}`}, got ${raw}`,
      };
    }
    values.add(n);
  }
  return { ok: true, values: [...values].sort((a, b) => a - b) };
}

/** Longest each month can be (February counts its leap day). */
const MAX_MONTH_LENGTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function weekdayFromCode(code: string): IsoWeekday | null {
  const idx = (RECURRENCE_WEEKDAY_CODES as readonly string[]).indexOf(code);
  return idx === -1 ? null : ((idx + 1) as IsoWeekday);
}

function weekdayCode(weekday: IsoWeekday): RecurrenceWeekdayCode {
  return RECURRENCE_WEEKDAY_CODES[weekday - 1]!;
}

function compareByDay(a: RecurrenceByDay, b: RecurrenceByDay): number {
  if (a.weekday !== b.weekday) return a.weekday - b.weekday;
  return (a.ordinal ?? 0) - (b.ordinal ?? 0);
}

/**
 * Validates an RFC 5545 RRULE string for use as a shift series. Returns the canonical form for storage and
 * the parsed structure, or a specific human-readable error. Never throws.
 *
 * Accepts an optional `RRULE:` prefix and any letter case. Rejects (with a reason): UNTIL (use `until`),
 * DTSTART/TZID, BYHOUR/BYMINUTE/BYSECOND, BYYEARDAY/BYWEEKNO, EXDATE/RDATE/EXRULE, FREQ other than
 * DAILY/WEEKLY/MONTHLY, duplicate or unknown keys, BYDAY ordinals outside MONTHLY, BYMONTHDAY with WEEKLY,
 * BYSETPOS without another BY* part, and BYMONTH/BYMONTHDAY combinations that can never occur (31 Feb).
 */
export function validateRecurrenceRule(rule: string): RecurrenceValidation {
  if (typeof rule !== "string") return fail("Rule must be a string");
  const trimmed = rule.trim();
  if (!trimmed) return fail("Rule must not be empty");
  if (/[\r\n]/.test(trimmed)) return fail("Rule must be a single RRULE line");
  if (trimmed.length > MAX_RECURRENCE_RULE_LENGTH) return fail("Rule is too long");

  const body = trimmed.replace(/^RRULE:/i, "");
  const seen = new Map<string, string>();
  for (const rawPart of body.split(";")) {
    const part = rawPart.trim();
    if (!part) return fail("Rule contains an empty part (double ';' or trailing ';')");
    const m = /^([A-Za-z]+)=([^=\s]+)$/.exec(part);
    if (!m) return fail(`Malformed rule part ${JSON.stringify(part)}; expected KEY=VALUE`);
    const key = m[1]!.toUpperCase();
    const value = m[2]!.toUpperCase();
    if (seen.has(key)) return fail(`${key} appears more than once`);
    const unsupported = UNSUPPORTED_KEY_MESSAGES[key];
    if (unsupported) return fail(unsupported);
    if (!(RECURRENCE_RULE_KEYS as readonly string[]).includes(key)) return fail(`Unknown RRULE property ${key}`);
    seen.set(key, value);
  }

  const freqRaw = seen.get("FREQ");
  if (freqRaw === undefined) return fail("FREQ is required");
  const unsupportedFreq = UNSUPPORTED_FREQUENCY_MESSAGES[freqRaw];
  if (unsupportedFreq) return fail(unsupportedFreq);
  if (!(RECURRENCE_FREQUENCIES as readonly string[]).includes(freqRaw)) return fail(`Unknown FREQ ${freqRaw}`);
  const freq = freqRaw as RecurrenceFrequency;

  let interval = 1;
  const intervalRaw = seen.get("INTERVAL");
  if (intervalRaw !== undefined) {
    if (!/^\d{1,4}$/.test(intervalRaw)) return fail("INTERVAL must be a positive integer");
    interval = Number(intervalRaw);
    if (interval < 1 || interval > MAX_RECURRENCE_INTERVAL) {
      return fail(`INTERVAL must be 1..${MAX_RECURRENCE_INTERVAL}`);
    }
  }

  let count: number | null = null;
  const countRaw = seen.get("COUNT");
  if (countRaw !== undefined) {
    if (!/^\d{1,6}$/.test(countRaw)) return fail("COUNT must be a positive integer");
    count = Number(countRaw);
    if (count < 1 || count > MAX_RECURRENCE_COUNT) return fail(`COUNT must be 1..${MAX_RECURRENCE_COUNT}`);
  }

  let byMonth: number[] = [];
  const byMonthRaw = seen.get("BYMONTH");
  if (byMonthRaw !== undefined) {
    const r = parseIntList("BYMONTH", byMonthRaw, { max: 12, allowNegative: false });
    if (!r.ok) return fail(r.error);
    byMonth = r.values;
  }

  let byMonthDay: number[] = [];
  const byMonthDayRaw = seen.get("BYMONTHDAY");
  if (byMonthDayRaw !== undefined) {
    if (freq === "WEEKLY") return fail("BYMONTHDAY is not allowed with FREQ=WEEKLY");
    const r = parseIntList("BYMONTHDAY", byMonthDayRaw, { max: 31, allowNegative: true });
    if (!r.ok) return fail(r.error);
    byMonthDay = r.values;
  }

  const byDayMap = new Map<string, RecurrenceByDay>();
  const byDayRaw = seen.get("BYDAY");
  if (byDayRaw !== undefined) {
    for (const item of byDayRaw.split(",")) {
      const dm = /^([+-]?\d{1,2})?([A-Z]{2})$/.exec(item);
      const weekday = dm ? weekdayFromCode(dm[2]!) : null;
      if (!dm || weekday === null) return fail(`Invalid BYDAY value ${JSON.stringify(item)}`);
      const entry: RecurrenceByDay = { weekday };
      if (dm[1] !== undefined) {
        if (freq !== "MONTHLY") return fail("BYDAY ordinals (e.g. 1MO, -1FR) are only allowed with FREQ=MONTHLY");
        const ordinal = Number(dm[1]);
        if (ordinal === 0 || Math.abs(ordinal) > 5) return fail(`BYDAY ordinal must be ±1..5, got ${item}`);
        entry.ordinal = ordinal;
      }
      byDayMap.set(`${entry.ordinal ?? ""}${weekdayCode(weekday)}`, entry);
    }
  }
  const byDay = [...byDayMap.values()].sort(compareByDay);

  let bySetPos: number[] = [];
  const bySetPosRaw = seen.get("BYSETPOS");
  if (bySetPosRaw !== undefined) {
    if (byMonth.length === 0 && byMonthDay.length === 0 && byDay.length === 0) {
      return fail("BYSETPOS requires another BY* part (e.g. BYDAY)");
    }
    const r = parseIntList("BYSETPOS", bySetPosRaw, { max: 366, allowNegative: true });
    if (!r.ok) return fail(r.error);
    bySetPos = r.values;
  }

  let wkst: IsoWeekday = 1;
  const wkstRaw = seen.get("WKST");
  if (wkstRaw !== undefined) {
    const w = weekdayFromCode(wkstRaw);
    if (w === null) return fail(`Invalid WKST ${wkstRaw}`);
    wkst = w;
  }

  if (byMonth.length > 0 && byMonthDay.length > 0) {
    const possible = byMonth.some((month) =>
      byMonthDay.some((md) => Math.abs(md) <= MAX_MONTH_LENGTH[month - 1]!),
    );
    if (!possible) return fail("BYMONTHDAY never falls within the BYMONTH months (e.g. 31 February)");
  }

  const parsed: ParsedRecurrenceRule = { freq, interval, count, byMonth, byMonthDay, byDay, bySetPos, wkst };
  return { ok: true, normalised: formatRecurrenceRule(parsed), frequency: freq, parsed };
}

/** Canonical RRULE text for a parsed rule (inverse of `validateRecurrenceRule`). */
export function formatRecurrenceRule(rule: ParsedRecurrenceRule): string {
  const parts: string[] = [`FREQ=${rule.freq}`];
  if (rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.count !== null) parts.push(`COUNT=${rule.count}`);
  if (rule.byMonth.length > 0) parts.push(`BYMONTH=${rule.byMonth.join(",")}`);
  if (rule.byMonthDay.length > 0) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(",")}`);
  if (rule.byDay.length > 0) {
    parts.push(`BYDAY=${rule.byDay.map((d) => `${d.ordinal ?? ""}${weekdayCode(d.weekday)}`).join(",")}`);
  }
  if (rule.bySetPos.length > 0) parts.push(`BYSETPOS=${rule.bySetPos.join(",")}`);
  if (rule.wkst !== 1) parts.push(`WKST=${weekdayCode(rule.wkst)}`);
  return parts.join(";");
}

// ---------------------------------------------------------------------------------------------------------
// Floating-calendar iteration (day numbers = whole days since 1970-01-01, no timezone)
// ---------------------------------------------------------------------------------------------------------

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

function dayNumber(year: number, month: number, day: number): number {
  return Math.round(calendarToUtcMs(year, month, day) / MS_PER_DAY);
}

function calendarOf(dayNum: number): { year: number; month: number; day: number } {
  const d = new Date(dayNum * MS_PER_DAY);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 1970-01-01 (day 0) was a Thursday (ISO 4). */
function isoWeekdayOf(dayNum: number): IsoWeekday {
  return ((((dayNum + 3) % 7) + 7) % 7 + 1) as IsoWeekday;
}

/** Rule with RFC 5545 defaults derived from the anchor date filled in. */
function withAnchorDefaults(rule: ParsedRecurrenceRule, anchorDay: number): ParsedRecurrenceRule {
  switch (rule.freq) {
    case "DAILY":
      return rule;
    case "WEEKLY":
      return rule.byDay.length > 0 ? rule : { ...rule, byDay: [{ weekday: isoWeekdayOf(anchorDay) }] };
    case "MONTHLY":
      return rule.byDay.length > 0 || rule.byMonthDay.length > 0
        ? rule
        : { ...rule, byMonthDay: [calendarOf(anchorDay).day] };
    default: {
      const exhaustive: never = rule.freq;
      throw new TypeError(`Unknown recurrence frequency ${String(exhaustive)}`);
    }
  }
}

function dayMatches(dayNum: number, rule: ParsedRecurrenceRule): boolean {
  const { year, month, day } = calendarOf(dayNum);
  if (rule.byMonth.length > 0 && !rule.byMonth.includes(month)) return false;
  const monthLength = daysInMonth(year, month);
  if (rule.byMonthDay.length > 0 && !rule.byMonthDay.some((md) => (md > 0 ? md : monthLength + md + 1) === day)) {
    return false;
  }
  if (rule.byDay.length > 0) {
    const weekday = isoWeekdayOf(dayNum);
    const nthFromStart = Math.floor((day - 1) / 7) + 1;
    const nthFromEnd = -(Math.floor((monthLength - day) / 7) + 1);
    const hit = rule.byDay.some(
      (d) =>
        d.weekday === weekday && (d.ordinal === undefined || d.ordinal === nthFromStart || d.ordinal === nthFromEnd),
    );
    if (!hit) return false;
  }
  return true;
}

/** First day number and length of the `index`-th period (0 = the anchor's period). */
function period(rule: ParsedRecurrenceRule, anchorDay: number, index: number): { start: number; length: number } {
  switch (rule.freq) {
    case "DAILY":
      return { start: anchorDay + index * rule.interval, length: 1 };
    case "WEEKLY": {
      const weekStartDay = anchorDay - ((isoWeekdayOf(anchorDay) - rule.wkst + 7) % 7);
      return { start: weekStartDay + index * rule.interval * 7, length: 7 };
    }
    case "MONTHLY": {
      const anchor = calendarOf(anchorDay);
      const monthIndex = anchor.year * 12 + (anchor.month - 1) + index * rule.interval;
      const year = Math.floor(monthIndex / 12);
      const month = (monthIndex % 12) + 1;
      return { start: dayNumber(year, month, 1), length: daysInMonth(year, month) };
    }
    default: {
      const exhaustive: never = rule.freq;
      throw new TypeError(`Unknown recurrence frequency ${String(exhaustive)}`);
    }
  }
}

function applySetPos(candidates: number[], bySetPos: readonly number[]): number[] {
  if (bySetPos.length === 0) return candidates;
  const picked = new Set<number>();
  for (const pos of bySetPos) {
    const idx = pos > 0 ? pos - 1 : candidates.length + pos;
    const day = candidates[idx];
    if (day !== undefined) picked.add(day);
  }
  return [...picked].sort((a, b) => a - b);
}

/**
 * Day numbers strictly after `anchorDay` and no later than `lastDay` on which the rule fires, ascending.
 * Work is bounded by `(lastDay - anchorDay) / period length`, whatever the rule.
 */
function* ruleDaysAfterAnchor(rule: ParsedRecurrenceRule, anchorDay: number, lastDay: number): Generator<number> {
  for (let index = 0; ; index += 1) {
    const p = period(rule, anchorDay, index);
    if (p.start > lastDay) return;
    const candidates: number[] = [];
    for (let d = p.start; d < p.start + p.length; d += 1) {
      if (dayMatches(d, rule)) candidates.push(d);
    }
    for (const day of applySetPos(candidates, rule.bySetPos)) {
      if (day <= anchorDay) continue;
      if (day > lastDay) return;
      yield day;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Public expansion API
// ---------------------------------------------------------------------------------------------------------

/** Input of `expandRecurrence`: a series described by its first shift's start instant. */
export interface ExpandRecurrenceInput {
  /** RFC 5545 RRULE body, e.g. `FREQ=WEEKLY;BYDAY=MO,WE,FR`. No DTSTART/UNTIL inside. */
  rule: string;
  /**
   * Start instant of the anchor (first) shift of the series. Its local wall-clock in `timezone` seeds the
   * rule (time of day, default weekday / day of month) and it is always the first occurrence returned.
   * If the typed start time fell in a DST gap (so this instant is an hour later than typed), use
   * `expandShiftSeries` instead, or every later occurrence inherits the shifted time.
   */
  firstStartsAt: Date;
  /**
   * Nominal (wall-clock) length of each shift in minutes, e.g. 480 for 22:00–06:00. Compute it with
   * `wallClockMinutesBetween`, not `minutesBetween`, if the anchor shift spans a DST change.
   */
  durationMinutes: number;
  /** IANA zone the series is defined in. */
  timezone: string;
  /**
   * EXCLUSIVE upper bound: only occurrences with `startsAt < until` are returned. For an inclusive local
   * "last date" use `recurrenceUntilFromLocalDate(date, timezone)`. At most RECURRENCE_MAX_SPAN_DAYS after
   * `firstStartsAt`.
   */
  until: Date;
  /** Maximum number of occurrences (default 400, hard ceiling 5000). Pass `limit + 1` to detect truncation. */
  max?: number;
}

/** Input of `expandShiftSeries`: a series described the way a manager types it. */
export interface ExpandShiftSeriesInput {
  /** Local date of the first shift, `YYYY-MM-DD`. */
  date: LocalDateString;
  /** `HH:mm` local start time of every occurrence. */
  startTime: LocalTimeString;
  /** `HH:mm` local end time; `endTime <= startTime` means each shift ends the next local day. */
  endTime: LocalTimeString;
  /** IANA zone the times are typed in. */
  timezone: string;
  /** RFC 5545 RRULE body, e.g. `FREQ=WEEKLY;BYDAY=MO,WE,FR`. */
  rule: string;
  /** Last local date (INCLUSIVE) on which an occurrence may start — the validation package's `until`. */
  untilDate: LocalDateString;
  /** Maximum number of occurrences (default 400, hard ceiling 5000). Pass `limit + 1` to detect truncation. */
  max?: number;
}

/** One materialised shift of a series. */
export interface RecurrenceOccurrence {
  /** UTC instant the occurrence starts (inclusive). */
  startsAt: Date;
  /** UTC instant the occurrence ends (exclusive). Always after `startsAt`. */
  endsAt: Date;
  /** Local date (`YYYY-MM-DD` in the series timezone) the occurrence starts on. */
  localDate: LocalDateString;
  /** True only for the first element: the anchor shift. */
  isAnchor: boolean;
  /** DST adjustments applied to this occurrence (usually empty). */
  warnings: ShiftTimeWarning[];
}

/**
 * The exclusive `until` instant for a series whose last occurrence may start on local date `untilDate`
 * (inclusive) — i.e. the start of the following local day in `timezone`.
 */
export function recurrenceUntilFromLocalDate(untilDate: LocalDateString, timezone: string): Date {
  return localDateRange(untilDate, untilDate, timezone)[1];
}

function resolveEnd(
  startFloatingMs: number,
  startsAt: Date,
  durationMs: number,
  timezone: string,
): { endsAt: Date; warning?: ShiftTimeWarning } {
  const end = resolveWallClock(floatingMsToWallClock(startFloatingMs + durationMs), timezone);
  if (end.instant.getTime() <= startsAt.getTime()) {
    // Only possible for a shift shorter than a DST gap whose end falls in the gap: keep the absolute length.
    return { endsAt: new Date(startsAt.getTime() + durationMs) };
  }
  return end.warning ? { endsAt: end.instant, warning: `END_${end.warning}` } : { endsAt: end.instant };
}

/** Validated rule and occurrence limit shared by both entry points. Throws INVALID_RECURRENCE / VALIDATION_ERROR. */
function parseSeriesOptions(rule: string, max: number | undefined): { parsed: ParsedRecurrenceRule; limit: number } {
  const validation = validateRecurrenceRule(rule);
  if (!validation.ok) {
    throw new AppError("INVALID_RECURRENCE", validation.error, { details: { rule } });
  }
  const maxValue = max ?? DEFAULT_RECURRENCE_MAX;
  if (!Number.isInteger(maxValue) || maxValue < 1 || maxValue > RECURRENCE_HARD_MAX) {
    throw new AppError("VALIDATION_ERROR", `max must be an integer 1..${RECURRENCE_HARD_MAX}`, {
      details: { field: "max", value: max },
    });
  }
  return { parsed: validation.parsed, limit: Math.min(maxValue, validation.parsed.count ?? Number.POSITIVE_INFINITY) };
}

function assertSpan(anchorMs: number, untilMs: number, field: string): void {
  if (untilMs - anchorMs > RECURRENCE_MAX_SPAN_DAYS * MS_PER_DAY) {
    throw new AppError("VALIDATION_ERROR", `The series must end within ${RECURRENCE_MAX_SPAN_DAYS} days of its first shift`, {
      details: { field, maxSpanDays: RECURRENCE_MAX_SPAN_DAYS },
    });
  }
}

/** A series reduced to floating-calendar terms, with its anchor occurrence already built. */
interface SeriesPlan {
  rule: ParsedRecurrenceRule;
  timezone: string;
  anchor: RecurrenceOccurrence;
  /** Floating day number of the series' first local date. */
  anchorDay: number;
  /** Wall-clock time of day (ms after local midnight) every occurrence starts at. */
  timeOfDayMs: number;
  /** Nominal wall-clock length of each occurrence. */
  durationMs: number;
  /** Exclusive bound on `startsAt`. */
  untilMs: number;
  /** min(max, COUNT); the anchor counts. */
  limit: number;
}

function expandPlan(plan: SeriesPlan): RecurrenceOccurrence[] {
  const { timezone: tz, untilMs } = plan;
  const out: RecurrenceOccurrence[] = [plan.anchor];
  if (out.length >= plan.limit) return out;

  // Local date of `until`, plus one day of slack; the exact cut-off is applied to resolved instants below.
  const lastDay = Math.floor(wallClockToFloatingMs(instantToWallClock(new Date(untilMs), tz)) / MS_PER_DAY) + 1;
  const rule = withAnchorDefaults(plan.rule, plan.anchorDay);
  let previousStartMs = plan.anchor.startsAt.getTime();
  for (const day of ruleDaysAfterAnchor(rule, plan.anchorDay, lastDay)) {
    const floating = day * MS_PER_DAY + plan.timeOfDayMs;
    const start = resolveWallClock(floatingMsToWallClock(floating), tz);
    const startMs = start.instant.getTime();
    if (startMs >= untilMs) break;
    // A skipped calendar day (e.g. Pacific/Apia 2011-12-30) resolves onto the next day; never emit twice.
    if (startMs <= previousStartMs) continue;
    previousStartMs = startMs;

    const warnings: ShiftTimeWarning[] = [];
    if (start.warning) warnings.push(`START_${start.warning}`);
    const end = resolveEnd(floating, start.instant, plan.durationMs, tz);
    if (end.warning) warnings.push(end.warning);

    out.push({
      startsAt: start.instant,
      endsAt: end.endsAt,
      localDate: formatLocalDate(start.wallClock.year, start.wallClock.month, start.wallClock.day),
      isAnchor: false,
      warnings,
    });
    if (out.length >= plan.limit) break;
  }
  return out;
}

/**
 * Materialises a recurring series into concrete half-open `[startsAt, endsAt)` instants in local wall-clock
 * terms (see the file header), starting from the first shift's start INSTANT.
 *
 * - Element 0 is always the anchor (`isAnchor: true`, `startsAt` exactly `firstStartsAt`), even when the
 *   anchor date does not itself match the rule — RFC 5545: DTSTART is always the first instance and counts
 *   toward COUNT. Later elements are the rule's matches on later local dates, ascending. Do not create the
 *   anchor shift separately as well.
 * - Each occurrence starts at the anchor's local time of day. A start inside a spring-forward gap moves
 *   forward (`START_NONEXISTENT_LOCAL_TIME_SHIFTED`); an ambiguous one takes the first occurrence
 *   (`START_AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE`); likewise `END_*` for the end.
 * - Defaults follow RFC 5545: WEEKLY without BYDAY uses the anchor's weekday; MONTHLY without BYDAY or
 *   BYMONTHDAY uses the anchor's day of month (months without that day are skipped, e.g. the 31st).
 * - Returns `[]` when `until <= firstStartsAt`.
 *
 * Prefer `expandShiftSeries` when the typed date and times are available.
 *
 * Throws `AppError("INVALID_RECURRENCE")` for a rule `validateRecurrenceRule` rejects,
 * `AppError("INVALID_TIMEZONE")` for unknown zones and `AppError("VALIDATION_ERROR")` for invalid
 * dates/numbers or a window longer than RECURRENCE_MAX_SPAN_DAYS.
 */
export function expandRecurrence(input: ExpandRecurrenceInput): RecurrenceOccurrence[] {
  const { parsed, limit } = parseSeriesOptions(input.rule, input.max);
  assertTimeZone(input.timezone);
  if (!(input.firstStartsAt instanceof Date) || Number.isNaN(input.firstStartsAt.getTime())) {
    throw new AppError("VALIDATION_ERROR", "firstStartsAt must be a valid Date", {
      details: { field: "firstStartsAt" },
    });
  }
  if (!(input.until instanceof Date) || Number.isNaN(input.until.getTime())) {
    throw new AppError("VALIDATION_ERROR", "until must be a valid Date", { details: { field: "until" } });
  }
  if (!Number.isFinite(input.durationMinutes) || input.durationMinutes <= 0) {
    throw new AppError("VALIDATION_ERROR", "durationMinutes must be a positive number", {
      details: { field: "durationMinutes", value: input.durationMinutes },
    });
  }

  const untilMs = input.until.getTime();
  const anchorMs = input.firstStartsAt.getTime();
  if (untilMs <= anchorMs) return [];
  assertSpan(anchorMs, untilMs, "until");

  const tz = input.timezone;
  const durationMs = input.durationMinutes * MS_PER_MINUTE;
  const anchorWc = instantToWallClock(input.firstStartsAt, tz);
  const anchorFloating = wallClockToFloatingMs(anchorWc);
  const anchorDay = Math.floor(anchorFloating / MS_PER_DAY);
  const anchorEnd = resolveEnd(anchorFloating, input.firstStartsAt, durationMs, tz);

  return expandPlan({
    rule: parsed,
    timezone: tz,
    anchor: {
      startsAt: new Date(anchorMs),
      endsAt: anchorEnd.endsAt,
      localDate: formatLocalDate(anchorWc.year, anchorWc.month, anchorWc.day),
      isAnchor: true,
      warnings: anchorEnd.warning ? [anchorEnd.warning] : [],
    },
    anchorDay,
    timeOfDayMs: anchorFloating - anchorDay * MS_PER_DAY,
    durationMs,
    untilMs,
    limit,
  });
}

/**
 * Materialises a series from what the manager typed — the usual API path for "create shift + recurrence".
 *
 * - Element 0 is the first shift, identical to `buildShiftInstants({ date, startTime, endTime, timezone })`
 *   (same instants and warnings) with `isAnchor: true`; it counts toward COUNT and is returned even when
 *   `date` does not match the rule (RFC 5545 DTSTART). Do not create it separately as well.
 * - Every occurrence starts at the typed `startTime` and lasts the typed wall-clock length (22:00–06:00 is
 *   always 22:00 → 06:00 local: 7h or 9h on DST nights, like `buildShiftInstants`). Unlike passing the first
 *   shift's instant to `expandRecurrence`, this stays correct when the first shift's start fell in a DST gap
 *   (London `2026-03-29 01:30` is created at 02:30 BST, but later days still start at 01:30).
 * - `untilDate` is inclusive; returns `[]` when it is before the first shift's local start date.
 *
 * Throws `AppError("INVALID_RECURRENCE")` for a rejected rule, `AppError("INVALID_TIMEZONE")`, and
 * `AppError("VALIDATION_ERROR")` with `details.field` (`date` | `startTime` | `endTime` | `untilDate` |
 * `max`) or `details.reason = "SHIFT_END_NOT_AFTER_START"` (see `buildShiftInstants`).
 */
export function expandShiftSeries(input: ExpandShiftSeriesInput): RecurrenceOccurrence[] {
  const { parsed, limit } = parseSeriesOptions(input.rule, input.max);
  const first = buildShiftInstants({
    date: input.date,
    startTime: input.startTime,
    endTime: input.endTime,
    timezone: input.timezone,
  });
  if (!isValidLocalDate(input.untilDate)) {
    throw new AppError("VALIDATION_ERROR", "untilDate must be a valid YYYY-MM-DD value", {
      details: { field: "untilDate", value: input.untilDate },
    });
  }
  const untilMs = recurrenceUntilFromLocalDate(input.untilDate, input.timezone).getTime();
  const anchorMs = first.startsAt.getTime();
  if (untilMs <= anchorMs) return [];
  assertSpan(anchorMs, untilMs, "untilDate");

  const { year, month, day } = splitLocalDate(input.date);
  const start = splitLocalTime(input.startTime);
  const end = splitLocalTime(input.endTime);
  const startMinutes = start.hour * 60 + start.minute;
  const endMinutes = end.hour * 60 + end.minute;
  const durationMinutes = first.isOvernight ? endMinutes + 1440 - startMinutes : endMinutes - startMinutes;
  const startWc = instantToWallClock(first.startsAt, input.timezone);

  return expandPlan({
    rule: parsed,
    timezone: input.timezone,
    anchor: {
      startsAt: first.startsAt,
      endsAt: first.endsAt,
      localDate: formatLocalDate(startWc.year, startWc.month, startWc.day),
      isAnchor: true,
      warnings: [...first.warnings],
    },
    anchorDay: dayNumber(year, month, day),
    timeOfDayMs: startMinutes * MS_PER_MINUTE,
    durationMs: durationMinutes * MS_PER_MINUTE,
    untilMs,
    limit,
  });
}
