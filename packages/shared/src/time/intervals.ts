/**
 * Instant arithmetic. All intervals in ClockOff are half-open `[start, end)`: a shift that ends at 15:00
 * does not overlap one that starts at 15:00, and 15:00:00 itself is "after" the first shift.
 */

const MS_PER_MINUTE = 60_000;

/**
 * Signed absolute minutes from `a` to `b` (`b - a`), fractional when the instants are not minute-aligned.
 * This is elapsed time, so a 22:00–06:00 shift is 420 or 540 on a DST night; see `wallClockMinutesBetween`
 * for the nominal wall-clock length.
 */
export function minutesBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / MS_PER_MINUTE;
}

/** Rounds `date` UP to the next whole minute; an instant already on a minute boundary is returned as is. */
export function roundUpToMinute(date: Date): Date {
  return new Date(Math.ceil(date.getTime() / MS_PER_MINUTE) * MS_PER_MINUTE);
}

/** Rounds `date` DOWN to the start of its minute. */
export function roundDownToMinute(date: Date): Date {
  return new Date(Math.floor(date.getTime() / MS_PER_MINUTE) * MS_PER_MINUTE);
}

/**
 * True when half-open intervals `[aStart, aEnd)` and `[bStart, bEnd)` share at least one instant. Touching
 * intervals (`aEnd === bStart`) do not overlap, and an empty or inverted interval (`end <= start`) contains
 * no instant, so it overlaps nothing.
 */
export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  const a0 = aStart.getTime();
  const a1 = aEnd.getTime();
  const b0 = bStart.getTime();
  const b1 = bEnd.getTime();
  return a0 < a1 && b0 < b1 && a0 < b1 && b0 < a1;
}

/** True when `instant` lies inside the half-open interval `[start, end)` (never for an empty interval). */
export function isWithin(instant: Date, start: Date, end: Date): boolean {
  const t = instant.getTime();
  return t >= start.getTime() && t < end.getTime();
}

/** `date + minutes` as a new instant (`minutes` may be negative or fractional). */
export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * MS_PER_MINUTE);
}
