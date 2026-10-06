import { describe, expect, it } from "vitest";
import { PERMISSION_STATES } from "../enums";
import {
  DEFAULT_WORK_MODE_OPTIONS,
  computeExpectedState,
  isPermissionApproved,
  nextTransitionAt,
  toExpectedStateJson,
} from "./computeExpectedState";
import type {
  ComputeExpectedStateInput,
  WorkModeBreakSessionLike,
  WorkModeOverrideLike,
  WorkModeShiftLike,
} from "./types";

const at = (hm: string, day = "2026-01-12"): string => `${day}T${hm}:00.000Z`;
const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

const SHIFT_DAY: WorkModeShiftLike = { id: "shift-day", startsAt: at("09:00"), endsAt: at("15:00"), status: "SCHEDULED" };

function brk(id: string, start: string, planned: string, extra: Partial<WorkModeBreakSessionLike> = {}): WorkModeBreakSessionLike {
  return {
    id,
    shiftId: "shift-day",
    startedAt: start,
    plannedEndsAt: planned,
    endedAt: null,
    status: "ACTIVE",
    restrictionBehaviour: "RELAX_ALL",
    relaxedCategories: [],
    ...extra,
  };
}

function ov(id: string, type: WorkModeOverrideLike["type"], start: string, end: string, extra: Partial<WorkModeOverrideLike> = {}): WorkModeOverrideLike {
  return { id, type, startsAt: start, expiresAt: end, revokedAt: null, employeeId: "emp-1", payload: {}, ...extra };
}

