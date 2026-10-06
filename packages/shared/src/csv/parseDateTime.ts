/**
 * Lenient-but-explicit date/time parsing for CSV cells. Dates are parsed with plain regular expressions and
 * an English month table (never the runtime's locale data, whose abbreviations differ between ICU versions:
 * en-GB spells September "Sept" in some releases and "Sep" in others). Luxon is used only for timezone
 * offsets. The shared time module is being written concurrently and will be reconciled later.
 *
 * Rules: a 4-digit-first date (2026-03-05) is always year-first; a 4-digit-last date (05/03/2026) is read
 * according to the organisation's DateFormat; under YMD such a value is rejected rather than guessed.
 * A month written as a word ("5 Mar 2026") is unambiguous under every format.
 */
import { IANAZone } from "luxon";
import type { DateFormat } from "../enums";

export type DateParseResult = { ok: true; isoDate: string } | { ok: false; message: string };

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Lower-case English month names and abbreviations → month number (both "sep" and "sept"). */
const MONTHS: ReadonlyMap<string, number> = new Map([
  ...MONTH_NAMES.map((name, i) => [name.toLowerCase(), i + 1] as const),
  ...MONTH_NAMES.map((name, i) => [name.slice(0, 3).toLowerCase(), i + 1] as const),
  ["sept", 9],
]);

/** A leading word followed by optional "." / "," and whitespace: "Thu 05/03/2026", "Thursday, 5 March 2026". */
const LEADING_WORD = /^([a-z]+)\.?,?\s+/i;
/** Weekday spellings → ISO weekday (Monday = 1). */
const WEEKDAYS: ReadonlyMap<string, number> = new Map([
  ["mon", 1],
  ["monday", 1],
  ["tue", 2],
  ["tues", 2],
  ["tuesday", 2],
  ["wed", 3],
  ["weds", 3],
  ["wednesday", 3],
  ["thu", 4],
  ["thur", 4],
  ["thurs", 4],
  ["thursday", 4],
  ["fri", 5],
  ["friday", 5],
  ["sat", 6],
  ["saturday", 6],
  ["sun", 7],
  ["sunday", 7],
]);
const WEEKDAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

/** 2026-03-05, 2026/3/5, 2026.03.05 — one separator used throughout, 1–2 digit month and day. */
const YEAR_FIRST_DATE = /^(\d{4})([/.-])(\d{1,2})\2(\d{1,2})$/;
/** 05/03/2026, 5-3-26, 05.03.2026 — one separator used throughout; the year has 4 or 2 digits. */
const DAY_MONTH_DATE = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})$/;
/** 5 Mar 2026, 05-Mar-26, 5th March 2026, 05/Mar/2026, 5 Sept. 2026, 5 March, 2026. */
const DAY_MONTHNAME_YEAR = /^(\d{1,2})(?:st|nd|rd|th)?[\s/.-]+([a-z]+)\.?,?[\s/.-]+(\d{4}|\d{2})$/;
/** March 5, 2026, Mar 05 2026, Sep-5-26, March 5th 2026. */
const MONTHNAME_DAY_YEAR = /^([a-z]+)\.?[\s/.-]+(\d{1,2})(?:st|nd|rd|th)?,?[\s/.-]+(\d{4}|\d{2})$/;
/** 2026-Mar-05, 2026 March 5. */
const YEAR_MONTHNAME_DAY = /^(\d{4})[\s/.-]+([a-z]+)\.?[\s/.-]+(\d{1,2})$/;
/**
 * Spreadsheet exports often append a midnight time to date cells ("05/03/2026 00:00", "2026-03-05T00:00:00Z").
 * Only an all-zero time is stripped; any other time in a date column is ambiguous and rejected.
 */
const MIDNIGHT_SUFFIX =
  /(?:(?:\s+|T)0?0:00(?::00(?:\.0+)?)?(?:Z|[+-]00:?00)?|\s+12:00(?::00)?\s*am)$/i;

