import type { ShiftStatus } from "../enums";
import { assertNever, toDate } from "./instants";
import type { ShiftRef, WorkingInterval, WorkModeShiftLike } from "./types";

/**
 * A shift counts for Work Mode only while it is SCHEDULED and not soft-deleted. CANCELLED and COMPLETED
 * shifts are ignored (§6.2), as are rows with `deletedAt` set.
 */
export function isEffectiveShift(shift: WorkModeShiftLike): boolean {
  if (shift.deletedAt !== null && shift.deletedAt !== undefined) return false;
  const status: ShiftStatus = shift.status;
  switch (status) {
    case "SCHEDULED":
      return true;
    case "CANCELLED":
    case "COMPLETED":
      return false;
    default:
      return assertNever(status, "ShiftStatus");
  }
}

function compareShiftRefs(a: ShiftRef, b: ShiftRef): number {
  return (
    a.startsAt.getTime() - b.startsAt.getTime() ||
    a.endsAt.getTime() - b.endsAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Normalises the effective shifts (SCHEDULED, not deleted, positive length, unique id) into `ShiftRef`s
 * ordered by start. Shared by `mergeShiftIntervals` and the schedule/conflict code.
 */
export function normaliseShifts(shifts: readonly WorkModeShiftLike[]): ShiftRef[] {
  const seen = new Set<string>();
  const refs: ShiftRef[] = [];
  for (const shift of shifts) {
    if (!isEffectiveShift(shift) || seen.has(shift.id)) continue;
    const startsAt = toDate(shift.startsAt, `shift ${shift.id}.startsAt`);
    const endsAt = toDate(shift.endsAt, `shift ${shift.id}.endsAt`);
    // Zero or negative length shifts cannot be worked; they are dropped rather than throwing so one bad row
    // never takes the whole employee's state machine down.
    if (endsAt.getTime() <= startsAt.getTime()) continue;
    seen.add(shift.id);
    refs.push({ id: shift.id, startsAt, endsAt });
  }
  return refs.sort(compareShiftRefs);
}

/**
 * Union of the effective shifts' [startsAt, endsAt) intervals. A shift whose start is ≤ the running end of
 * the current interval (overlapping or exactly adjacent) extends it; restrictions therefore never flap between
 * back-to-back shifts and SHIFT_ENDING only ever refers to the end of the merged interval. Result is ordered
 * by start and the intervals are pairwise disjoint with a strictly positive gap between them.
 */
export function mergeShiftIntervals(shifts: readonly WorkModeShiftLike[]): WorkingInterval[] {
  const intervals: WorkingInterval[] = [];
  for (const ref of normaliseShifts(shifts)) {
    const last = intervals[intervals.length - 1];
    if (last !== undefined && ref.startsAt.getTime() <= last.endsAt.getTime()) {
      if (ref.endsAt.getTime() > last.endsAt.getTime())
        last.endsAt = new Date(ref.endsAt.getTime());
      last.shiftIds.push(ref.id);
      last.shifts.push(ref);
    } else {
      intervals.push({
        startsAt: new Date(ref.startsAt.getTime()),
        endsAt: new Date(ref.endsAt.getTime()),
        shiftIds: [ref.id],
        shifts: [ref],
      });
    }
  }
  return intervals;
}

/** The interval containing `at` (start inclusive, end exclusive), or null. */
export function workingIntervalAt(
  intervals: readonly WorkingInterval[],
  at: Date,
): WorkingInterval | null {
  const ms = at.getTime();
  return intervals.find((i) => i.startsAt.getTime() <= ms && ms < i.endsAt.getTime()) ?? null;
}

/** The first interval starting strictly after `at`, or null. */
export function nextWorkingIntervalAfter(
  intervals: readonly WorkingInterval[],
  at: Date,
): WorkingInterval | null {
  const ms = at.getTime();
  return intervals.find((i) => i.startsAt.getTime() > ms) ?? null;
}

/**
 * The shift of `interval` that covers `at`: the earliest-starting one when several overlap. Returns null only
 * when `at` lies outside the interval.
 */
export function coveringShiftAt(interval: WorkingInterval, at: Date): ShiftRef | null {
  const ms = at.getTime();
  return interval.shifts.find((s) => s.startsAt.getTime() <= ms && ms < s.endsAt.getTime()) ?? null;
}
