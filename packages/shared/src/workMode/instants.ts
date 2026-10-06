import type { InstantInput } from "./types";

/**
 * Internal instant helpers for the Work Mode machine. Deliberately not re-exported from the barrel: general
 * time utilities live in `../time/time.ts`.
 */

export const MINUTE_MS = 60_000;

/** ISO-8601 strings must carry an explicit offset; naive wall-clock strings would be parsed in the host zone. */
const OFFSET_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/i;

export function toDate(value: InstantInput, field: string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError(`workMode: ${field} is an invalid Date`);
    return new Date(value.getTime());
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`workMode: ${field} must be a Date or an ISO-8601 string`);
  }
  if (!OFFSET_SUFFIX.test(value)) {
    throw new TypeError(`workMode: ${field} must include a timezone offset (got "${value}")`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new TypeError(`workMode: ${field} is not a valid ISO-8601 instant (got "${value}")`);
  return new Date(ms);
}

export function toOptionalDate(value: InstantInput | null | undefined, field: string): Date | null {
  return value === null || value === undefined ? null : toDate(value, field);
}

export function minutesToMs(minutes: number): number {
  return minutes * MINUTE_MS;
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutesToMs(minutes));
}

export function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

/** Sorted, de-duplicated copy of `dates`, keeping only instants strictly after `after`. */
export function futureInstants(dates: readonly Date[], after: Date): Date[] {
  const seen = new Set<number>();
  const out: Date[] = [];
  for (const d of dates) {
    const ms = d.getTime();
    if (ms <= after.getTime() || seen.has(ms)) continue;
    seen.add(ms);
    out.push(new Date(ms));
  }
  return out.sort((x, y) => x.getTime() - y.getTime());
}

export function assertNever(value: never, what: string): never {
  throw new TypeError(`workMode: unexpected ${what}: ${String(value)}`);
}