/** Shifts are imported for the near past/future; anything outside this window is a typo, not a shift. */
export const IMPORT_MIN_YEAR = 2000;
export const IMPORT_MAX_YEAR = 2099;

function describeFormat(format: DateFormat): string {
  switch (format) {
    case "DMY":
      return "DD/MM/YYYY";
    case "MDY":
      return "MM/DD/YYYY";
    case "YMD":
      return "YYYY-MM-DD";
  }
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** A 2-digit year always means 20xx (never 19xx): rota imports are about the present. */
function fullYear(digits: string): number {
  return digits.length === 2 ? 2000 + Number(digits) : Number(digits);
}

function checkCalendarDate(
  year: number,
  month: number,
  day: number,
  format: DateFormat,
): DateParseResult {
  if (year < IMPORT_MIN_YEAR || year > IMPORT_MAX_YEAR) {
    return {
      ok: false,
      message: `Year ${year} is out of range (${IMPORT_MIN_YEAR}–${IMPORT_MAX_YEAR}).`,
    };
  }
  if (month < 1 || month > 12) {
    const alt = format === "DMY" ? "MM/DD/YYYY" : format === "MDY" ? "DD/MM/YYYY" : null;
    return {
      ok: false,
      message:
        `Month ${month} is out of range` +
        (alt
          ? `; the organisation reads dates as ${describeFormat(format)} — is this file ${alt}?`
          : "."),
    };
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (day < 1 || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return { ok: false, message: `${day} ${MONTH_NAMES[month - 1]} ${year} is not a real date.` };
  }
  return { ok: true, isoDate: `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` };
}

function unrecognised(value: string, format: DateFormat): DateParseResult {
  return {
    ok: false,
    message: `"${value}" is not a recognised date; use YYYY-MM-DD or ${describeFormat(format)}.`,
  };
}

/**
 * Parses a date cell to an ISO calendar date (YYYY-MM-DD). Accepts year-first ISO (any one separator),
 * numeric day/month/year or month/day/year per `format` (2- or 4-digit year; 2-digit means 20xx),
 * English month names or abbreviations ("5 Mar 2026", "Sept 5, 2026", "05-Mar-26"), an optional leading
 * weekday that must agree with the date ("Mon 02/03/2026") and a trailing midnight time
 * ("05/03/2026 00:00"). Never guesses between DMY and MDY: the organisation's `format` decides.
 */
export function parseImportDate(value: string, format: DateFormat): DateParseResult {
  let v = value.trim();
  if (v === "") return { ok: false, message: "Date is empty." };
  let weekday: number | undefined;
  const lead = LEADING_WORD.exec(v);
  const leadWeekday = lead ? WEEKDAYS.get(lead[1]!.toLowerCase()) : undefined;
  if (lead && leadWeekday !== undefined) {
    weekday = leadWeekday;
    v = v.slice(lead[0].length);
  }
  v = v.replace(MIDNIGHT_SUFFIX, "").trim();
  if (v === "") return unrecognised(value, format);

  const result = parseDatePart(value, v.toLowerCase(), format);
  if (!result.ok || weekday === undefined) return result;
  // A weekday that contradicts the date usually means the day/month order is wrong: never ignore it.
  const actual = isoWeekday(result.isoDate);
  if (actual !== weekday) {
    return {
      ok: false,
      message: `"${value}": ${formatIsoDate(result.isoDate)} is a ${WEEKDAY_NAMES[actual - 1]}, not a ${WEEKDAY_NAMES[weekday - 1]}; check the date and the organisation's date format (${describeFormat(format)}).`,
    };
  }
  return result;
}

function isoWeekday(isoDate: string): number {
  const [year, month, day] = isoDate.split("-").map(Number) as [number, number, number];
  const jsDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 = Sunday
  return jsDay === 0 ? 7 : jsDay;
}

function formatIsoDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number) as [number, number, number];
  return `${day} ${MONTH_NAMES[month - 1]} ${year}`;
}

