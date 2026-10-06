import { readFileSync } from "node:fs";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  BREAK_RESTRICTION_BEHAVIOURS,
  BREAK_SESSION_STATUSES,
  EFFECTIVE_RESTRICTIONS,
  OVERRIDE_TYPES,
  PERMISSION_STATES,
  RESTRICTION_CATEGORIES,
  SHIFT_STATUSES,
  WORK_MODE_STATES,
} from "../enums";
import type { EffectiveRestriction, RestrictionCategory, WorkModeState } from "../enums";
import {
  computeExpectedState,
  restrictionSignature,
  toExpectedStateJson,
} from "./computeExpectedState";
import type {
  ComputeExpectedStateInput,
  WorkModeBreakSessionLike,
  WorkModeOverrideLike,
  WorkModeShiftLike,
} from "./types";

/**
 * Runs every case of docs/fixtures/workmode-cases.json — the contract shared with the iOS engine's XCTest
 * suite. The file is validated structurally first so a malformed edit fails loudly instead of silently
 * skipping assertions.
 */

const FIXTURE_URL = new URL("../../../../docs/fixtures/workmode-cases.json", import.meta.url);
/**
 * Canonical wire form only: UTC, millisecond precision (`2026-01-12T09:00:00.000Z`) — what `toISOString()` and
 * the Swift `WorkModeDateCoding.format` both produce, so expected instants can be compared as strings.
 */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Keys whose values are instants anywhere in the file (input rows, expectations, wall-clock annotations). */
const INSTANT_KEY = /(At|^now|^utc)$/;

interface FixtureExpected {
  state: WorkModeState;
  effectiveRestriction: EffectiveRestriction;
  restrictionsShouldBeActive: boolean;
  activeShiftId: string | null;
  activeBreakId: string | null;
  nextTransitionAt: string | null;
  /** Optional keys: asserted only when present (null included). */
  upcomingShiftId?: string | null;
  activeOverrideId?: string | null;
  liftedCategories?: RestrictionCategory[];
}

interface FixtureCase {
  name: string;
  description: string;
  input: ComputeExpectedStateInput & { now: string };
  expected: FixtureExpected;
  wallClock?: { utc: string; local: string }[];
}

// ─── structural validation (the JSON is untrusted until checked) ───────────────────────────────────────────

type Obj = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new Error(`workmode-cases.json ${path}: ${message}`);
}
function obj(value: unknown, path: string): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(path, "expected an object");
  return value as Obj;
}
function arr(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  return value;
}
function str(value: unknown, path: string): string {
  if (typeof value !== "string" || value === "") fail(path, "expected a non-empty string");
  return value;
}
function nullableStr(value: unknown, path: string): string | null {
  return value === null ? null : str(value, path);
}
function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "expected a boolean");
  return value;
}
function instant(value: unknown, path: string): string {
  const s = str(value, path);
  if (!ISO_UTC.test(s) || Number.isNaN(Date.parse(s)))
    fail(path, `expected an ISO-8601 UTC instant, got "${s}"`);
  return s;
}
function nullableInstant(value: unknown, path: string): string | null {
  return value === null ? null : instant(value, path);
}
function oneOf<T extends string>(values: readonly T[], value: unknown, path: string): T {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    fail(path, `expected one of ${values.join(", ")}, got ${JSON.stringify(value)}`);
  }
  return value as T;
}
function categories(value: unknown, path: string): RestrictionCategory[] {
  return arr(value, path).map((c, i) => oneOf(RESTRICTION_CATEGORIES, c, `${path}[${i}]`));
}

function parseShift(raw: unknown, path: string): WorkModeShiftLike {
  const o = obj(raw, path);
  return {
    id: str(o.id, `${path}.id`),
    startsAt: instant(o.startsAt, `${path}.startsAt`),
    endsAt: instant(o.endsAt, `${path}.endsAt`),
    status: oneOf(SHIFT_STATUSES, o.status, `${path}.status`),
    version: typeof o.version === "number" ? o.version : null,
    deletedAt: nullableInstant(o.deletedAt ?? null, `${path}.deletedAt`),
  };
}

