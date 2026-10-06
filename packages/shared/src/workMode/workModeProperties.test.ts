import { describe, expect, it } from "vitest";
import {
  BREAK_RESTRICTION_BEHAVIOURS,
  OVERRIDE_TYPES,
  PERMISSION_STATES,
  RESTRICTION_CATEGORIES,
} from "../enums";
import type {
  BreakRestrictionBehaviour,
  BreakSessionStatus,
  EffectiveRestriction,
  OverrideType,
  PermissionState,
  RestrictionCategory,
  ShiftStatus,
  WorkModeState,
} from "../enums";
import {
  computeExpectedState,
  restrictionSignature,
  toExpectedStateJson,
} from "./computeExpectedState";
import { diffStates, isWorkModeActiveState } from "./diffStates";
import { replayTransitions } from "./replay";
import type { ComputeExpectedStateInput, ExpectedState, Transition } from "./types";

/**
 * Randomised differential / property tests for the Work Mode machine.
 *
 * Every generated instant is a whole minute inside a bounded horizon, so evaluating the machine at every
 * minute is exhaustive: each case is checked against
 *   1. an independent, deliberately naive reference model of the §6.2 rules (minute bitmap for the union of
 *      shifts, linear scans for breaks and overrides), at every minute;
 *   2. the nextTransitionAt contract, derived from the per-minute outputs (first later minute whose output
 *      differs, else null);
 *   3. replayTransitions over the whole horizon, which must emit exactly the events a minute-by-minute
 *      diffStates walk emits, with well-formed pairing (WORK_MODE_STARTED/ENDED alternate, every break that
 *      ends was started);
 *   4. invariance under input order, and under splitting a shift into back-to-back pieces ("restrictions
 *      never flap between back-to-back shifts").
 * The PRNG is seeded, so a failure names a reproducible case.
 */

// ─── deterministic generator ────────────────────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(values: readonly T[]): T {
    const value = values[this.int(0, values.length - 1)];
    if (value === undefined) throw new Error("pick from empty list");
    return value;
  }
  shuffle<T>(values: readonly T[]): T[] {
    const out = [...values];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      const a = out[i] as T;
      out[i] = out[j] as T;
      out[j] = a;
    }
    return out;
  }
}

const BASE_MS = Date.UTC(2026, 0, 12, 6);
const MINUTE = 60_000;
/** Every generated instant lies in [0, LAST_INSTANT]; the machine is evaluated on [0, HORIZON]. */
const LAST_INSTANT = 600;
const HORIZON = LAST_INSTANT + 2;
/** Default keeps the suite fast; set WORKMODE_PROPERTY_CASES (e.g. 5000) for a deep local run. */
const CASES = Number(process.env.WORKMODE_PROPERTY_CASES ?? 70);

const isoAt = (minute: number): string => new Date(BASE_MS + minute * MINUTE).toISOString();
const minuteOf = (d: Date): number => (d.getTime() - BASE_MS) / MINUTE;

interface MShift {
  id: string;
  s: number;
  e: number;
  status: ShiftStatus;
  deleted: boolean;
}
interface MBreak {
  id: string;
  shiftId: string;
  s: number;
  planned: number;
  ended: number | null;
  status: BreakSessionStatus;
  behaviour: BreakRestrictionBehaviour;
  categories: unknown[];
}
interface MOverride {
  id: string;
  type: OverrideType;
  s: number;
  e: number;
  revoked: number | null;
  employeeId: string | null;
  payload: Record<string, unknown>;
}
interface Model {
  shifts: MShift[];
  breaks: MBreak[];
  overrides: MOverride[];
  permission: PermissionState;
  employeeId: string | null;
  pre: number;
  ending: number;
}

const clampInstant = (m: number): number => Math.max(0, Math.min(LAST_INSTANT, m));

function randomCategories(rng: Rng): unknown[] {
  const out: unknown[] = [];
  const n = rng.int(0, 4);
  for (let i = 0; i < n; i += 1)
    out.push(rng.chance(0.1) ? "NOT_A_CATEGORY" : rng.pick(RESTRICTION_CATEGORIES));
  if (rng.chance(0.05)) return [...RESTRICTION_CATEGORIES];
  return out;
}

