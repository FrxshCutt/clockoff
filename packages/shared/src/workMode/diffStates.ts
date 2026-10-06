import type { ActivityEventType, WorkModeState } from "../enums";
import { restrictionSignature } from "./computeExpectedState";
import { assertNever } from "./instants";
import { coveringShiftAt } from "./mergeShiftIntervals";
import type { BreakRef, ExpectedState, ShiftRef, Transition, WorkingInterval } from "./types";

/**
 * Transition → ActivityEvent mapping (§6.2 "All transitions produce a typed Transition list").
 *
 * `diffStates(prev, next)` compares two evaluations and returns one Transition per ActivityEvent the change
 * implies, in causal order:
 *   1. PERMISSION_NEEDS_ATTENTION    entered PERMISSION_ERROR (the cause of a WORK_MODE_ENDED that follows).
 *   2. BREAK_EXPIRED / BREAK_ENDED   the previous break is gone. EXPIRED when it ran its full planned length
 *                                    (its effective end was its plannedEndsAt and that instant has passed —
 *                                    a tie with the shift end counts as EXPIRED, like `breaks/`), ENDED
 *                                    otherwise (ended early, cut short by its shift's end, shift cancelled).
 *   3. WORK_MODE_ENDED               left an active state (WORKING / ON_BREAK / SHIFT_ENDING), or moved to a
 *                                    different working interval (adds overrideId when a lifting override caused it).
 *                                    Two intervals are the same stretch of work when they overlap or touch, so a
 *                                    schedule edit that extends the current interval emits nothing.
 *   4. OVERRIDE_EXPIRED              the previous override is gone *and* its expiresAt has passed
 *                                    (a revoked override emits nothing: the revoke endpoint audits that).
 *   5. WORK_MODE_STARTED             entered an active state, or moved to a different working interval.
 *   6. BREAK_STARTED                 a different break session is now running.
 * When the states or restriction differ but none of the above applies (OFF_SHIFT → SHIFT_STARTING_SOON,
 * WORKING → SHIFT_ENDING, a TEMPORARY_EXCEPTION starting, MANAGER_OVERRIDE → OFF_SHIFT at shift end with the
 * override still active) a single Transition without `eventType` is returned so the caller still knows the
 * persisted state must change. Nothing changed → `[]`.
 *
 * Every Transition's `at` is `next.computedAt` (the observation instant). Use `replayTransitions` to get the
 * exact instant of each change when evaluations may be far apart.
 *
 * Ids: BREAK_* name the break (and its own shift); PERMISSION_NEEDS_ATTENTION, WORK_MODE_STARTED and
 * BREAK_STARTED name `next`'s shift; WORK_MODE_ENDED and OVERRIDE_EXPIRED name the shift that was in
 * progress immediately before the change (see `shiftInProgressBefore`), never a stale `prev.activeShift`.
 *
 * `prev` may be a bare `WorkModeState` (e.g. the last persisted state). Break/override/interval details are
 * then unknown, so only state-level events are derived (BREAK_ENDED rather than BREAK_EXPIRED, no
 * OVERRIDE_EXPIRED, no interval-change detection, and a break running across PERMISSION_ERROR /
 * MANAGER_OVERRIDE may be reported as started again). Pass the previous `ExpectedState` whenever possible.
 *
 * Inherent limit of comparing two snapshots: a break ended early is only recognised as ENDED when `prev`
 * already saw its endedAt or `next` is observed before its planned end; otherwise (e.g. ticks minutes apart)
 * it reads as EXPIRED. `replayTransitions` evaluates the current rows at the exact instants and has no such gap.
 */

/**
 * Same stretch of work: the intervals overlap or touch (the closed comparison mirrors `mergeShiftIntervals`,
 * where adjacent shifts merge). Within one evaluation intervals are disjoint with a positive gap, so this
 * only matters across evaluations whose rows differ — e.g. a shift added just before the current one, or the
 * first of two back-to-back shifts being marked COMPLETED at the handover.
 */
function sameWorkingInterval(a: WorkingInterval, b: WorkingInterval): boolean {
  return a.startsAt.getTime() <= b.endsAt.getTime() && b.startsAt.getTime() <= a.endsAt.getTime();
}

/**
 * The shift in progress immediately before `atMs`, judged from `prev`'s working interval. `prev.activeShift`
 * alone can be stale: inside a merged interval of back-to-back / overlapping shifts the active shift changes
 * without a transition, so the previous evaluation (replay's previous step, or a job tick minutes earlier)
 * may still name the first shift when the change happens during a later one. Null when `prev` had no shift
 * in progress.
 */
function shiftInProgressBefore(prev: ExpectedState, atMs: number): ShiftRef | null {
  const interval = prev.workingInterval;
  if (prev.activeShift === null || interval === null) return prev.activeShift;
  const probeMs = Math.min(atMs, interval.endsAt.getTime()) - 1;
  // Never look before what `prev` itself observed (e.g. two evaluations at the same instant).
  if (probeMs <= prev.computedAt.getTime()) return prev.activeShift;
  return coveringShiftAt(interval, new Date(probeMs)) ?? prev.activeShift;
}