/** `v` is trimmed and lower-cased, without weekday or midnight suffix; `value` is the original cell. */
function parseDatePart(value: string, v: string, format: DateFormat): DateParseResult {
  const ymd = YEAR_FIRST_DATE.exec(v);
  if (ymd) {
    // Year-first is unambiguous whatever the organisation's format.
    return checkCalendarDate(Number(ymd[1]), Number(ymd[3]), Number(ymd[4]), format);
  }

  const dm = DAY_MONTH_DATE.exec(v);
  if (dm) {
    const [first, second, year] = [Number(dm[1]), Number(dm[3]), fullYear(dm[4]!)];
    switch (format) {
      case "DMY":
        return checkCalendarDate(year, second, first, format);
      case "MDY":
        return checkCalendarDate(year, first, second, format);
      case "YMD":
        return {
          ok: false,
          message: `"${value}" is day/month first but the organisation reads dates as YYYY-MM-DD; change the date format option or the file.`,
        };
    }
  }

  // Month written as a word: unambiguous under every date format.
  const dmy = DAY_MONTHNAME_YEAR.exec(v);
  if (dmy) return textualDate(value, fullYear(dmy[3]!), dmy[2]!, Number(dmy[1]), format);
  const mdy = MONTHNAME_DAY_YEAR.exec(v);
  if (mdy) return textualDate(value, fullYear(mdy[3]!), mdy[1]!, Number(mdy[2]), format);
  const ymdText = YEAR_MONTHNAME_DAY.exec(v);
  if (ymdText)
    return textualDate(value, Number(ymdText[1]), ymdText[2]!, Number(ymdText[3]), format);

  return unrecognised(value, format);
}

function textualDate(
  value: string,
  year: number,
  monthWord: string,
  day: number,
  format: DateFormat,
): DateParseResult {
  const month = MONTHS.get(monthWord);
  if (month === undefined) return unrecognised(value, format);
  return checkCalendarDate(year, month, day, format);
}

export type TimeParseResult =
  { ok: true; minutes: number; hhmm: string } | { ok: false; message: string };

const CLOCK_TIME = /^(\d{1,2})(?:[:.h](\d{2}))?(?::(\d{2}))?\s*(am|pm)?$/;
const COMPACT_TIME = /^(\d{3,4})\s*(am|pm)?$/;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Parses a time cell to minutes since local midnight (0–1440; 1440 only for "24:00").
 * Accepts 09:00, 9:00, 09:00:00, 21.30, 0900, 900, 9, 9am, 9.30pm, 12am (00:00), 12pm (12:00), "17:00 hrs".
 */
export function parseImportTime(value: string): TimeParseResult {
  const v = value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/a\.m\.?/g, "am")
    .replace(/p\.m\.?/g, "pm")
    .replace(/\s*(hrs|hr|h)$/, "");
  if (v === "") return { ok: false, message: "Time is empty." };

  let hour: number;
  let minute: number;
  let meridiem: string | undefined;

  const m = CLOCK_TIME.exec(v);
  if (m) {
    hour = Number(m[1]);
    minute = m[2] === undefined ? 0 : Number(m[2]);
    meridiem = m[4];
    // Seconds are accepted only as ":00" (spreadsheet exports); anything else would be silently dropped.
    if (m[3] !== undefined && Number(m[3]) !== 0) {
      return {
        ok: false,
        message: `"${value}" has seconds; shift times must be whole minutes (e.g. 09:00).`,
      };
    }
  } else {
    const c = COMPACT_TIME.exec(v);
    if (!c) {
      return {
        ok: false,
        message: `"${value}" is not a recognised time; use HH:mm (e.g. 09:00, 17:30) or 9am / 5:30pm.`,
      };
    }
    const digits = c[1]!;
    hour = Number(digits.slice(0, digits.length - 2));
    minute = Number(digits.slice(-2));
    meridiem = c[2];
  }

  if (minute > 59) return { ok: false, message: `"${value}" has minutes out of range (00–59).` };

  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12)
      return { ok: false, message: `"${value}": hours must be 1–12 when using am/pm.` };
    if (meridiem === "am") hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  } else if (hour > 24 || (hour === 24 && minute !== 0)) {
    return {
      ok: false,
      message: `"${value}" has hours out of range (00–23, or 24:00 for midnight at the end of the day).`,
    };
  }

  const minutes = hour * 60 + minute;
  return { ok: true, minutes, hhmm: `${pad2(hour)}:${pad2(minute)}` };
}

