import type { DateFormat } from "@workmode/shared/enums";

/**
 * Display formatting. Every function takes UTC instants (ISO strings, epoch ms or Dates) and converts to a
 * time zone only for display — the organisation's zone when given, otherwise the viewer's.
 */

export type DateInput = string | number | Date;

const LOCALE = "en-GB";

export function toDate(value: DateInput | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface DateDisplayOptions {
  /** IANA zone; defaults to the viewer's zone. */
  timeZone?: string;
  /** Organisation preference. Defaults to DMY. */
  dateFormat?: DateFormat;
  /** 12-hour clock. Defaults to 24-hour. */
  hour12?: boolean;
}

export const DATE_FORMAT_LABELS: Record<DateFormat, { label: string; example: string }> = {
  DMY: { label: "Day / month / year", example: "31/12/2026" },
  MDY: { label: "Month / day / year", example: "12/31/2026" },
  YMD: { label: "Year-month-day", example: "2026-12-31" },
};

function dateParts(date: Date, timeZone: string | undefined): { year: string; month: string; day: string } {
  const parts = new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** Numeric date in the organisation's preferred order, e.g. `06/10/2026`, `10/06/2026` or `2026-10-06`. */
export function formatDate(value: DateInput | null | undefined, options: DateDisplayOptions = {}): string {
  const date = toDate(value);
  if (!date) return "—";
  const { year, month, day } = dateParts(date, options.timeZone);
  const format: DateFormat = options.dateFormat ?? "DMY";
  switch (format) {
    case "DMY":
      return `${day}/${month}/${year}`;
    case "MDY":
      return `${month}/${day}/${year}`;
    case "YMD":
      return `${year}-${month}-${day}`;
  }
}

/** Time of day, e.g. `14:05` or `2:05 pm`. */
export function formatTime(value: DateInput | null | undefined, options: DateDisplayOptions = {}): string {
  const date = toDate(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: options.timeZone,
    hour: options.hour12 ? "numeric" : "2-digit",
    minute: "2-digit",
    hour12: options.hour12 ?? false,
  }).format(date);
}

/** `06/10/2026, 14:05` (date order and clock per options). */
export function formatDateTime(value: DateInput | null | undefined, options: DateDisplayOptions = {}): string {
  const date = toDate(value);
  if (!date) return "—";
  return `${formatDate(date, options)}, ${formatTime(date, options)}`;
}

/** Long, unambiguous form for tooltips: `Tuesday 6 October 2026, 14:05:09 BST`. */
export function formatDateTimeLong(value: DateInput | null | undefined, options: { timeZone?: string } = {}): string {
  const date = toDate(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: options.timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(date);
}

const RELATIVE_UNITS: ReadonlyArray<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
  { unit: "year", ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: "month", ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: "week", ms: 7 * 24 * 60 * 60 * 1000 },
  { unit: "day", ms: 24 * 60 * 60 * 1000 },
  { unit: "hour", ms: 60 * 60 * 1000 },
  { unit: "minute", ms: 60 * 1000 },
];

/**
 * `just now`, `5 minutes ago`, `in 2 hours`, `yesterday`, `3 weeks ago`… Differences under 45 seconds in
 * either direction read as "just now".
 */
export function formatRelativeTime(value: DateInput | null | undefined, now: DateInput = Date.now()): string {
  const date = toDate(value);
  const reference = toDate(now);
  if (!date || !reference) return "—";
  const diff = date.getTime() - reference.getTime();
  const abs = Math.abs(diff);
  if (abs < 45_000) return "just now";
  const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });
  for (const { unit, ms } of RELATIVE_UNITS) {
    if (abs >= ms) return rtf.format(Math.trunc(diff / ms), unit);
  }
  return rtf.format(Math.trunc(diff / 60_000) || Math.sign(diff), "minute");
}

/** `90` → `1 h 30 min`; `45` → `45 min`; `120` → `2 h`. */
export function formatDurationMinutes(totalMinutes: number): string {
  if (!Number.isFinite(totalMinutes) || totalMinutes < 0) return "—";
  const minutes = Math.round(totalMinutes);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat(LOCALE).format(value);
}

/** `formatCount(1, "employee")` → `1 employee`; `formatCount(3, "employee")` → `3 employees`. */
export function formatCount(count: number, singular: string, plural: string = `${singular}s`): string {
  return `${formatNumber(count)} ${count === 1 ? singular : plural}`;
}

/** `SETUP_INCOMPLETE` → `Setup incomplete`. Fallback copy for enum values without explicit labels. */
export function humanizeEnum(value: string): string {
  const words = value.replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

/** Up to two initials for avatars: `Ada Lovelace` → `AL`, `cher` → `C`. */
export function getInitials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.charAt(0) ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

/** `GMT+1`, `GMT-5`, `GMT` for the zone at the given instant (DST aware). Falls back to "" for bad zones. */
export function formatTimeZoneOffset(timeZone: string, at: DateInput = Date.now()): string {
  const date = toDate(at) ?? new Date();
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" }).formatToParts(date);
    const value = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    // ICU versions differ on a zero offset ("GMT" vs "GMT+0"); normalise so labels are stable everywhere.
    return /^(GMT|UTC)([+-]0{1,2}(:00)?)?$/.test(value) ? "GMT" : value;
  } catch {
    return "";
  }
}

/** `Europe/London` → `Europe / London (GMT+1)`; `America/New_York` → `America / New York (GMT-4)`. */
export function formatTimeZoneLabel(timeZone: string, at: DateInput = Date.now()): string {
  const name = timeZone.replace(/_/g, " ").split("/").join(" / ");
  const offset = formatTimeZoneOffset(timeZone, at);
  return offset ? `${name} (${offset})` : name;
}