/** EXPIRED only when the break ran to its planned end; see the header for the full rule. */
function breakEndEventType(prevBreak: BreakRef | null, atMs: number): ActivityEventType {
  if (prevBreak === null) return "BREAK_ENDED";
  const plannedMs = prevBreak.plannedEndsAt.getTime();
  const ranFullLength = prevBreak.endsAt.getTime() === plannedMs;
  return ranFullLength && plannedMs <= atMs ? "BREAK_EXPIRED" : "BREAK_ENDED";
}

export function isWorkModeActiveState(state: WorkModeState): boolean {
  switch (state) {
    case "WORKING":
    case "ON_BREAK":
    case "SHIFT_ENDING":
      return true;
    case "OFF_SHIFT":
    case "SHIFT_STARTING_SOON":
    case "MANAGER_OVERRIDE":
    case "PERMISSION_ERROR":
    case "SYNC_ERROR":
    case "UNKNOWN":
      return false;
    default:
      return assertNever(state, "WorkModeState");
  }
}

function withIds(
  base: Transition,
  ids: { shiftId?: string | null; breakSessionId?: string | null; overrideId?: string | null },
): Transition {
  const t: Transition = { ...base };
  if (ids.shiftId) t.shiftId = ids.shiftId;
  if (ids.breakSessionId) t.breakSessionId = ids.breakSessionId;
  if (ids.overrideId) t.overrideId = ids.overrideId;
  return t;
}

export function diffStates(prev: WorkModeState | ExpectedState, next: ExpectedState): Transition[] {
  const prevSnap: ExpectedState | null = typeof prev === "string" ? null : prev;
  const from: WorkModeState = typeof prev === "string" ? prev : prev.state;
  const to = next.state;
  const at = next.computedAt;
  const atMs = at.getTime();

  const prevActive = isWorkModeActiveState(from);
  const nextActive = isWorkModeActiveState(to);

  const prevBreak = prevSnap?.activeBreak ?? null;
  const nextBreak = next.activeBreak;
  const prevOverride = prevSnap?.activeOverride ?? null;
  const nextOverride = next.activeOverride;

  // Same working interval? Only decidable with a full previous snapshot.
  const intervalChanged =
    prevSnap !== null &&
    prevSnap.workingInterval !== null &&
    next.workingInterval !== null &&
    !sameWorkingInterval(prevSnap.workingInterval, next.workingInterval);

  const endedShiftId =
    prevSnap === null ? null : (shiftInProgressBefore(prevSnap, atMs)?.id ?? null);

  const transitions: Transition[] = [];
  const emit = (
    eventType: ActivityEventType,
    ids: { shiftId?: string | null; breakSessionId?: string | null; overrideId?: string | null },
  ) => transitions.push(withIds({ from, to, at, eventType }, ids));

  // 1. Permission problem surfaced.
  if (to === "PERMISSION_ERROR" && from !== "PERMISSION_ERROR") {
    emit("PERMISSION_NEEDS_ATTENTION", { shiftId: next.activeShift?.id ?? next.upcomingShift?.id });
  }

  // 2. Break ended / expired.
  const breakEnded = prevSnap
    ? prevBreak !== null && prevBreak.id !== nextBreak?.id
    : from === "ON_BREAK" && nextBreak === null;
  if (breakEnded) {
    emit(breakEndEventType(prevBreak, atMs), {
      breakSessionId: prevBreak?.id,
      shiftId: prevBreak?.shiftId ?? prevSnap?.activeShift?.id,
    });
  }

  // 3. Work mode ended.
  if ((prevActive && !nextActive) || (prevActive && nextActive && intervalChanged)) {
    emit("WORK_MODE_ENDED", {
      shiftId: endedShiftId,
      overrideId: to === "MANAGER_OVERRIDE" ? nextOverride?.id : undefined,
    });
  }

  // 4. Override expired (not revoked, not merely out of window).
  if (
    prevOverride !== null &&
    prevOverride.id !== nextOverride?.id &&
    prevOverride.expiresAt.getTime() <= atMs
  ) {
    emit("OVERRIDE_EXPIRED", { overrideId: prevOverride.id, shiftId: endedShiftId });
  }

  // 5. Work mode started.
  if ((!prevActive && nextActive) || (prevActive && nextActive && intervalChanged)) {
    emit("WORK_MODE_STARTED", { shiftId: next.activeShift?.id });
  }

  // 6. Break started.
  const breakStarted = prevSnap
    ? nextBreak !== null && nextBreak.id !== prevBreak?.id
    : to === "ON_BREAK" && from !== "ON_BREAK";
  if (breakStarted) {
    emit("BREAK_STARTED", {
      breakSessionId: nextBreak?.id,
      shiftId: nextBreak?.shiftId ?? next.activeShift?.id,
    });
  }

  if (transitions.length > 0) return transitions;

  const changed =
    from !== to ||
    intervalChanged ||
    (prevSnap !== null && restrictionSignature(prevSnap) !== restrictionSignature(next));
  return changed ? [{ from, to, at }] : [];
}