/** Validated zones, memoised: `Intl` zone validation is expensive and runs once per CSV row otherwise. */
const zoneCache = new Map<string, IANAZone | null>();
const ZONE_CACHE_LIMIT = 1000;

function getZone(name: string): IANAZone | null {
  const cached = zoneCache.get(name);
  if (cached !== undefined) return cached;
  const zone = IANAZone.isValidZone(name) ? IANAZone.create(name) : null;
  if (zoneCache.size >= ZONE_CACHE_LIMIT) zoneCache.clear();
  zoneCache.set(name, zone);
  return zone;
}

export function isValidTimezone(zone: string): boolean {
  return getZone(zone) !== null;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

function floatingMs(isoDate: string, minutes: number): number {
  const [year, month, day] = isoDate.split("-").map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, day) + minutes * MINUTE_MS;
}

/** Calendar date + days, as YYYY-MM-DD (no timezone involved). */
export function addCalendarDays(isoDate: string, days: number): string {
  return new Date(floatingMs(isoDate, 0) + days * DAY_MS).toISOString().slice(0, 10);
}

export interface LocalInstant {
  /** UTC ISO-8601 instant with milliseconds and Z, e.g. 2026-03-05T09:00:00.000Z. */
  iso: string;
  epochMs: number;
  /** True when the requested local time did not exist (DST gap) and was moved forward. */
  adjusted: boolean;
  /** True when the requested local time occurs twice (DST fall-back); the first occurrence was used. */
  ambiguous: boolean;
}

/**
 * Combines a calendar date and minutes-since-midnight in `zone` into a UTC instant. Minutes = 1440 means
 * 00:00 on the following calendar day. Nonexistent local times (spring-forward gap) are shifted forward by
 * the gap length and flagged `adjusted`; ambiguous times (autumn fall-back) take the first (earlier)
 * occurrence and are flagged `ambiguous`, so the caller can warn instead of guessing silently.
 * Throws RangeError for an invalid zone (callers validate it first).
 */
export function toUtcInstant(isoDate: string, minutes: number, zoneName: string): LocalInstant {
  const zone = getZone(zoneName);
  if (zone === null) throw new RangeError(`Invalid IANA timezone: ${zoneName}`);
  const wall = floatingMs(isoDate, minutes);
  // Offsets either side of the wall time cover any transition that could affect it.
  const offsets = new Set([zone.offset(wall - DAY_MS), zone.offset(wall + DAY_MS)]);
  const valid: number[] = [];
  for (const offset of offsets) {
    const candidate = wall - offset * MINUTE_MS;
    if (zone.offset(candidate) === offset) valid.push(candidate);
  }
  let epochMs: number;
  let adjusted = false;
  let ambiguous = false;
  if (valid.length === 0) {
    // In the gap: apply the pre-transition offset, which lands the same distance after the transition.
    epochMs = wall - zone.offset(wall - DAY_MS) * MINUTE_MS;
    adjusted = true;
  } else {
    epochMs = Math.min(...valid);
    ambiguous = valid.length > 1;
  }
  return { iso: new Date(epochMs).toISOString(), epochMs, adjusted, ambiguous };
}
