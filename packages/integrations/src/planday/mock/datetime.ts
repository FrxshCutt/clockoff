/**
 * Date-time helpers of Mock Planday. Shift and punch times are stored the way Planday takes them on create
 * (notes §10.3): wall-clock time in a named zone (`2026-10-21T09:00:00` + `Europe/London`). How the API encodes
 * them on a read is undocumented (notes §12 Q27), so the mock serves the encoding chosen with
 * `setDateTimeFormat` (plan §12.4): wall-clock (default), UTC with `Z`, UTC without `Z` (the wrong encoding the
 * client's `date` cross-check must catch, plan §4.8) or wall-clock with an offset.
 */
import { isValidLocalDate } from "@clockoff/shared/time/parse";
import {
  instantToWallClock,
  isValidTimeZone,
  resolveWallClock,
  type WallClock,
} from "@clockoff/shared/time/zone";

export const MOCK_DATE_TIME_FORMATS = ["local", "utc", "utc-without-z", "offset"] as const;
/** How shift and punch clock date-times are encoded on a read (plan §12.4 `setDateTimeFormat`). */
export type MockDateTimeFormat = (typeof MOCK_DATE_TIME_FORMATS)[number];

const LOCAL_DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/;
const WITH_OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** True when `value` carries `Z` or a `±hh:mm` offset, i.e. names an instant on its own. */
export function hasZoneDesignator(value: string): boolean {
  return WITH_OFFSET_RE.test(value);
}

/** Wall-clock components of `YYYY-MM-DDTHH:mm(:ss(.fff)?)?`, or null. */
export function parseLocalDateTime(value: string): WallClock | null {
  const m = LOCAL_DATE_TIME_RE.exec(value);
  if (!m) return null;
  const wc: WallClock = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: m[6] === undefined ? 0 : Number(m[6]),
  };
  return isValidLocalDate(value.slice(0, 10)) && wc.hour < 24 && wc.minute < 60 && wc.second < 60
    ? wc
    : null;
}

/** `YYYY-MM-DDTHH:mm:ss` (or without seconds). */
export function formatWallClock(wc: WallClock, seconds = true): string {
  const date = `${String(wc.year).padStart(4, "0")}-${pad2(wc.month)}-${pad2(wc.day)}`;
  const time = `${pad2(wc.hour)}:${pad2(wc.minute)}`;
  return seconds ? `${date}T${time}:${pad2(wc.second)}` : `${date}T${time}`;
}

/** The zone to compute in: `zone` when it is a valid IANA id, else `fallback` (the portal's). */
export function usableZone(zone: string, fallback: string): string {
  return isValidTimeZone(zone) ? zone : fallback;
}

/** Instant (epoch ms) of a stored wall-clock time; DST rules of `resolveWallClock` (gap forward, overlap first). */
export function localToMs(local: string, zone: string): number {
  const wc = parseLocalDateTime(local);
  if (!wc) throw new Error(`Mock Planday: invalid local date-time ${JSON.stringify(local)}`);
  return resolveWallClock(wc, zone).instant.getTime();
}

/** Wall-clock `YYYY-MM-DDTHH:mm:ss` of an instant in `zone`. */
export function msToLocal(ms: number, zone: string): string {
  return formatWallClock(instantToWallClock(new Date(ms), zone));
}

/** `YYYY-MM-DDTHH:mm:ssZ` (no milliseconds), the shape of the HR examples (notes §10.3). */
export function isoZ(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Local `YYYY-MM-DD` of an instant in `zone`. */
export function localDateOfMs(ms: number, zone: string): string {
  return msToLocal(ms, zone).slice(0, 10);
}

/**
 * A date-time a test or the dev control route passes: a `Date`, an instant string (`Z` / offset), or a
 * wall-clock string in `zone`. Returns the stored wall-clock form in `zone`.
 */
export function toStoredLocal(value: string | Date, zone: string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error("Mock Planday: invalid Date");
    return msToLocal(value.getTime(), zone);
  }
  if (hasZoneDesignator(value)) {
    const ms = Date.parse(value);
    if (Number.isNaN(ms))
      throw new Error(`Mock Planday: invalid date-time ${JSON.stringify(value)}`);
    return msToLocal(ms, zone);
  }
  const wc = parseLocalDateTime(value);
  if (!wc) throw new Error(`Mock Planday: invalid date-time ${JSON.stringify(value)}`);
  return formatWallClock(wc);
}

/**
 * Parses a query date-time the way the mock reads `deletedFrom`, `modifiedFrom`, the Punch Clock `from` / `to`
 * and the like: with `Z` or an offset it is an instant, otherwise wall-clock in `zone` (notes §10.3, the Punch
 * Clock example `2025-01-01T00:00` has neither). Returns null when unparseable.
 */
export function parseQueryDateTime(value: string, zone: string): number | null {
  if (hasZoneDesignator(value)) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  const wc = parseLocalDateTime(value);
  return wc ? resolveWallClock(wc, zone).instant.getTime() : null;
}

function offsetString(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/**
 * Encodes a stored wall-clock time for a read. `zone` is the record's zone; when it is not a valid IANA id (a
 * test serving a Windows zone name), the instant is computed in `fallbackZone` and the wall-clock form is
 * served unchanged.
 */
export function encodeDateTime(
  local: string,
  zone: string,
  fallbackZone: string,
  format: MockDateTimeFormat,
  options: { seconds?: boolean } = {},
): string {
  const seconds = options.seconds ?? true;
  const wc = parseLocalDateTime(local);
  if (!wc) throw new Error(`Mock Planday: invalid stored date-time ${JSON.stringify(local)}`);
  if (format === "local") return formatWallClock(wc, seconds);
  const resolved = resolveWallClock(wc, usableZone(zone, fallbackZone));
  const ms = resolved.instant.getTime();
  switch (format) {
    case "utc":
      return isoZ(ms);
    case "utc-without-z":
      return isoZ(ms).slice(0, -1);
    case "offset":
      return `${formatWallClock(resolved.wallClock)}${offsetString(resolved.offsetMinutes)}`;
  }
}