function parseBreak(raw: unknown, path: string): WorkModeBreakSessionLike {
  const o = obj(raw, path);
  // relaxedCategories is stored JSON and may legitimately contain junk the machine must drop: keep it raw.
  arr(o.relaxedCategories, `${path}.relaxedCategories`);
  return {
    id: str(o.id, `${path}.id`),
    shiftId: str(o.shiftId, `${path}.shiftId`),
    startedAt: instant(o.startedAt, `${path}.startedAt`),
    plannedEndsAt: instant(o.plannedEndsAt, `${path}.plannedEndsAt`),
    endedAt: nullableInstant(o.endedAt ?? null, `${path}.endedAt`),
    status: oneOf(BREAK_SESSION_STATUSES, o.status, `${path}.status`),
    restrictionBehaviour: oneOf(
      BREAK_RESTRICTION_BEHAVIOURS,
      o.restrictionBehaviour,
      `${path}.restrictionBehaviour`,
    ),
    relaxedCategories: o.relaxedCategories,
  };
}

function parseOverride(raw: unknown, path: string): WorkModeOverrideLike {
  const o = obj(raw, path);
  obj(o.payload, `${path}.payload`);
  return {
    id: str(o.id, `${path}.id`),
    type: oneOf(OVERRIDE_TYPES, o.type, `${path}.type`),
    startsAt: instant(o.startsAt, `${path}.startsAt`),
    expiresAt: instant(o.expiresAt, `${path}.expiresAt`),
    revokedAt: nullableInstant(o.revokedAt ?? null, `${path}.revokedAt`),
    employeeId: nullableStr(o.employeeId ?? null, `${path}.employeeId`),
    payload: o.payload,
  };
}

function parseCase(raw: unknown, index: number): FixtureCase {
  const path = `[${index}]`;
  const c = obj(raw, path);
  const input = obj(c.input, `${path}.input`);
  const expected = obj(c.expected, `${path}.expected`);

  let options: ComputeExpectedStateInput["options"];
  if (input.options !== undefined) {
    const o = obj(input.options, `${path}.input.options`);
    options = {
      preShiftWarningMinutes: o.preShiftWarningMinutes as number | undefined,
      shiftEndingWarningMinutes: o.shiftEndingWarningMinutes as number | undefined,
    };
  }

  const parsedExpected: FixtureExpected = {
    state: oneOf(WORK_MODE_STATES, expected.state, `${path}.expected.state`),
    effectiveRestriction: oneOf(
      EFFECTIVE_RESTRICTIONS,
      expected.effectiveRestriction,
      `${path}.expected.effectiveRestriction`,
    ),
    restrictionsShouldBeActive: bool(
      expected.restrictionsShouldBeActive,
      `${path}.expected.restrictionsShouldBeActive`,
    ),
    activeShiftId: nullableStr(expected.activeShiftId, `${path}.expected.activeShiftId`),
    activeBreakId: nullableStr(expected.activeBreakId, `${path}.expected.activeBreakId`),
    nextTransitionAt: nullableInstant(
      expected.nextTransitionAt,
      `${path}.expected.nextTransitionAt`,
    ),
  };
  if ("upcomingShiftId" in expected) {
    parsedExpected.upcomingShiftId = nullableStr(
      expected.upcomingShiftId,
      `${path}.expected.upcomingShiftId`,
    );
  }
  if ("activeOverrideId" in expected) {
    parsedExpected.activeOverrideId = nullableStr(
      expected.activeOverrideId,
      `${path}.expected.activeOverrideId`,
    );
  }
  if ("liftedCategories" in expected) {
    parsedExpected.liftedCategories = categories(
      expected.liftedCategories,
      `${path}.expected.liftedCategories`,
    );
  }

  const parsed: FixtureCase = {
    name: str(c.name, `${path}.name`),
    description: str(c.description, `${path}.description`),
    input: {
      now: instant(input.now, `${path}.input.now`),
      timezone: str(input.timezone, `${path}.input.timezone`),
      permissionState: oneOf(
        PERMISSION_STATES,
        input.permissionState,
        `${path}.input.permissionState`,
      ),
      employeeId: nullableStr(input.employeeId ?? null, `${path}.input.employeeId`),
      shifts: arr(input.shifts, `${path}.input.shifts`).map((s, i) =>
        parseShift(s, `${path}.input.shifts[${i}]`),
      ),
      breakSessions: arr(input.breakSessions, `${path}.input.breakSessions`).map((b, i) =>
        parseBreak(b, `${path}.input.breakSessions[${i}]`),
      ),
      overrides: arr(input.overrides, `${path}.input.overrides`).map((o, i) =>
        parseOverride(o, `${path}.input.overrides[${i}]`),
      ),
      options,
    },
    expected: parsedExpected,
  };
  if (c.wallClock !== undefined) {
    parsed.wallClock = arr(c.wallClock, `${path}.wallClock`).map((w, i) => {
      const o = obj(w, `${path}.wallClock[${i}]`);
      return {
        utc: instant(o.utc, `${path}.wallClock[${i}].utc`),
        local: str(o.local, `${path}.wallClock[${i}].local`),
      };
    });
  }
  return parsed;
}