function generate(seed: number): Model {
  const rng = new Rng(seed);
  const shifts: MShift[] = [];
  const shiftCount = rng.int(0, 4);
  for (let i = 0; i < shiftCount; i += 1) {
    const prev = shifts[shifts.length - 1];
    const roll = rng.int(0, 99);
    let s: number;
    if (prev !== undefined && roll < 35)
      s = prev.e; // back-to-back
    else if (prev !== undefined && roll < 50)
      s = clampInstant(prev.e - rng.int(1, 60)); // overlap
    else if (prev !== undefined && roll < 65)
      s = clampInstant(prev.e + rng.int(1, 20)); // small gap
    else s = rng.int(20, LAST_INSTANT - 30);
    const e = rng.chance(0.03) ? s : clampInstant(s + rng.int(3, 240));
    shifts.push({
      id: `shift-${i}`,
      s,
      e,
      status: rng.chance(0.85) ? "SCHEDULED" : rng.pick(["CANCELLED", "COMPLETED"] as const),
      deleted: rng.chance(0.08),
    });
  }

  const breaks: MBreak[] = [];
  const breakCount = shifts.length === 0 ? 0 : rng.int(0, 3);
  for (let i = 0; i < breakCount; i += 1) {
    const shift = rng.pick(shifts);
    const s = clampInstant(shift.s + rng.int(0, Math.max(0, shift.e - shift.s)));
    const planned = clampInstant(s + rng.int(1, 40));
    const status: BreakSessionStatus = rng.chance(0.7) ? "ACTIVE" : "ENDED";
    const ended =
      status === "ENDED"
        ? rng.chance(0.85)
          ? clampInstant(s + rng.int(0, 50))
          : null
        : rng.chance(0.15)
          ? clampInstant(s + rng.int(0, 50))
          : null;
    breaks.push({
      id: `break-${i}`,
      shiftId: rng.chance(0.05) ? "shift-orphan" : shift.id,
      s,
      planned,
      ended,
      status,
      behaviour: rng.pick(BREAK_RESTRICTION_BEHAVIOURS),
      categories: randomCategories(rng),
    });
  }

  const overrides: MOverride[] = [];
  const overrideCount = rng.int(0, 3);
  for (let i = 0; i < overrideCount; i += 1) {
    const s = rng.int(0, LAST_INSTANT - 10);
    const e = clampInstant(s + rng.int(1, 200));
    const type = rng.pick(OVERRIDE_TYPES);
    const payload: Record<string, unknown> = {};
    if (type === "TEMPORARY_EXCEPTION" && rng.chance(0.7)) {
      payload.restrictionBehaviour = rng.chance(0.1)
        ? "NOT_A_BEHAVIOUR"
        : rng.pick(BREAK_RESTRICTION_BEHAVIOURS);
      payload.relaxedCategories = randomCategories(rng);
    }
    overrides.push({
      id: `ov-${i}`,
      type,
      s,
      e,
      revoked: rng.chance(0.15) ? clampInstant(s + rng.int(0, e - s)) : null,
      employeeId: rng.chance(0.15) ? null : rng.chance(0.85) ? "emp-1" : "emp-2",
      payload,
    });
  }

  const custom = rng.chance(0.3);
  return {
    shifts,
    breaks,
    overrides,
    permission: rng.chance(0.75)
      ? "APPROVED"
      : rng.pick(PERMISSION_STATES.filter((p) => p !== "APPROVED")),
    employeeId: rng.chance(0.9) ? "emp-1" : null,
    pre: custom ? rng.pick([0, 5, 30]) : 15,
    ending: custom ? rng.pick([0, 1, 10]) : 5,
  };
}

function toInput(model: Model, now: number): ComputeExpectedStateInput {
  return {
    now: isoAt(now),
    timezone: "Europe/London",
    permissionState: model.permission,
    employeeId: model.employeeId,
    options: { preShiftWarningMinutes: model.pre, shiftEndingWarningMinutes: model.ending },
    shifts: model.shifts.map((s) => ({
      id: s.id,
      startsAt: isoAt(s.s),
      endsAt: isoAt(s.e),
      status: s.status,
      deletedAt: s.deleted ? isoAt(0) : null,
    })),
    breakSessions: model.breaks.map((b) => ({
      id: b.id,
      shiftId: b.shiftId,
      startedAt: isoAt(b.s),
      plannedEndsAt: isoAt(b.planned),
      endedAt: b.ended === null ? null : isoAt(b.ended),
      status: b.status,
      restrictionBehaviour: b.behaviour,
      relaxedCategories: b.categories,
    })),
    overrides: model.overrides.map((o) => ({
      id: o.id,
      type: o.type,
      startsAt: isoAt(o.s),
      expiresAt: isoAt(o.e),
      revokedAt: o.revoked === null ? null : isoAt(o.revoked),
      employeeId: o.employeeId,
      payload: o.payload,
    })),
  };
}

