import { BREAK_RESTRICTION_BEHAVIOURS, OVERRIDE_TYPES, RESTRICTION_CATEGORIES } from "../enums";
import type {
  BreakRestrictionBehaviour,
  BreakSessionStatus,
  EffectiveRestriction,
  OverrideType,
  PermissionState,
  RestrictionCategory,
} from "../enums";
import { addMinutes, assertNever, futureInstants, minDate, toDate, toOptionalDate } from "./instants";
import { coveringShiftAt, mergeShiftIntervals, nextWorkingIntervalAfter, workingIntervalAt } from "./mergeShiftIntervals";
import type {
  BreakRef,
  ComputeExpectedStateInput,
  ExpectedState,
  ExpectedStateJson,
  OverrideRef,
  RelaxationSource,
  RestrictionRelaxation,
  ShiftRef,
  WorkModeMachineOptions,
  WorkingInterval,
} from "./types";

/**
 * Work Mode state machine (§6.2) — `computeExpectedState`.
 *
 * Precedence, highest first:
 *   0. OFF_SHIFT             no working interval in progress and none starting within preShiftWarningMinutes:
 *                            nothing else is consulted (overrides and permission problems are moot off shift).
 *   1. PERMISSION_ERROR      permission ≠ APPROVED while a shift is active or imminent. The *intended*
 *                            restriction is still reported so the dashboard can show what the device should
 *                            be enforcing.
 *   2. MANAGER_OVERRIDE      an active EMERGENCY_POLICY_OVERRIDE / END_WORK_MODE_EARLY / EXEMPT_TEMPORARILY
 *                            while a shift is active or imminent → restrictions NONE (a running break stays
 *                            reported in activeBreak).
 *   3. ON_BREAK              a break of a shift in the current interval, startedAt ≤ now < effective end
 *                            (min of plannedEndsAt, endedAt, the end of the break's own shift).
 *   4. TEMPORARY_EXCEPTION   active during a shift with no active break → state unchanged (WORKING or
 *                            SHIFT_ENDING) but effectiveRestriction BREAK_RELAXED per the override payload.
 *   5. SHIFT_ENDING          now ∈ [intervalEnd − shiftEndingWarningMinutes, intervalEnd).
 *   6. WORKING               now ∈ [intervalStart, intervalEnd).
 *   7. SHIFT_STARTING_SOON   now ∈ [intervalStart − preShiftWarningMinutes, intervalStart).
 *   8. OFF_SHIFT             otherwise.
 * SYNC_ERROR and UNKNOWN are device/dashboard states and are never produced here.
 */

export const DEFAULT_WORK_MODE_OPTIONS: Readonly<Required<WorkModeMachineOptions>> = {
  preShiftWarningMinutes: 15,
  shiftEndingWarningMinutes: 5,
};

type Snapshot = Omit<ExpectedState, "nextTransitionAt">;

/**
 * A break session that ran (or runs) during [startedAt, min(plannedEndsAt, endedAt, interval end)). An ACTIVE
 * row is open-ended up to its plannedEndsAt; an ENDED row is bounded by its endedAt, so evaluating a past
 * instant (replay) still sees the break. An ENDED row without endedAt carries no usable window and is dropped.
 */
interface NormalisedBreak {
  id: string;
  shiftId: string;
  startedAt: Date;
  plannedEndsAt: Date;
  endedAt: Date | null;
  behaviour: BreakRestrictionBehaviour;
  categories: RestrictionCategory[];
}

interface NormalisedOverride {
  ref: OverrideRef;
  revokedAt: Date | null;
  /** Break behaviour carried by a TEMPORARY_EXCEPTION payload (RELAX_ALL when absent). */
  behaviour: BreakRestrictionBehaviour;
  categories: RestrictionCategory[];
}