const RAW_TEXT = readFileSync(FIXTURE_URL, "utf8");
const RAW: unknown = JSON.parse(RAW_TEXT);

function loadCases(): FixtureCase[] {
  return arr(RAW, "root").map(parseCase);
}

const CASES = loadCases();

/** Every string under an instant-named key, and every date-looking string anywhere, with its JSON path. */
function instantLikeStrings(
  value: unknown,
  path: string,
  key: string,
  out: { path: string; key: string; value: unknown }[],
): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => instantLikeStrings(v, `${path}[${i}]`, key, out));
  } else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) instantLikeStrings(v, `${path}.${k}`, k, out);
  } else if (
    INSTANT_KEY.test(key) ||
    (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value))
  ) {
    out.push({ path, key, value });
  }
}

/** Every instant field of the input as a `Date` instead of a string. */
function withDates(input: FixtureCase["input"]): ComputeExpectedStateInput {
  const d = (v: Date | string): Date => new Date(v);
  const dn = (v: Date | string | null | undefined): Date | null => (v == null ? null : new Date(v));
  return {
    ...input,
    now: d(input.now),
    shifts: input.shifts.map((s) => ({
      ...s,
      startsAt: d(s.startsAt),
      endsAt: d(s.endsAt),
      deletedAt: dn(s.deletedAt),
    })),
    breakSessions: (input.breakSessions ?? []).map((b) => ({
      ...b,
      startedAt: d(b.startedAt),
      plannedEndsAt: d(b.plannedEndsAt),
      endedAt: dn(b.endedAt),
    })),
    overrides: (input.overrides ?? []).map((o) => ({
      ...o,
      startsAt: d(o.startsAt),
      expiresAt: d(o.expiresAt),
      revokedAt: dn(o.revokedAt),
    })),
  };
}

// ─── tests ────────────────────────────────────────────────────────────────────────────────────────────────