function input(now: string, extra: Partial<ComputeExpectedStateInput> = {}): ComputeExpectedStateInput {
  return { now, shifts: [SHIFT_DAY], breakSessions: [], overrides: [], permissionState: "APPROVED", ...extra };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !(value instanceof Date)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

describe("computeExpectedState — inputs", () => {
  it("defaults to a 15-minute pre-shift and 5-minute shift-ending window", () => {
    expect(DEFAULT_WORK_MODE_OPTIONS).toEqual({ preShiftWarningMinutes: 15, shiftEndingWarningMinutes: 5 });
    expect(computeExpectedState(input(at("08:45"))).state).toBe("SHIFT_STARTING_SOON");
    expect(computeExpectedState(input(at("14:55"))).state).toBe("SHIFT_ENDING");
  });

  it("treats breakSessions, overrides and timezone as optional", () => {
    const result = computeExpectedState({ now: at("11:00"), shifts: [SHIFT_DAY], permissionState: "APPROVED" });
    expect(result.state).toBe("WORKING");
    expect(result.timezone).toBeNull();
  });

  it("echoes timezone and permission and never converts instants with it", () => {
    const london = computeExpectedState(input(at("11:00"), { timezone: "Europe/London" }));
    const tokyo = computeExpectedState(input(at("11:00"), { timezone: "Asia/Tokyo" }));
    expect(london.timezone).toBe("Europe/London");
    expect({ ...toExpectedStateJson(tokyo), timezone: "Europe/London" }).toEqual(toExpectedStateJson(london));
  });

  it("accepts instants with explicit non-UTC offsets", () => {
    const result = computeExpectedState(input("2026-01-12T12:00:00+01:00"));
    expect(result.computedAt.toISOString()).toBe(at("11:00"));
    expect(result.state).toBe("WORKING");
  });

  it("rejects naive, empty and invalid instants with a TypeError", () => {
    expect(() => computeExpectedState(input("2026-01-12T11:00:00"))).toThrow(TypeError);
    expect(() => computeExpectedState(input(""))).toThrow(TypeError);
    expect(() => computeExpectedState(input("2026-13-45T99:00:00Z"))).toThrow(TypeError);
    expect(() => computeExpectedState(input(at("11:00"), { breakSessions: [brk("b", "yesterday", at("10:30"))] }))).toThrow(
      /breakSession b\.startedAt/,
    );
  });

  it("rejects unknown enum values with a TypeError whatever now is", () => {
    // Neither row is consulted at 07:00 (off shift); validation is still eager so the failure is deterministic.
    const badBreak = brk("b", at("10:15"), at("10:30"), {
      restrictionBehaviour: "LOL" as unknown as WorkModeBreakSessionLike["restrictionBehaviour"],
    });
    expect(() => computeExpectedState(input(at("07:00"), { breakSessions: [badBreak] }))).toThrow(/breakSession b\.restrictionBehaviour/);
    const badOverride = ov("o", "NOPE" as unknown as WorkModeOverrideLike["type"], at("10:00"), at("11:00"));
    expect(() => computeExpectedState(input(at("07:00"), { overrides: [badOverride] }))).toThrow(TypeError);
    const badShift = { ...SHIFT_DAY, status: "PAUSED" as unknown as WorkModeShiftLike["status"] };
    expect(() => computeExpectedState(input(at("07:00"), { shifts: [badShift] }))).toThrow(TypeError);
    const badStatus = brk("b", at("10:15"), at("10:30"), { status: "DONE" as unknown as WorkModeBreakSessionLike["status"] });
    expect(() => computeExpectedState(input(at("07:00"), { breakSessions: [badStatus] }))).toThrow(TypeError);
    expect(() =>
      computeExpectedState(input(at("07:00"), { permissionState: "MAYBE" as unknown as ComputeExpectedStateInput["permissionState"] })),
    ).toThrow(TypeError);
  });

  it("rejects negative or non-finite options with a RangeError", () => {
    expect(() => computeExpectedState(input(at("11:00"), { options: { preShiftWarningMinutes: -1 } }))).toThrow(RangeError);
    expect(() =>
      computeExpectedState(input(at("11:00"), { options: { shiftEndingWarningMinutes: Number.POSITIVE_INFINITY } })),
    ).toThrow(RangeError);
  });

  it("is pure: does not mutate (frozen) input and is deterministic", () => {
    const frozen = deepFreeze(
      input(at("10:20"), {
        breakSessions: [brk("break-1", at("10:15"), at("10:30"))],
        overrides: [ov("ov-temp", "TEMPORARY_EXCEPTION", at("10:00"), at("12:00"))],
      }),
    );
    const a = computeExpectedState(frozen);
    const b = computeExpectedState(frozen);
    expect(toExpectedStateJson(a)).toEqual(toExpectedStateJson(b));
    expect(a).not.toBe(b);
  });

  it("nextTransitionAt(input) matches computeExpectedState(input).nextTransitionAt", () => {
    for (const now of [at("07:00"), at("08:50"), at("11:00"), at("14:57"), at("16:00")]) {
      expect(iso(nextTransitionAt(input(now)))).toBe(iso(computeExpectedState(input(now)).nextTransitionAt));
    }
  });
});

describe("computeExpectedState — windows", () => {
  it("with preShiftWarningMinutes 0 goes straight from OFF_SHIFT to WORKING", () => {
    const options = { preShiftWarningMinutes: 0 };
    const before = computeExpectedState(input("2026-01-12T08:59:59.999Z", { options }));
    expect(before.state).toBe("OFF_SHIFT");
    expect(iso(before.nextTransitionAt)).toBe(at("09:00"));
  });

  it("the permission 'imminent' window follows preShiftWarningMinutes", () => {
    const options = { preShiftWarningMinutes: 30 };
    expect(computeExpectedState(input(at("08:35"), { options, permissionState: "DENIED" })).state).toBe("PERMISSION_ERROR");
    expect(computeExpectedState(input(at("08:29"), { options, permissionState: "DENIED" })).state).toBe("OFF_SHIFT");
  });

  it("a shift shorter than the ending window is SHIFT_ENDING throughout", () => {
    const short: WorkModeShiftLike = { id: "short", startsAt: at("09:00"), endsAt: at("09:03"), status: "SCHEDULED" };
    const result = computeExpectedState(input(at("09:00"), { shifts: [short] }));
    expect(result.state).toBe("SHIFT_ENDING");
    expect(iso(result.nextTransitionAt)).toBe(at("09:03"));
  });

  it("reports the working interval and the upcoming shift", () => {
    const shifts: WorkModeShiftLike[] = [
      { id: "am", startsAt: at("09:00"), endsAt: at("13:00"), status: "SCHEDULED" },
      { id: "pm", startsAt: at("13:00"), endsAt: at("17:00"), status: "SCHEDULED" },
      { id: "tomorrow", startsAt: at("09:00", "2026-01-13"), endsAt: at("17:00", "2026-01-13"), status: "SCHEDULED" },
    ];
    const result = toExpectedStateJson(computeExpectedState(input(at("13:30"), { shifts })));
    expect(result.workingInterval).toEqual({
      startsAt: at("09:00"),
      endsAt: at("17:00"),
      shiftIds: ["am", "pm"],
      shifts: [
        { id: "am", startsAt: at("09:00"), endsAt: at("13:00") },
        { id: "pm", startsAt: at("13:00"), endsAt: at("17:00") },
      ],
    });
    expect(result.activeShift?.id).toBe("pm");
    expect(result.upcomingShift?.id).toBe("tomorrow");
  });
});

describe("computeExpectedState — permission", () => {
  it("only APPROVED counts as approved", () => {
    expect(PERMISSION_STATES.filter(isPermissionApproved)).toEqual(["APPROVED"]);
  });

  it("every non-approved permission yields PERMISSION_ERROR during a shift", () => {
    for (const permissionState of PERMISSION_STATES.filter((p) => p !== "APPROVED")) {
      expect(computeExpectedState(input(at("11:00"), { permissionState })).state).toBe("PERMISSION_ERROR");
    }
  });
});

describe("computeExpectedState — breaks", () => {
  it("a break that has not started yet (device clock ahead) is not active; its start is the next change", () => {
    const result = computeExpectedState(input(at("10:10"), { breakSessions: [brk("b", at("10:15"), at("10:30"))] }));
    expect(result.state).toBe("WORKING");
    expect(iso(result.nextTransitionAt)).toBe(at("10:15"));
  });

  it("an ACTIVE row with endedAt set ends at endedAt", () => {
    const rows = { breakSessions: [brk("b", at("10:15"), at("10:30"), { endedAt: at("10:20") })] };
    expect(computeExpectedState(input(at("10:19"), rows)).activeBreak?.endsAt.toISOString()).toBe(at("10:20"));
    expect(computeExpectedState(input(at("10:20"), rows)).state).toBe("WORKING");
  });

  it("reports the effective end clamped to the interval end", () => {
    const result = computeExpectedState(input(at("14:55"), { breakSessions: [brk("b", at("14:50"), at("15:10"))] }));
    expect(toExpectedStateJson(result).activeBreak).toEqual({
      id: "b",
      shiftId: "shift-day",
      startedAt: at("14:50"),
      plannedEndsAt: at("15:10"),
      endsAt: at("15:00"),
    });
  });

  it("with two overlapping sessions (bad data) the most recently started wins", () => {
    const result = computeExpectedState(
      input(at("10:20"), { breakSessions: [brk("older", at("10:10"), at("10:40")), brk("newer", at("10:15"), at("10:30"))] }),
    );
    expect(result.activeBreak?.id).toBe("newer");
  });

  it("relaxation mirrors the break snapshot", () => {
    const result = computeExpectedState(
      input(at("10:20"), {
        breakSessions: [brk("b", at("10:15"), at("10:30"), { restrictionBehaviour: "RELAX_CATEGORIES", relaxedCategories: ["DATING", "GAMES"] })],
      }),
    );
    expect(result.relaxation).toEqual({
      source: "BREAK",
      restrictionBehaviour: "RELAX_CATEGORIES",
      relaxedCategories: ["GAMES", "DATING"],
      liftedCategories: ["GAMES", "DATING"],
    });
    expect(result.restrictionsShouldBeActive).toBe(true);
  });

  it("RELAX_CATEGORIES lifting every category leaves nothing enforced", () => {
    const all = ["SOCIAL_MEDIA", "GAMES", "ENTERTAINMENT", "STREAMING", "VIDEO", "SHOPPING", "DATING", "OTHER_SELECTED"];
    const result = computeExpectedState(
      input(at("10:20"), {
        breakSessions: [brk("b", at("10:15"), at("10:30"), { restrictionBehaviour: "RELAX_CATEGORIES", relaxedCategories: all })],
      }),
    );
    expect(result.effectiveRestriction).toBe("BREAK_RELAXED");
    expect(result.restrictionsShouldBeActive).toBe(false);
  });

  it("a running break beats a TEMPORARY_EXCEPTION", () => {
    const result = computeExpectedState(
      input(at("10:20"), {
        breakSessions: [brk("b", at("10:15"), at("10:30"), { restrictionBehaviour: "KEEP_RESTRICTIONS" })],
        overrides: [ov("ov-temp", "TEMPORARY_EXCEPTION", at("10:00"), at("11:00"))],
      }),
    );
    expect(result.state).toBe("ON_BREAK");
    expect(result.effectiveRestriction).toBe("WORK");
    expect(result.activeOverride).toBeNull();
    expect(iso(result.nextTransitionAt)).toBe(at("10:30"));
  });
});

describe("computeExpectedState — overrides", () => {
  it("without employeeId every supplied override applies", () => {
    const result = computeExpectedState(
      input(at("11:00"), { overrides: [ov("ov-other", "EXEMPT_TEMPORARILY", at("10:00"), at("12:00"), { employeeId: "emp-2" })] }),
    );
    expect(result.state).toBe("MANAGER_OVERRIDE");
  });

  it("with employeeId an org-wide override still applies", () => {
    const result = computeExpectedState(
      input(at("11:00"), {
        employeeId: "emp-1",
        overrides: [ov("ov-org", "EXEMPT_TEMPORARILY", at("10:00"), at("12:00"), { employeeId: null })],
      }),
    );
    expect(result.activeOverride?.id).toBe("ov-org");
  });

  it("EMERGENCY_POLICY_OVERRIDE outranks END_WORK_MODE_EARLY and EXEMPT_TEMPORARILY", () => {
    const result = computeExpectedState(
      input(at("11:00"), {
        overrides: [
          ov("ov-exempt", "EXEMPT_TEMPORARILY", at("10:00"), at("12:00")),
          ov("ov-emergency", "EMERGENCY_POLICY_OVERRIDE", at("10:30"), at("11:30"), { employeeId: null }),
          ov("ov-end", "END_WORK_MODE_EARLY", at("10:45"), at("15:00")),
        ],
      }),
    );
    expect(result.activeOverride?.id).toBe("ov-emergency");
    expect(result.activeOverride?.type).toBe("EMERGENCY_POLICY_OVERRIDE");
  });

  it("an override is active on [startsAt, min(expiresAt, revokedAt))", () => {
    const rows = { overrides: [ov("o", "EXEMPT_TEMPORARILY", at("10:00"), at("12:00"), { revokedAt: at("11:00") })] };
    expect(computeExpectedState(input(at("10:00"), rows)).state).toBe("MANAGER_OVERRIDE");
    expect(computeExpectedState(input("2026-01-12T10:59:59.999Z", rows)).state).toBe("MANAGER_OVERRIDE");
    expect(computeExpectedState(input(at("11:00"), rows)).state).toBe("WORKING");
  });

  it("an invalid TEMPORARY_EXCEPTION payload behaviour falls back to RELAX_ALL", () => {
    const result = computeExpectedState(
      input(at("11:00"), {
        overrides: [ov("ov-temp", "TEMPORARY_EXCEPTION", at("10:00"), at("12:00"), { payload: { restrictionBehaviour: "LOL", breakPolicyId: "x" } })],
      }),
    );
    expect(result.relaxation?.restrictionBehaviour).toBe("RELAX_ALL");
    expect(result.relaxation?.source).toBe("OVERRIDE");
  });

  it("a TEMPORARY_EXCEPTION that relaxes nothing does not mask another one that does", () => {
    const result = computeExpectedState(
      input(at("11:10"), {
        overrides: [
          ov("ov-keep", "TEMPORARY_EXCEPTION", at("10:00"), at("12:00"), { payload: { restrictionBehaviour: "KEEP_RESTRICTIONS" } }),
          ov("ov-empty", "TEMPORARY_EXCEPTION", at("10:30"), at("12:00"), {
            payload: { restrictionBehaviour: "RELAX_CATEGORIES", relaxedCategories: [] },
          }),
          ov("ov-games", "TEMPORARY_EXCEPTION", at("11:00"), at("11:30"), {
            payload: { restrictionBehaviour: "RELAX_CATEGORIES", relaxedCategories: ["GAMES"] },
          }),
        ],
      }),
    );
    expect(result.state).toBe("WORKING");
    expect(result.effectiveRestriction).toBe("BREAK_RELAXED");
    expect(result.activeOverride?.id).toBe("ov-games");
    expect(result.relaxation?.liftedCategories).toEqual(["GAMES"]);
    expect(iso(result.nextTransitionAt)).toBe(at("11:30"));
  });

  it("among relaxing TEMPORARY_EXCEPTIONs the earliest-starting one applies", () => {
    const result = computeExpectedState(
      input(at("11:10"), {
        overrides: [
          ov("ov-later", "TEMPORARY_EXCEPTION", at("11:00"), at("11:30"), { payload: { restrictionBehaviour: "RELAX_ALL" } }),
          ov("ov-earlier", "TEMPORARY_EXCEPTION", at("10:00"), at("12:00"), {
            payload: { restrictionBehaviour: "RELAX_CATEGORIES", relaxedCategories: ["VIDEO"] },
          }),
        ],
      }),
    );
    expect(result.activeOverride?.id).toBe("ov-earlier");
    expect(result.relaxation?.liftedCategories).toEqual(["VIDEO"]);
    // The later exception's expiry changes nothing; the earlier one's does.
    expect(iso(result.nextTransitionAt)).toBe(at("12:00"));
  });

  it("a null payload is tolerated", () => {
    const result = computeExpectedState(
      input(at("11:00"), { overrides: [ov("ov-temp", "TEMPORARY_EXCEPTION", at("10:00"), at("12:00"), { payload: null })] }),
    );
    expect(result.effectiveRestriction).toBe("BREAK_RELAXED");
  });
});

describe("computeExpectedState — scale", () => {
  it("handles a year of daily shifts quickly", () => {
    const shifts: WorkModeShiftLike[] = [];
    for (let d = 0; d < 365; d += 1) {
      const start = Date.UTC(2026, 0, 1, 9) + d * 86_400_000;
      shifts.push({ id: `s${d}`, startsAt: new Date(start), endsAt: new Date(start + 8 * 3_600_000), status: "SCHEDULED" });
    }
    const started = performance.now();
    const result = computeExpectedState(input("2026-06-01T20:00:00.000Z", { shifts }));
    expect(performance.now() - started).toBeLessThan(500);
    expect(iso(result.nextTransitionAt)).toBe("2026-06-02T08:45:00.000Z");
  });
});