interface Context {
  now: Date;
  timezone: string | null;
  permissionState: PermissionState;
  permissionApproved: boolean;
  options: Readonly<Required<WorkModeMachineOptions>>;
  intervals: WorkingInterval[];
  /** Every effective shift by id (each belongs to exactly one interval). */
  shiftsById: Map<string, ShiftRef>;
  breaks: NormalisedBreak[];
  /** Only overrides applicable to the employee (org-wide, or matching `employeeId`). */
  overrides: NormalisedOverride[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalisation
// ─────────────────────────────────────────────────────────────────────────────

function resolveOptions(options: WorkModeMachineOptions | undefined): Readonly<Required<WorkModeMachineOptions>> {
  const pre = options?.preShiftWarningMinutes ?? DEFAULT_WORK_MODE_OPTIONS.preShiftWarningMinutes;
  const ending = options?.shiftEndingWarningMinutes ?? DEFAULT_WORK_MODE_OPTIONS.shiftEndingWarningMinutes;
  for (const [name, value] of [
    ["preShiftWarningMinutes", pre],
    ["shiftEndingWarningMinutes", ending],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`workMode: options.${name} must be a finite number ≥ 0 (got ${String(value)})`);
    }
  }
  return { preShiftWarningMinutes: pre, shiftEndingWarningMinutes: ending };
}

export function isPermissionApproved(permissionState: PermissionState): boolean {
  switch (permissionState) {
    case "APPROVED":
      return true;
    case "NOT_DETERMINED":
    case "DENIED":
    case "REVOKED":
    case "UNKNOWN":
      return false;
    default:
      return assertNever(permissionState, "PermissionState");
  }
}

/** Whether a session row has a usable window: ACTIVE always; ENDED only when its endedAt is known. */
function hasBreakWindow(status: BreakSessionStatus, endedAt: Date | null): boolean {
  switch (status) {
    case "ACTIVE":
      return true;
    case "ENDED":
      return endedAt !== null;
    default:
      return assertNever(status, "BreakSessionStatus");
  }
}

function parseBehaviour(value: unknown): BreakRestrictionBehaviour {
  return typeof value === "string" && (BREAK_RESTRICTION_BEHAVIOURS as readonly string[]).includes(value)
    ? (value as BreakRestrictionBehaviour)
    : "RELAX_ALL";
}

/** JSON array → known categories, de-duplicated, in canonical `RESTRICTION_CATEGORIES` order (same as `breaks/`). */
function parseCategories(value: unknown): RestrictionCategory[] {
  if (!Array.isArray(value)) return [];
  const present = new Set<unknown>(value);
  return RESTRICTION_CATEGORIES.filter((category) => present.has(category));
}

/**
 * Enum fields are validated up front, like every instant, so a bad row fails the same way whatever `now` is
 * (instead of only when it happens to be consulted).
 */
function assertOneOf<T extends string>(values: readonly T[], value: unknown, field: string): T {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw new TypeError(`workMode: ${field} must be one of ${values.join(", ")} (got ${JSON.stringify(value)})`);
  }
  return value as T;
}

function payloadField(payload: unknown, key: string): unknown {
  return typeof payload === "object" && payload !== null && key in payload
    ? (payload as Record<string, unknown>)[key]
    : undefined;
}