// ─── independent reference model (minute resolution) ─────────────────────────────────────────────────────

interface RefOutput {
  state: WorkModeState;
  effectiveRestriction: EffectiveRestriction;
  restrictionsShouldBeActive: boolean;
  activeShiftId: string | null;
  activeBreakId: string | null;
  activeOverrideId: string | null;
  liftedCategories: RestrictionCategory[];
}

interface Restriction {
  effectiveRestriction: EffectiveRestriction;
  restrictionsShouldBeActive: boolean;
  liftedCategories: RestrictionCategory[];
}

const WORK: Restriction = {
  effectiveRestriction: "WORK",
  restrictionsShouldBeActive: true,
  liftedCategories: [],
};
const NONE: Restriction = {
  effectiveRestriction: "NONE",
  restrictionsShouldBeActive: false,
  liftedCategories: [],
};

function relax(behaviour: unknown, categories: unknown): Restriction {
  const known = Array.isArray(categories)
    ? RESTRICTION_CATEGORIES.filter((c) => categories.includes(c))
    : [];
  switch (behaviour) {
    case "KEEP_RESTRICTIONS":
      return WORK;
    case "RELAX_CATEGORIES":
      return known.length === 0
        ? WORK
        : {
            effectiveRestriction: "BREAK_RELAXED",
            restrictionsShouldBeActive: known.length < RESTRICTION_CATEGORIES.length,
            liftedCategories: known,
          };
    default: // RELAX_ALL, and any missing / invalid payload behaviour
      return {
        effectiveRestriction: "BREAK_RELAXED",
        restrictionsShouldBeActive: false,
        liftedCategories: [...RESTRICTION_CATEGORIES],
      };
  }
}

const LIFT_RANK: Record<OverrideType, number> = {
  EMERGENCY_POLICY_OVERRIDE: 0,
  END_WORK_MODE_EARLY: 1,
  EXEMPT_TEMPORARILY: 2,
  TEMPORARY_EXCEPTION: 99,
};

