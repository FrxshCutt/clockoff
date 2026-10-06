/*
 * Injectable clock. Services take a `Clock` (defaulting to `systemClock`) so tests can freeze or step time
 * without monkey-patching `Date`. All instants are UTC `Date`s.
 */

/** A source of the current instant. Inject it instead of calling `new Date()` so time can be controlled. */
export type Clock = () => Date;

/** The real system clock (`new Date()`). */
export const systemClock: Clock = () => new Date();

/** Current UTC instant from the given clock (defaults to the system clock), as a fresh `Date` copy. */
export function nowUtc(clock: Clock = systemClock): Date {
  return new Date(clock().getTime());
}

/**
 * Clock frozen at `at` (a `Date`, ISO string or epoch ms). Intended for tests and deterministic replays.
 * Throws `TypeError` for an unparseable instant.
 */
export function fixedClock(at: Date | string | number): Clock {
  const ms = at instanceof Date ? at.getTime() : new Date(at).getTime();
  if (Number.isNaN(ms)) {
    throw new TypeError(`fixedClock: invalid instant ${String(at)}`);
  }
  return () => new Date(ms);
}