describe("docs/fixtures/workmode-cases.json", () => {
  it("is a well-formed list of at least 25 uniquely named cases", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(25);
    const names = CASES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("is plain JSON with every instant as a canonical ISO-8601 UTC string (no Date objects, no naive times)", () => {
    expect(RAW_TEXT.endsWith("\n")).toBe(true);
    const found: { path: string; key: string; value: unknown }[] = [];
    instantLikeStrings(RAW, "root", "", found);
    const bad = found.filter(({ key, value }) =>
      key === "local"
        ? typeof value !== "string"
        : !(
            value === null ||
            (typeof value === "string" && ISO_UTC.test(value) && !Number.isNaN(Date.parse(value)))
          ),
    );
    expect(bad).toEqual([]);
    // Sanity: the scan really saw the instants.
    expect(found.length).toBeGreaterThan(CASES.length * 3);
  });

  /**
   * Each §6.2 rule (and each boundary) is pinned by at least one named case, so the Swift port inherits the
   * same coverage. Keyed by rule for readability; a missing name fails with the rule it belonged to.
   */
  it("pins every §6.2 rule with at least one named case", () => {
    const names = new Set(CASES.map((c) => c.name));
    const rules: Record<string, string[]> = {
      "SHIFT_STARTING_SOON on [start − preShiftWarningMinutes, start)": [
        "canonical-0844-off-shift",
        "canonical-0845-starting-soon",
        "canonical-0859-starting-soon",
        "canonical-0859-59-999-starting-soon-last-ms",
        "custom-warning-minutes-starting-soon",
        "custom-warning-minutes-before-window",
        "pre-shift-warning-zero-straight-to-working",
      ],
      "WORKING on [start, end) with no active break": [
        "canonical-0900-working",
        "overnight-0200-working",
      ],
      "ON_BREAK while an ACTIVE break has plannedEndsAt > now": [
        "canonical-1015-on-break",
        "canonical-1029-59-999-on-break-last-ms",
        "break-keep-restrictions",
        "break-relax-categories",
        "break-relax-categories-empty-list",
        "break-relax-categories-every-category",
      ],
      "plannedEndsAt ≤ now → EXPIRED → WORKING": [
        "canonical-1030-break-expired",
        "break-expires-inside-shift-ending-window",
        "break-ended-late-capped-at-planned-end",
      ],
      "break ended early / closed rows": [
        "break-ended-early-by-employee",
        "break-ended-row-evaluated-before-its-end",
        "break-active-row-with-endedat",
        "break-ended-without-endedat-ignored",
        "break-of-unknown-shift-ignored",
        "break-of-cancelled-shift-ignored",
      ],
      "SHIFT_ENDING on [end − 5 min, end)": [
        "canonical-1455-shift-ending",
        "canonical-1456-shift-ending",
        "canonical-1459-59-999-shift-ending-last-ms",
        "canonical-1500-off-shift",
        "custom-warning-minutes-shift-ending",
        "short-shift-shift-ending-throughout",
      ],
      "shift end always terminates an active break": [
        "break-crosses-shift-end-during",
        "break-crosses-shift-end-after",
        "b2b-break-ends-at-own-shift-end",
        "b2b-break-across-boundary",
        "overlap-break-ends-at-own-shift-end",
      ],
      "overlapping / adjacent shifts: union, no flapping": [
        "b2b-1256-no-shift-ending",
        "b2b-1259-shifts-out-of-order",
        "b2b-1300",
        "b2b-1301",
        "b2b-1655-shift-ending",
        "overlapping-shifts-union",
        "overlapping-shift-contained",
        "gap-between-shifts-starting-soon",
        "gap-between-shifts-shift-ending",
      ],
      "EXEMPT_TEMPORARILY / END_WORK_MODE_EARLY → MANAGER_OVERRIDE, restrictions NONE": [
        "exempt-temporarily-during-shift",
        "exempt-temporarily-before-shift",
        "end-work-mode-early",
        "emergency-policy-override-org-wide",
        "emergency-outranks-other-lifting-overrides",
        "end-work-mode-early-outranks-exempt",
        "override-starts-exactly-now",
        "override-expires-exactly-now",
        "override-revoked-exactly-now",
        "expired-override-ignored",
        "revoked-override-ignored",
        "override-for-other-employee-ignored",
        "override-applies-when-employee-id-omitted",
        "override-off-shift-ignored",
      ],
      "TEMPORARY_EXCEPTION relaxes without changing the state": [
        "temporary-exception-relax-categories",
        "temporary-exception-default-relax-all",
        "temporary-exception-during-shift-ending",
        "temporary-exception-keep-restrictions-no-effect",
        "temporary-exception-no-op-does-not-mask-another",
        "temporary-exception-ignored-before-shift",
        "temporary-exception-applies-at-shift-start",
        "lifting-override-beats-temporary-exception",
        "break-beats-temporary-exception",
        "temporary-exception-resumes-after-break",
      ],
      "PERMISSION_ERROR when not APPROVED and a shift is active / imminent": [
        "permission-denied-during-shift",
        "permission-denied-at-pre-shift-window-start",
        "permission-not-determined-10-min-before-shift",
        "permission-unknown-during-shift",
        "permission-revoked-during-break",
        "permission-denied-off-shift",
        "permission-unknown-just-outside-window",
        "permission-denied-at-shift-end",
      ],
      "precedence PERMISSION_ERROR > MANAGER_OVERRIDE > ON_BREAK > SHIFT_ENDING > WORKING > SHIFT_STARTING_SOON > OFF_SHIFT":
        [
          "precedence-permission-over-override-break-and-shift-ending",
          "permission-denied-dominates-override",
          "permission-denied-dominates-shift-ending",
          "precedence-override-over-break-and-shift-ending",
          "exempt-temporarily-precedes-break",
          "exempt-temporarily-ends-while-break-runs",
          "end-work-mode-early-in-shift-ending-window",
          "break-crosses-shift-end-during",
          "precedence-working-over-next-shift-starting-soon",
        ],
      "cancelled / completed / deleted / degenerate shifts are ignored": [
        "cancelled-shift-ignored",
        "completed-shift-ignored",
        "soft-deleted-shift-ignored",
        "cancelled-shift-does-not-merge",
        "soft-deleted-shift-does-not-merge",
        "zero-length-shift-ignored",
        "no-shifts",
      ],
      "UTC instants; timezone only at the edges (overnight, DST)": [
        "overnight-2150-starting-soon",
        "overnight-0557-shift-ending",
        "dst-spring-forward-starting-soon",
        "dst-spring-forward-0230-local",
        "dst-spring-forward-shift-ending",
        "dst-fall-back-first-0130",
        "dst-fall-back-second-0130",
        "dst-fall-back-shift-ending",
      ],
    };
    const missing = Object.entries(rules).flatMap(([rule, required]) =>
      required.filter((n) => !names.has(n)).map((n) => `${rule}: ${n}`),
    );
    expect(missing).toEqual([]);
  });

  it("produces every machine state at least once", () => {
    const produced = new Set(CASES.map((c) => c.expected.state));
    expect(
      WORK_MODE_STATES.filter((s) => s !== "SYNC_ERROR" && s !== "UNKNOWN" && !produced.has(s)),
    ).toEqual([]);
  });

  it("uses only producible states (SYNC_ERROR / UNKNOWN are device-side)", () => {
    for (const c of CASES) expect(["SYNC_ERROR", "UNKNOWN"]).not.toContain(c.expected.state);
  });

  it.each(CASES.filter((c) => c.wallClock !== undefined).map((c) => [c.name, c] as const))(
    "%s: wall-clock annotations match the case timezone",
    (_name, c) => {
      for (const w of c.wallClock ?? []) {
        const local = DateTime.fromISO(w.utc, { zone: "utc" }).setZone(c.input.timezone ?? "UTC");
        expect(local.toFormat("yyyy-MM-dd'T'HH:mm"), w.utc).toBe(w.local);
      }
    },
  );
});

describe.each(CASES.map((c) => [c.name, c] as const))("fixture %s", (_name, c) => {
  const result = computeExpectedState(c.input);

  it("matches the expected state", () => {
    const actual: FixtureExpected = {
      state: result.state,
      effectiveRestriction: result.effectiveRestriction,
      restrictionsShouldBeActive: result.restrictionsShouldBeActive,
      activeShiftId: result.activeShift?.id ?? null,
      activeBreakId: result.activeBreak?.id ?? null,
      nextTransitionAt: result.nextTransitionAt?.toISOString() ?? null,
    };
    if ("upcomingShiftId" in c.expected) actual.upcomingShiftId = result.upcomingShift?.id ?? null;
    if ("activeOverrideId" in c.expected)
      actual.activeOverrideId = result.activeOverride?.id ?? null;
    if ("liftedCategories" in c.expected)
      actual.liftedCategories = result.relaxation?.liftedCategories ?? [];
    expect(actual).toEqual(c.expected);
  });

  it("reports a relaxation exactly when the restriction is BREAK_RELAXED", () => {
    expect(result.relaxation !== null).toBe(result.effectiveRestriction === "BREAK_RELAXED");
  });

  it("gives the same result for Date and ISO-string instants", () => {
    expect(toExpectedStateJson(computeExpectedState(withDates(c.input)))).toEqual(
      toExpectedStateJson(result),
    );
  });

  it("is JSON-serialisable without loss", () => {
    const json = toExpectedStateJson(result);
    expect(JSON.parse(JSON.stringify(result))).toEqual(json);
    expect(json.nextTransitionAt).toBe(c.expected.nextTransitionAt);
  });

  it("nextTransitionAt is the real next change: nothing changes before it, something changes at it", () => {
    const base = restrictionSignature(result);
    const next = result.nextTransitionAt;
    if (next === null) {
      // Nothing ever changes again: probe far into the future.
      const later = computeExpectedState({
        ...c.input,
        now: new Date(Date.parse(c.input.now) + 400 * 86_400_000),
      });
      expect(restrictionSignature(later)).toBe(base);
      return;
    }
    expect(next.getTime()).toBeGreaterThan(Date.parse(c.input.now));
    const justBefore = computeExpectedState({ ...c.input, now: new Date(next.getTime() - 1) });
    expect(restrictionSignature(justBefore)).toBe(base);
    expect(justBefore.nextTransitionAt?.getTime()).toBe(next.getTime());
    const atNext = computeExpectedState({ ...c.input, now: next });
    expect(restrictionSignature(atNext)).not.toBe(base);
  });
});