function reference(model: Model, now: number): RefOutput {
  const effective = model.shifts.filter((s) => s.status === "SCHEDULED" && !s.deleted && s.e > s.s);
  const working = (m: number): boolean => effective.some((s) => s.s <= m && m < s.e);

  let runStart: number | null = null;
  let runEnd: number | null = null;
  let imminent = false;
  if (working(now)) {
    runStart = now;
    while (working(runStart - 1)) runStart -= 1;
    runEnd = now + 1;
    while (working(runEnd)) runEnd += 1;
  } else {
    let m = now + 1;
    while (m <= HORIZON && !working(m)) m += 1;
    imminent = m <= HORIZON && m - model.pre <= now;
  }
  const off: RefOutput = {
    state: "OFF_SHIFT",
    ...NONE,
    activeShiftId: null,
    activeBreakId: null,
    activeOverrideId: null,
  };
  if (runStart === null && !imminent) return off;

  const runShifts =
    runStart === null || runEnd === null
      ? []
      : effective.filter((s) => s.s >= (runStart ?? 0) && s.s < (runEnd ?? 0));
  const activeShift =
    [...runShifts]
      .filter((s) => s.s <= now && now < s.e)
      .sort((a, b) => a.s - b.s || a.e - b.e || a.id.localeCompare(b.id))[0] ?? null;

  let brk: MBreak | null = null;
  for (const b of model.breaks) {
    const own = runShifts.find((s) => s.id === b.shiftId);
    if (own === undefined) continue;
    if (b.status === "ENDED" && b.ended === null) continue;
    const end = Math.min(b.planned, own.e, b.ended ?? Number.POSITIVE_INFINITY);
    if (!(b.s <= now && now < end)) continue;
    if (brk === null || b.s > brk.s || (b.s === brk.s && b.id < brk.id)) brk = b;
  }

  const applicable = model.overrides.filter(
    (o) =>
      (o.employeeId === null || model.employeeId === null || o.employeeId === model.employeeId) &&
      o.s <= now &&
      now < o.e &&
      (o.revoked === null || now < o.revoked),
  );
  const byStart = (a: MOverride, b: MOverride): number => a.s - b.s || a.id.localeCompare(b.id);
  const lifting =
    applicable
      .filter((o) => o.type !== "TEMPORARY_EXCEPTION")
      .sort((a, b) => LIFT_RANK[a.type] - LIFT_RANK[b.type] || byStart(a, b))[0] ?? null;
  const exception =
    applicable
      .filter((o) => o.type === "TEMPORARY_EXCEPTION")
      .sort(byStart)
      .find(
        (o) =>
          relax(o.payload.restrictionBehaviour, o.payload.relaxedCategories)
            .effectiveRestriction === "BREAK_RELAXED",
      ) ?? null;

  let state: WorkModeState;
  let restriction: Restriction;
  let activeOverrideId: string | null = null;
  if (runStart !== null && runEnd !== null) {
    if (brk !== null) {
      state = "ON_BREAK";
      restriction = relax(brk.behaviour, brk.categories);
    } else {
      state = now >= runEnd - model.ending ? "SHIFT_ENDING" : "WORKING";
      restriction = WORK;
    }
  } else {
    state = "SHIFT_STARTING_SOON";
    restriction = NONE;
  }
  if (lifting !== null) {
    state = "MANAGER_OVERRIDE";
    restriction = NONE;
    activeOverrideId = lifting.id;
  } else if (runStart !== null && brk === null && exception !== null) {
    restriction = relax(
      exception.payload.restrictionBehaviour,
      exception.payload.relaxedCategories,
    );
    activeOverrideId = exception.id;
  }
  if (model.permission !== "APPROVED") state = "PERMISSION_ERROR";

  return {
    state,
    ...restriction,
    activeShiftId: activeShift?.id ?? null,
    activeBreakId: brk?.id ?? null,
    activeOverrideId,
  };
}

function observed(result: ExpectedState): RefOutput {
  return {
    state: result.state,
    effectiveRestriction: result.effectiveRestriction,
    restrictionsShouldBeActive: result.restrictionsShouldBeActive,
    activeShiftId: result.activeShift?.id ?? null,
    activeBreakId: result.activeBreak?.id ?? null,
    activeOverrideId: result.activeOverride?.id ?? null,
    liftedCategories: result.relaxation?.liftedCategories ?? [],
  };
}

// ─── helpers ──────────────────────────────────────────────────────────────────────────────────────────────

function statesOverHorizon(model: Model): ExpectedState[] {
  const states: ExpectedState[] = [];
  for (let m = 0; m <= HORIZON; m += 1) states.push(computeExpectedState(toInput(model, m)));
  return states;
}

function eventView(t: Transition): string {
  return [
    minuteOf(t.at),
    t.eventType ?? `${t.from}->${t.to}`,
    t.shiftId ?? "",
    t.breakSessionId ?? "",
    t.overrideId ?? "",
  ].join(" ");
}

function describeModel(seed: number, model: Model): string {
  return `seed ${seed}: ${JSON.stringify(model)}`;
}

const SEEDS = Array.from({ length: CASES }, (_, i) => 1000 + i * 7919);

// ─── properties ───────────────────────────────────────────────────────────────────────────────────────────

