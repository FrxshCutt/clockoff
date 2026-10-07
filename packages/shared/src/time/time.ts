/**
 * Time & timezone helpers (§6.4). Entry point for `@clockoff/shared/time/time` and the package barrel.
 *
 * Conventions: instants are UTC `Date`s; local values are `YYYY-MM-DD` / `HH:mm` strings plus an IANA
 * zone; every interval is half-open `[start, end)`; DST gaps shift forward, overlaps take the first
 * occurrence (see `zone.ts`).
 */
export * from "./clock";
export * from "./parse";
export * from "./zone";
export * from "./intervals";
export * from "./shift";
export * from "./recurrence";