function buildContext(input: ComputeExpectedStateInput): Context {
  const now = toDate(input.now, "now");
  const employeeId = input.employeeId ?? null;

  const breaks: NormalisedBreak[] = [];
  for (const b of input.breakSessions ?? []) {
    const endedAt = toOptionalDate(b.endedAt, `breakSession ${b.id}.endedAt`);
    if (!hasBreakWindow(b.status, endedAt)) continue;
    breaks.push({
      id: b.id,
      shiftId: b.shiftId,
      startedAt: toDate(b.startedAt, `breakSession ${b.id}.startedAt`),
      plannedEndsAt: toDate(b.plannedEndsAt, `breakSession ${b.id}.plannedEndsAt`),
      endedAt,
      behaviour: assertOneOf(BREAK_RESTRICTION_BEHAVIOURS, b.restrictionBehaviour, `breakSession ${b.id}.restrictionBehaviour`),
      categories: parseCategories(b.relaxedCategories),
    });
  }

  const overrides: NormalisedOverride[] = [];
  for (const o of input.overrides ?? []) {
    const scope = o.employeeId ?? null;
    if (scope !== null && employeeId !== null && scope !== employeeId) continue;
    overrides.push({
      ref: {
        id: o.id,
        type: assertOneOf(OVERRIDE_TYPES, o.type, `override ${o.id}.type`),
        startsAt: toDate(o.startsAt, `override ${o.id}.startsAt`),
        expiresAt: toDate(o.expiresAt, `override ${o.id}.expiresAt`),
        employeeId: scope,
      },
      revokedAt: toOptionalDate(o.revokedAt, `override ${o.id}.revokedAt`),
      behaviour: parseBehaviour(payloadField(o.payload, "restrictionBehaviour")),
      categories: parseCategories(payloadField(o.payload, "relaxedCategories")),
    });
  }

  const intervals = mergeShiftIntervals(input.shifts);
  const shiftsById = new Map<string, ShiftRef>();
  for (const interval of intervals) for (const shift of interval.shifts) shiftsById.set(shift.id, shift);

  return {
    now,
    timezone: input.timezone ?? null,
    permissionState: input.permissionState,
    permissionApproved: isPermissionApproved(input.permissionState),
    options: resolveOptions(input.options),
    intervals,
    shiftsById,
    breaks,
    overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation at an instant
// ─────────────────────────────────────────────────────────────────────────────

interface RestrictionOutcome {
  effectiveRestriction: EffectiveRestriction;
  restrictionsShouldBeActive: boolean;
  relaxation: RestrictionRelaxation | null;
}

const WORK_RESTRICTION: RestrictionOutcome = {
  effectiveRestriction: "WORK",
  restrictionsShouldBeActive: true,
  relaxation: null,
};

/**
 * Maps a break behaviour to the restriction outcome:
 *   KEEP_RESTRICTIONS            → WORK (nothing lifted)
 *   RELAX_CATEGORIES, empty list → WORK (nothing lifted — same as `breakRestrictionForSession`)
 *   RELAX_CATEGORIES, ≥ 1        → BREAK_RELAXED, the listed categories lifted, the rest still enforced
 *   RELAX_ALL                    → BREAK_RELAXED, every category lifted, so no shield is active
 * BREAK_RELAXED names the *break profile*; `restrictionsShouldBeActive` + `relaxation.liftedCategories` say
 * what is enforced. A relaxed break is therefore never confused with "off shift" / MANAGER_OVERRIDE (NONE).
 * `breakRestrictionForSession` in `breaks/` uses the same mapping (pinned by its parity test).
 */
function restrictionFor(
  behaviour: BreakRestrictionBehaviour,
  categories: RestrictionCategory[],
  source: RelaxationSource,
): RestrictionOutcome {
  switch (behaviour) {
    case "KEEP_RESTRICTIONS":
      return WORK_RESTRICTION;
    case "RELAX_ALL":
      return {
        effectiveRestriction: "BREAK_RELAXED",
        restrictionsShouldBeActive: false,
        relaxation: {
          source,
          restrictionBehaviour: behaviour,
          relaxedCategories: [],
          liftedCategories: [...RESTRICTION_CATEGORIES],
        },
      };
    case "RELAX_CATEGORIES":
      if (categories.length === 0) return WORK_RESTRICTION;
      return {
        effectiveRestriction: "BREAK_RELAXED",
        restrictionsShouldBeActive: categories.length < RESTRICTION_CATEGORIES.length,
        relaxation: {
          source,
          restrictionBehaviour: behaviour,
          relaxedCategories: [...categories],
          liftedCategories: [...categories],
        },
      };
    default:
      return assertNever(behaviour, "BreakRestrictionBehaviour");
  }
}

/** Lower rank wins when several lifting overrides are active at once. TEMPORARY_EXCEPTION never lifts. */
function overrideRank(type: OverrideType): number {
  switch (type) {
    case "EMERGENCY_POLICY_OVERRIDE":
      return 0;
    case "END_WORK_MODE_EARLY":
      return 1;
    case "EXEMPT_TEMPORARILY":
      return 2;
    case "TEMPORARY_EXCEPTION":
      return 3;
    default:
      return assertNever(type, "OverrideType");
  }
}

function isLiftingOverride(type: OverrideType): boolean {
  switch (type) {
    case "EMERGENCY_POLICY_OVERRIDE":
    case "END_WORK_MODE_EARLY":
    case "EXEMPT_TEMPORARILY":
      return true;
    case "TEMPORARY_EXCEPTION":
      return false;
    default:
      return assertNever(type, "OverrideType");
  }
}

function isOverrideActiveAt(o: NormalisedOverride, ms: number): boolean {
  if (o.ref.startsAt.getTime() > ms || ms >= o.ref.expiresAt.getTime()) return false;
  return o.revokedAt === null || ms < o.revokedAt.getTime();
}

function compareOverrides(a: NormalisedOverride, b: NormalisedOverride): number {
  return (
    overrideRank(a.ref.type) - overrideRank(b.ref.type) ||
    a.ref.startsAt.getTime() - b.ref.startsAt.getTime() ||
    (a.ref.id < b.ref.id ? -1 : a.ref.id > b.ref.id ? 1 : 0)
  );
}

interface ActiveBreak {
  ref: BreakRef;
  behaviour: BreakRestrictionBehaviour;
  categories: RestrictionCategory[];
}

/**
 * Effective end of a break session: min(plannedEndsAt, endedAt, end of its own shift). "Shift end always
 * terminates an active break" (§6.2) applies to the break's *own* shift even inside a merged interval — the
 * same bound `breaks/` uses (a break is approved with plannedEndsAt ≤ shift.endsAt and a stale row is closed
 * with SHIFT_ENDED at that shift's end), so the machine and the break allowance never disagree. Work Mode
 * itself does not flap at a back-to-back handover: only the relaxation ends.
 */
function breakEffectiveEnd(b: NormalisedBreak, ownShift: ShiftRef): Date {
  const end = minDate(b.plannedEndsAt, ownShift.endsAt);
  return b.endedAt === null ? end : minDate(end, b.endedAt);
}

/**
 * The break running at `at` inside `interval`: a session of one of the interval's shifts that has started
 * and whose effective end (see `breakEffectiveEnd`) is still ahead. A session whose plannedEndsAt has passed
 * is treated as EXPIRED even if its row is still ACTIVE.
 */
function findActiveBreak(ctx: Context, interval: WorkingInterval, at: Date): ActiveBreak | null {
  const ms = at.getTime();
  let best: ActiveBreak | null = null;
  for (const b of ctx.breaks) {
    if (!interval.shiftIds.includes(b.shiftId)) continue;
    const ownShift = ctx.shiftsById.get(b.shiftId);
    if (ownShift === undefined) continue;
    if (b.startedAt.getTime() > ms) continue;
    const endsAt = breakEffectiveEnd(b, ownShift);
    if (endsAt.getTime() <= ms) continue;
    const candidate: ActiveBreak = {
      ref: { id: b.id, shiftId: b.shiftId, startedAt: b.startedAt, plannedEndsAt: b.plannedEndsAt, endsAt },
      behaviour: b.behaviour,
      categories: b.categories,
    };
    // Two overlapping sessions is a data-integrity bug upstream; prefer the most recently started one.
    if (
      best === null ||
      candidate.ref.startedAt.getTime() > best.ref.startedAt.getTime() ||
      (candidate.ref.startedAt.getTime() === best.ref.startedAt.getTime() && candidate.ref.id < best.ref.id)
    ) {
      best = candidate;
    }
  }
  return best;
}

function evaluateAt(ctx: Context, at: Date): Snapshot {
  const ms = at.getTime();
  const { preShiftWarningMinutes, shiftEndingWarningMinutes } = ctx.options;

  const current = workingIntervalAt(ctx.intervals, at);
  const upcoming = nextWorkingIntervalAfter(ctx.intervals, at);
  const upcomingShift: ShiftRef | null = upcoming?.shifts[0] ?? null;
  const imminent =
    current === null && upcoming !== null && addMinutes(upcoming.startsAt, -preShiftWarningMinutes).getTime() <= ms
      ? upcoming
      : null;

  let snap: Snapshot = {
    state: "OFF_SHIFT",
    effectiveRestriction: "NONE",
    restrictionsShouldBeActive: false,
    computedAt: at,
    timezone: ctx.timezone,
    permissionState: ctx.permissionState,
    activeShift: null,
    upcomingShift,
    activeBreak: null,
    activeOverride: null,
    workingInterval: null,
    relaxation: null,
  };

  // Off shift and not imminent: nothing else applies (overrides and permission problems are moot).
  if (current === null && imminent === null) return snap;

  // Schedule-derived state.
  let activeBreak: ActiveBreak | null = null;
  if (current !== null) {
    snap = { ...snap, workingInterval: current, activeShift: coveringShiftAt(current, at) };
    activeBreak = findActiveBreak(ctx, current, at);
    if (activeBreak !== null) {
      snap = {
        ...snap,
        state: "ON_BREAK",
        activeBreak: activeBreak.ref,
        ...restrictionFor(activeBreak.behaviour, activeBreak.categories, "BREAK"),
      };
    } else if (ms >= addMinutes(current.endsAt, -shiftEndingWarningMinutes).getTime()) {
      snap = { ...snap, state: "SHIFT_ENDING", ...WORK_RESTRICTION };
    } else {
      snap = { ...snap, state: "WORKING", ...WORK_RESTRICTION };
    }
  } else if (imminent !== null) {
    snap = { ...snap, state: "SHIFT_STARTING_SOON", workingInterval: imminent };
  }

  // Manager overrides.
  const active = ctx.overrides.filter((o) => isOverrideActiveAt(o, ms)).sort(compareOverrides);
  const lifting = active.find((o) => isLiftingOverride(o.ref.type)) ?? null;
  if (lifting !== null) {
    // The break session (if any) keeps running underneath: activeBreak stays reported.
    snap = {
      ...snap,
      state: "MANAGER_OVERRIDE",
      effectiveRestriction: "NONE",
      restrictionsShouldBeActive: false,
      relaxation: null,
      activeOverride: lifting.ref,
    };
  } else if (current !== null && activeBreak === null) {
    // TEMPORARY_EXCEPTION: state stays WORKING / SHIFT_ENDING, restriction relaxed per its payload. A running
    // break takes precedence (it already relaxes, under its own snapshot). One that relaxes nothing
    // (KEEP_RESTRICTIONS / empty category list) does not change the output, is not reported, and does not
    // mask another exception that does relax; among those, the earliest-starting one applies (then id).
    for (const exception of active) {
      if (exception.ref.type !== "TEMPORARY_EXCEPTION") continue;
      const outcome = restrictionFor(exception.behaviour, exception.categories, "OVERRIDE");
      if (outcome.relaxation === null) continue;
      snap = { ...snap, ...outcome, activeOverride: exception.ref };
      break;
    }
  }

  // Permission dominates while a shift is active or imminent; the intended restriction is kept.
  if (!ctx.permissionApproved) snap = { ...snap, state: "PERMISSION_ERROR" };

  return snap;
}

// ─────────────────────────────────────────────────────────────────────────────
// Next transition
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The part of an `ExpectedState` whose change constitutes a transition: state, restriction, break, override,
 * relaxation, and which working interval the state refers to (imminent vs in progress). `activeShift`
 * changing inside one merged interval (back-to-back shifts) is deliberately *not* a transition —
 * restrictions must never flap there — and neither is `upcomingShift`. Two outputs with equal signatures are
 * interchangeable for the device and the dashboard.
 */
export function restrictionSignature(state: Snapshot | ExpectedState): string {
  const relax = state.relaxation
    ? `${state.relaxation.source}:${state.relaxation.restrictionBehaviour}:${state.relaxation.liftedCategories.join(",")}`
    : "";
  const interval = state.workingInterval
    ? `${state.activeShift !== null ? "in" : "soon"}@${state.workingInterval.startsAt.getTime()}`
    : "";
  return [
    state.state,
    state.effectiveRestriction,
    String(state.restrictionsShouldBeActive),
    state.activeBreak?.id ?? "",
    state.activeOverride?.id ?? "",
    relax,
    interval,
  ].join("|");
}

/**
 * Every instant at which any input becomes true/false is a candidate; the first candidate whose evaluation
 * differs from `snapshot` is the real next change. Candidates are finite (4 per interval, ≤4 per break, ≤3
 * per override) so this is cheap, and it guarantees nextTransitionAt never points at a no-op such as the
 * individual end of the first of two back-to-back shifts.
 */
function findNextTransition(ctx: Context, snapshot: Snapshot): Date | null {
  const { preShiftWarningMinutes, shiftEndingWarningMinutes } = ctx.options;
  const candidates: Date[] = [];
  for (const i of ctx.intervals) {
    candidates.push(
      addMinutes(i.startsAt, -preShiftWarningMinutes),
      i.startsAt,
      addMinutes(i.endsAt, -shiftEndingWarningMinutes),
      i.endsAt,
    );
  }
  for (const b of ctx.breaks) {
    candidates.push(b.startedAt, b.plannedEndsAt);
    if (b.endedAt !== null) candidates.push(b.endedAt);
    // A break also ends at its own shift's end, which inside a merged interval is not an interval boundary.
    const ownShift = ctx.shiftsById.get(b.shiftId);
    if (ownShift !== undefined) candidates.push(ownShift.endsAt);
  }
  for (const o of ctx.overrides) {
    candidates.push(o.ref.startsAt, o.ref.expiresAt);
    if (o.revokedAt !== null) candidates.push(o.revokedAt);
  }
  const base = restrictionSignature(snapshot);
  for (const at of futureInstants(candidates, ctx.now)) {
    if (restrictionSignature(evaluateAt(ctx, at)) !== base) return at;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pure: same input → same output; no clocks, no I/O. Throws `TypeError` for an unparsable or offset-less
 * instant or an unknown enum value (shift status, break status / behaviour, override type, permission), and
 * `RangeError` for negative or non-finite option values — all programmer/data errors, never expected at
 * runtime, and raised whatever `now` is.
 */
export function computeExpectedState(input: ComputeExpectedStateInput): ExpectedState {
  const ctx = buildContext(input);
  const snapshot = evaluateAt(ctx, ctx.now);
  return { ...snapshot, nextTransitionAt: findNextTransition(ctx, snapshot) };
}

/** `nextTransitionAt` as a `Date | null`, for callers that only need the wake-up time. */
export function nextTransitionAt(input: ComputeExpectedStateInput): Date | null {
  return computeExpectedState(input).nextTransitionAt;
}

function shiftRefJson(ref: ShiftRef | null): ExpectedStateJson["activeShift"] {
  return ref ? { id: ref.id, startsAt: ref.startsAt.toISOString(), endsAt: ref.endsAt.toISOString() } : null;
}

/** Wire / fixture representation: every instant as an ISO-8601 UTC string. */
export function toExpectedStateJson(state: ExpectedState): ExpectedStateJson {
  return {
    state: state.state,
    effectiveRestriction: state.effectiveRestriction,
    restrictionsShouldBeActive: state.restrictionsShouldBeActive,
    computedAt: state.computedAt.toISOString(),
    timezone: state.timezone,
    permissionState: state.permissionState,
    activeShift: shiftRefJson(state.activeShift),
    upcomingShift: shiftRefJson(state.upcomingShift),
    activeBreak: state.activeBreak
      ? {
          id: state.activeBreak.id,
          shiftId: state.activeBreak.shiftId,
          startedAt: state.activeBreak.startedAt.toISOString(),
          plannedEndsAt: state.activeBreak.plannedEndsAt.toISOString(),
          endsAt: state.activeBreak.endsAt.toISOString(),
        }
      : null,
    activeOverride: state.activeOverride
      ? {
          id: state.activeOverride.id,
          type: state.activeOverride.type,
          startsAt: state.activeOverride.startsAt.toISOString(),
          expiresAt: state.activeOverride.expiresAt.toISOString(),
          employeeId: state.activeOverride.employeeId,
        }
      : null,
    workingInterval: state.workingInterval
      ? {
          startsAt: state.workingInterval.startsAt.toISOString(),
          endsAt: state.workingInterval.endsAt.toISOString(),
          shiftIds: [...state.workingInterval.shiftIds],
          shifts: state.workingInterval.shifts.map((s) => ({
            id: s.id,
            startsAt: s.startsAt.toISOString(),
            endsAt: s.endsAt.toISOString(),
          })),
        }
      : null,
    relaxation: state.relaxation
      ? {
          ...state.relaxation,
          relaxedCategories: [...state.relaxation.relaxedCategories],
          liftedCategories: [...state.relaxation.liftedCategories],
        }
      : null,
    nextTransitionAt: state.nextTransitionAt ? state.nextTransitionAt.toISOString() : null,
  };
}