// Each case is ~20 ms; the generous timeout only guards against false failures on a heavily loaded machine.
describe("Work Mode machine — randomised properties", { timeout: 60_000 }, () => {
  it.each(SEEDS)(
    "seed %i: matches the reference model and the nextTransitionAt / replay contracts",
    (seed) => {
      const model = generate(seed);
      const label = describeModel(seed, model);
      const states = statesOverHorizon(model);
      const signatures = states.map((s) => restrictionSignature(s));

      for (let m = 0; m <= HORIZON; m += 1) {
        const state = states[m] as ExpectedState;
        // 1. Reference model.
        expect(observed(state), `${label} @${m}`).toEqual(reference(model, m));

        // 2. nextTransitionAt is the first later minute whose output differs (null if none in the horizon;
        // nothing changes after the last generated instant).
        let expectedNext: number | null = null;
        for (let k = m + 1; k <= HORIZON; k += 1) {
          if (signatures[k] !== signatures[m]) {
            expectedNext = k;
            break;
          }
        }
        expect(
          state.nextTransitionAt === null ? null : minuteOf(state.nextTransitionAt),
          `${label} nta @${m}`,
        ).toBe(expectedNext);
      }

      // 3. Replay over the whole horizon equals a minute-by-minute walk of diffStates.
      const walked: string[] = [];
      for (let m = 1; m <= HORIZON; m += 1) {
        for (const t of diffStates(states[m - 1] as ExpectedState, states[m] as ExpectedState))
          walked.push(eventView(t));
      }
      const replay = replayTransitions(toInput(model, HORIZON), isoAt(0));
      expect(replay.transitions.map(eventView), label).toEqual(walked);
      expect(replay.states.at(-1)?.computedAt.toISOString()).toBe(isoAt(HORIZON));

      // ...and its events are well formed.
      let active = isWorkModeActiveState(states[0]?.state ?? "OFF_SHIFT");
      let runningBreak = states[0]?.activeBreak?.id ?? null;
      for (const t of replay.transitions) {
        switch (t.eventType) {
          case "WORK_MODE_STARTED":
            expect(active, `${label} ${eventView(t)}`).toBe(false);
            active = true;
            break;
          case "WORK_MODE_ENDED":
            expect(active, `${label} ${eventView(t)}`).toBe(true);
            active = false;
            break;
          case "BREAK_STARTED":
            expect(runningBreak, `${label} ${eventView(t)}`).toBeNull();
            runningBreak = t.breakSessionId ?? null;
            break;
          case "BREAK_ENDED":
          case "BREAK_EXPIRED":
            expect(t.breakSessionId, `${label} ${eventView(t)}`).toBe(runningBreak);
            runningBreak = null;
            break;
          default:
            break;
        }
        if (t.eventType === "WORK_MODE_ENDED" || t.eventType === "OVERRIDE_EXPIRED") {
          // The shift these events name is the one in progress just before the change.
          const before = states[minuteOf(t.at) - 1];
          if (before?.activeShift)
            expect(t.shiftId, `${label} ${eventView(t)}`).toBe(before.activeShift.id);
        }
      }
    },
  );

  it.each(SEEDS.slice(0, 30))("seed %i: output does not depend on input order", (seed) => {
    const model = generate(seed);
    const rng = new Rng(seed ^ 0x5bd1e995);
    const shuffled: Model = {
      ...model,
      shifts: rng.shuffle(model.shifts),
      breaks: rng.shuffle(model.breaks),
      overrides: rng.shuffle(model.overrides),
    };
    for (let m = 0; m <= HORIZON; m += 13) {
      expect(
        toExpectedStateJson(computeExpectedState(toInput(shuffled, m))),
        describeModel(seed, model),
      ).toEqual(toExpectedStateJson(computeExpectedState(toInput(model, m))));
    }
  });

  it.each(SEEDS.slice(0, 30))(
    "seed %i: splitting shifts into back-to-back pieces never changes the output",
    (seed) => {
      const model: Model = { ...generate(seed), breaks: [] };
      const rng = new Rng(seed ^ 0x27d4eb2d);
      const split: Model = {
        ...model,
        shifts: model.shifts.flatMap((s) => {
          if (s.e - s.s < 2) return [s];
          const cut = rng.int(s.s + 1, s.e - 1);
          return [
            { ...s, id: `${s.id}-a`, e: cut },
            { ...s, id: `${s.id}-b`, s: cut },
          ];
        }),
      };
      for (let m = 0; m <= HORIZON; m += 1) {
        const whole = computeExpectedState(toInput(model, m));
        const pieces = computeExpectedState(toInput(split, m));
        const strip = (r: ExpectedState) => ({
          state: r.state,
          effectiveRestriction: r.effectiveRestriction,
          restrictionsShouldBeActive: r.restrictionsShouldBeActive,
          activeOverride: r.activeOverride?.id ?? null,
          inProgress: r.activeShift !== null,
          interval: r.workingInterval
            ? [r.workingInterval.startsAt.getTime(), r.workingInterval.endsAt.getTime()]
            : null,
          nextTransitionAt: r.nextTransitionAt?.getTime() ?? null,
        });
        expect(strip(pieces), `${describeModel(seed, model)} @${m}`).toEqual(strip(whole));
      }
    },
  );
});
