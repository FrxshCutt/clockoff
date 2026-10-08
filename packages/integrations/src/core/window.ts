import { addLocalDays, localDateOf, localDateRange } from "@clockoff/shared/time/zone";

/**
 * The shift sync window (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §6.6, spec §5): from the start of
 * yesterday to the start of today + `syncWindowDays` days, in the portal's time zone, as a half-open UTC range.
 * Planday's `/shifts` `from` / `to` are inclusive dates whose exact meaning (shift `date` or start/end times) is
 * undocumented (notes §10.3 rule 5, §12 Q38), so the query is one day wider on each side and records are filtered
 * on their computed instants.
 */
export interface SyncWindow {
  /** Start of yesterday in the portal zone (inclusive). */
  readonly from: Date;
  /** Start of the day `syncWindowDays` after today in the portal zone (exclusive). */
  readonly to: Date;
  /** `YYYY-MM-DD` for Planday's inclusive `from`: one day before the window's first day. */
  readonly queryFrom: string;
  /**
   * `YYYY-MM-DD` for Planday's inclusive `to`: one day after the window's last day (the local date of `to`).
   * With the 56-day maximum the query spans 59 dates (§16.1 Q37).
   */
  readonly queryTo: string;
}

/**
 * The window for `now` in `timezone` (an IANA zone; the portal's). Throws the shared time helpers' AppError
 * (`INVALID_TIMEZONE`) for a zone that is not IANA: callers check the portal zone first (wizard step 2).
 */
export function syncWindow(now: Date, timezone: string, days: number): SyncWindow {
  if (!Number.isInteger(days) || days < 1) throw new RangeError("days must be a positive integer");
  const today = localDateOf(now, timezone);
  const firstDay = addLocalDays(today, -1);
  const lastDay = addLocalDays(today, days - 1);
  const [from, to] = localDateRange(firstDay, lastDay, timezone);
  return {
    from,
    to,
    queryFrom: addLocalDays(firstDay, -1),
    queryTo: addLocalDays(lastDay, 1),
  };
}

/** Whether a shift's instants overlap the window: `endsAt > from` and `startsAt < to`. */
export function overlapsWindow(
  shift: { readonly startsAt: Date; readonly endsAt: Date },
  window: { readonly from: Date; readonly to: Date },
): boolean {
  return (
    shift.endsAt.getTime() > window.from.getTime() && shift.startsAt.getTime() < window.to.getTime()
  );
}

/**
 * Splits the inclusive date range `fromDate..toDate` into consecutive inclusive slices of at most `maxDays`
 * dates. The SHIFTS phase switches to 14-day slices when Planday answers 400 for the whole range (its maximum
 * range is undocumented, §6.6, Q37).
 */
export function splitDateRange(
  fromDate: string,
  toDate: string,
  maxDays: number,
): Array<{ readonly from: string; readonly to: string }> {
  if (!Number.isInteger(maxDays) || maxDays < 1) {
    throw new RangeError("maxDays must be a positive integer");
  }
  const slices: Array<{ from: string; to: string }> = [];
  let start = fromDate;
  while (start <= toDate) {
    const candidate = addLocalDays(start, maxDays - 1);
    const end = candidate < toDate ? candidate : toDate;
    slices.push({ from: start, to: end });
    start = addLocalDays(end, 1);
  }
  return slices;
}
