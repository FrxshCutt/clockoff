import { describe, expect, it } from "vitest";
import { WORK_MODE_STATES } from "../enums";
import type { PermissionState } from "../enums";
import { computeExpectedState } from "./computeExpectedState";
import { diffStates, isWorkModeActiveState } from "./diffStates";
import type {
  ComputeExpectedStateInput,
  ExpectedState,
  Transition,
  WorkModeBreakSessionLike,
  WorkModeOverrideLike,
  WorkModeShiftLike,
} from "./types";

const at = (hm: string, day = "2026-01-12"): string => `${day}T${hm}:00.000Z`;

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

interface Rows {
  shifts?: WorkModeShiftLike[];
  breakSessions?: WorkModeBreakSessionLike[];
  overrides?: WorkModeOverrideLike[];
  permissionState?: PermissionState;
}

function stateAt(now: string, rows: Rows = {}): ExpectedState {
  const input: ComputeExpectedStateInput = {
    now,
    shifts: rows.shifts ?? [SHIFT_DAY],
    breakSessions: rows.breakSessions ?? [],
    overrides: rows.overrides ?? [],
    permissionState: rows.permissionState ?? "APPROVED",
    timezone: "Europe/London",
    employeeId: "emp-1",
  };
  return computeExpectedState(input);
}

/** Compact view: [eventType | "-", from, to] plus ids. */
function view(transitions: Transition[]): Record<string, string>[] {
  return transitions.map((t) => {
    const row: Record<string, string> = { event: t.eventType ?? "-", from: t.from, to: t.to };
    if (t.shiftId) row.shiftId = t.shiftId;
    if (t.breakSessionId) row.breakSessionId = t.breakSessionId;
    if (t.overrideId) row.overrideId = t.overrideId;
    return row;
  });
}

describe("isWorkModeActiveState", () => {
  it("is true exactly for WORKING, ON_BREAK and SHIFT_ENDING", () => {
    const active = WORK_MODE_STATES.filter(isWorkModeActiveState);
    expect(active).toEqual(["WORKING", "ON_BREAK", "SHIFT_ENDING"]);
  });
});

describe("diffStates with full snapshots", () => {
  const canon: Rows = { breakSessions: [brk("break-1", at("10:15"), at("10:30"))] };

  it("returns [] when nothing changed", () => {
    expect(diffStates(stateAt(at("09:30"), canon), stateAt(at("09:31"), canon))).toEqual([]);
  });

  it("OFF_SHIFT → SHIFT_STARTING_SOON is a transition without an event", () => {
    const next = stateAt(at("08:45"), canon);
    expect(diffStates(stateAt(at("08:44"), canon), next)).toEqual([
      { from: "OFF_SHIFT", to: "SHIFT_STARTING_SOON", at: next.computedAt },
    ]);
  });

  it("emits WORK_MODE_STARTED at the shift start", () => {
    expect(view(diffStates(stateAt(at("08:59"), canon), stateAt(at("09:00"), canon)))).toEqual([
      { event: "WORK_MODE_STARTED", from: "SHIFT_STARTING_SOON", to: "WORKING", shiftId: "shift-day" },
    ]);
  });

  it("emits BREAK_STARTED then BREAK_EXPIRED at the planned end", () => {
    expect(view(diffStates(stateAt(at("10:14"), canon), stateAt(at("10:15"), canon)))).toEqual([
      { event: "BREAK_STARTED", from: "WORKING", to: "ON_BREAK", shiftId: "shift-day", breakSessionId: "break-1" },
    ]);
    expect(view(diffStates(stateAt(at("10:29"), canon), stateAt(at("10:30"), canon)))).toEqual([
      { event: "BREAK_EXPIRED", from: "ON_BREAK", to: "WORKING", shiftId: "shift-day", breakSessionId: "break-1" },
    ]);
  });

  it("emits BREAK_ENDED when the employee ends the break before its planned end", () => {
    const prev = stateAt(at("10:19"), { breakSessions: [brk("break-1", at("10:15"), at("10:30"))] });
    const next = stateAt(at("10:21"), {
      breakSessions: [brk("break-1", at("10:15"), at("10:30"), { status: "ENDED", endedAt: at("10:20") })],
    });
    expect(view(diffStates(prev, next))).toEqual([
      { event: "BREAK_ENDED", from: "ON_BREAK", to: "WORKING", shiftId: "shift-day", breakSessionId: "break-1" },
    ]);
  });

  it("WORKING → SHIFT_ENDING has no event; the shift end emits WORK_MODE_ENDED", () => {
    const ending = stateAt(at("14:55"), canon);
    expect(diffStates(stateAt(at("14:54"), canon), ending)).toEqual([
      { from: "WORKING", to: "SHIFT_ENDING", at: ending.computedAt },
    ]);
    expect(view(diffStates(ending, stateAt(at("15:00"), canon)))).toEqual([
      { event: "WORK_MODE_ENDED", from: "SHIFT_ENDING", to: "OFF_SHIFT", shiftId: "shift-day" },
    ]);
  });

  it("a break cut short by the shift end emits BREAK_ENDED (not EXPIRED) then WORK_MODE_ENDED", () => {
    const rows: Rows = { breakSessions: [brk("break-late", at("14:50"), at("15:10"))] };
    expect(view(diffStates(stateAt(at("14:59"), rows), stateAt(at("15:00"), rows)))).toEqual([
      { event: "BREAK_ENDED", from: "ON_BREAK", to: "OFF_SHIFT", shiftId: "shift-day", breakSessionId: "break-late" },
      { event: "WORK_MODE_ENDED", from: "ON_BREAK", to: "OFF_SHIFT", shiftId: "shift-day" },
    ]);
  });

  it("never flaps between back-to-back shifts", () => {
    const rows: Rows = {
      shifts: [
        { id: "am", startsAt: at("09:00"), endsAt: at("13:00"), status: "SCHEDULED" },
        { id: "pm", startsAt: at("13:00"), endsAt: at("17:00"), status: "SCHEDULED" },
      ],
    };
    expect(diffStates(stateAt(at("12:55"), rows), stateAt(at("12:56"), rows))).toEqual([]);
    expect(diffStates(stateAt(at("12:59"), rows), stateAt(at("13:00"), rows))).toEqual([]);
  });

  it("a lifting override ends Work Mode and its expiry restarts it", () => {
    const rows: Rows = { overrides: [ov("ov-exempt", "EXEMPT_TEMPORARILY", at("10:00"), at("12:00"))] };
    expect(view(diffStates(stateAt(at("09:59"), rows), stateAt(at("10:00"), rows)))).toEqual([
      { event: "WORK_MODE_ENDED", from: "WORKING", to: "MANAGER_OVERRIDE", shiftId: "shift-day", overrideId: "ov-exempt" },
    ]);
    expect(view(diffStates(stateAt(at("11:59"), rows), stateAt(at("12:00"), rows)))).toEqual([
      { event: "OVERRIDE_EXPIRED", from: "MANAGER_OVERRIDE", to: "WORKING", shiftId: "shift-day", overrideId: "ov-exempt" },
      { event: "WORK_MODE_STARTED", from: "MANAGER_OVERRIDE", to: "WORKING", shiftId: "shift-day" },
    ]);
  });

  it("a revoked override restarts Work Mode without OVERRIDE_EXPIRED", () => {
    const active = ov("ov-exempt", "EXEMPT_TEMPORARILY", at("10:00"), at("12:00"));
    const prev = stateAt(at("10:29"), { overrides: [active] });
    const next = stateAt(at("10:31"), { overrides: [{ ...active, revokedAt: at("10:30") }] });
    expect(view(diffStates(prev, next))).toEqual([
      { event: "WORK_MODE_STARTED", from: "MANAGER_OVERRIDE", to: "WORKING", shiftId: "shift-day" },
    ]);
  });

  it("a break keeps running under a lifting override: no BREAK_ENDED on entry, BREAK_EXPIRED inside it", () => {
    const rows: Rows = {
      breakSessions: [brk("break-1", at("10:15"), at("10:30"))],
      overrides: [ov("ov-exempt", "EXEMPT_TEMPORARILY", at("10:20"), at("12:00"))],
    };
    expect(view(diffStates(stateAt(at("10:19"), rows), stateAt(at("10:20"), rows)))).toEqual([
      { event: "WORK_MODE_ENDED", from: "ON_BREAK", to: "MANAGER_OVERRIDE", shiftId: "shift-day", overrideId: "ov-exempt" },
    ]);
    expect(view(diffStates(stateAt(at("10:29"), rows), stateAt(at("10:30"), rows)))).toEqual([
      { event: "BREAK_EXPIRED", from: "MANAGER_OVERRIDE", to: "MANAGER_OVERRIDE", shiftId: "shift-day", breakSessionId: "break-1" },
    ]);
  });

  it("a TEMPORARY_EXCEPTION start is a restriction-only change; its expiry emits OVERRIDE_EXPIRED", () => {
    const rows: Rows = { overrides: [ov("ov-temp", "TEMPORARY_EXCEPTION", at("11:00"), at("11:30"))] };
    const start = stateAt(at("11:00"), rows);
    expect(diffStates(stateAt(at("10:59"), rows), start)).toEqual([{ from: "WORKING", to: "WORKING", at: start.computedAt }]);
    expect(view(diffStates(start, stateAt(at("11:30"), rows)))).toEqual([
      { event: "OVERRIDE_EXPIRED", from: "WORKING", to: "WORKING", shiftId: "shift-day", overrideId: "ov-temp" },
    ]);
  });

  it("losing permission mid-shift emits PERMISSION_NEEDS_ATTENTION then WORK_MODE_ENDED; regaining it restarts", () => {
    const ok = stateAt(at("11:00"));
    const denied = stateAt(at("11:01"), { permissionState: "DENIED" });
    expect(view(diffStates(ok, denied))).toEqual([
      { event: "PERMISSION_NEEDS_ATTENTION", from: "WORKING", to: "PERMISSION_ERROR", shiftId: "shift-day" },
      { event: "WORK_MODE_ENDED", from: "WORKING", to: "PERMISSION_ERROR", shiftId: "shift-day" },
    ]);
    expect(view(diffStates(denied, stateAt(at("11:02"))))).toEqual([
      { event: "WORK_MODE_STARTED", from: "PERMISSION_ERROR", to: "WORKING", shiftId: "shift-day" },
    ]);
  });

  it("an imminent shift without permission emits PERMISSION_NEEDS_ATTENTION for the upcoming shift", () => {
    expect(
      view(diffStates(stateAt(at("08:44"), { permissionState: "NOT_DETERMINED" }), stateAt(at("08:45"), { permissionState: "NOT_DETERMINED" }))),
    ).toEqual([{ event: "PERMISSION_NEEDS_ATTENTION", from: "OFF_SHIFT", to: "PERMISSION_ERROR", shiftId: "shift-day" }]);
  });

  it("moving between two separate working intervals ends one and starts the other", () => {
    const rows: Rows = {
      shifts: [SHIFT_DAY, { id: "shift-tomorrow", startsAt: at("09:00", "2026-01-13"), endsAt: at("15:00", "2026-01-13"), status: "SCHEDULED" }],
    };
    expect(view(diffStates(stateAt(at("11:00"), rows), stateAt(at("11:00", "2026-01-13"), rows)))).toEqual([
      { event: "WORK_MODE_ENDED", from: "WORKING", to: "WORKING", shiftId: "shift-day" },
      { event: "WORK_MODE_STARTED", from: "WORKING", to: "WORKING", shiftId: "shift-tomorrow" },
    ]);
  });

  it("names the shift in progress just before the change, not a stale prev.activeShift (back-to-back shifts)", () => {
    const shifts: WorkModeShiftLike[] = [
      { id: "am", startsAt: at("09:00"), endsAt: at("13:00"), status: "SCHEDULED" },
      { id: "pm", startsAt: at("13:00"), endsAt: at("17:00"), status: "SCHEDULED" },
    ];
    const rows: Rows = { shifts, overrides: [ov("ov-exempt", "EXEMPT_TEMPORARILY", at("12:00"), at("14:00"))] };
    // prev observed at 12:00 (during "am"); the override expires at 14:00, during "pm".
    const prev = stateAt(at("12:00"), rows);
    expect(prev.activeShift?.id).toBe("am");
    expect(view(diffStates(prev, stateAt(at("14:00"), rows)))).toEqual([
      { event: "OVERRIDE_EXPIRED", from: "MANAGER_OVERRIDE", to: "WORKING", shiftId: "pm", overrideId: "ov-exempt" },
      { event: "WORK_MODE_STARTED", from: "MANAGER_OVERRIDE", to: "WORKING", shiftId: "pm" },
    ]);
    // A tick-based diff across the end of the merged interval names "pm", the shift that was in progress.
    expect(view(diffStates(stateAt(at("10:00"), { shifts }), stateAt(at("17:30"), { shifts })))).toEqual([
      { event: "WORK_MODE_ENDED", from: "WORKING", to: "OFF_SHIFT", shiftId: "pm" },
    ]);
  });

  it("two evaluations at the same instant keep prev.activeShift for WORK_MODE_ENDED", () => {
    const prev = stateAt(at("12:30"));
    const next = stateAt(at("12:30"), { permissionState: "REVOKED" });
    expect(view(diffStates(prev, next))).toEqual([
      { event: "PERMISSION_NEEDS_ATTENTION", from: "WORKING", to: "PERMISSION_ERROR", shiftId: "shift-day" },
      { event: "WORK_MODE_ENDED", from: "WORKING", to: "PERMISSION_ERROR", shiftId: "shift-day" },
    ]);
  });

  it("a break expiring exactly at its own shift's end is EXPIRED (same tie rule as breaks/)", () => {
    const rows: Rows = { breakSessions: [brk("break-tie", at("14:45"), at("15:00"))] };
    expect(view(diffStates(stateAt(at("14:59"), rows), stateAt(at("15:00"), rows)))).toEqual([
      { event: "BREAK_EXPIRED", from: "ON_BREAK", to: "OFF_SHIFT", shiftId: "shift-day", breakSessionId: "break-tie" },
      { event: "WORK_MODE_ENDED", from: "ON_BREAK", to: "OFF_SHIFT", shiftId: "shift-day" },
    ]);
  });

  it("back-to-back breaks emit the end of the first before the start of the second", () => {
    const rows: Rows = {
      breakSessions: [brk("break-a", at("10:00"), at("10:15")), brk("break-b", at("10:15"), at("10:30"))],
    };
    expect(view(diffStates(stateAt(at("10:14"), rows), stateAt(at("10:15"), rows)))).toEqual([
      { event: "BREAK_EXPIRED", from: "ON_BREAK", to: "ON_BREAK", shiftId: "shift-day", breakSessionId: "break-a" },
      { event: "BREAK_STARTED", from: "ON_BREAK", to: "ON_BREAK", shiftId: "shift-day", breakSessionId: "break-b" },
    ]);
  });

  it("stamps every transition with next.computedAt", () => {
    const next = stateAt(at("15:00"), { breakSessions: [brk("break-late", at("14:50"), at("15:10"))] });
    const transitions = diffStates(stateAt(at("14:59"), { breakSessions: [brk("break-late", at("14:50"), at("15:10"))] }), next);
    expect(transitions.length).toBe(2);
    for (const t of transitions) expect(t.at.getTime()).toBe(next.computedAt.getTime());
  });
});

describe("diffStates with a bare previous state", () => {
  it("derives state-level events only", () => {
    const working = stateAt(at("11:00"));
    const onBreak = stateAt(at("10:20"), { breakSessions: [brk("break-1", at("10:15"), at("10:30"))] });
    expect(view(diffStates("OFF_SHIFT", working))).toEqual([
      { event: "WORK_MODE_STARTED", from: "OFF_SHIFT", to: "WORKING", shiftId: "shift-day" },
    ]);
    expect(view(diffStates("UNKNOWN", working))).toEqual([
      { event: "WORK_MODE_STARTED", from: "UNKNOWN", to: "WORKING", shiftId: "shift-day" },
    ]);
    expect(view(diffStates("WORKING", onBreak))).toEqual([
      { event: "BREAK_STARTED", from: "WORKING", to: "ON_BREAK", shiftId: "shift-day", breakSessionId: "break-1" },
    ]);
    expect(view(diffStates("ON_BREAK", working))).toEqual([{ event: "BREAK_ENDED", from: "ON_BREAK", to: "WORKING" }]);
    expect(diffStates("WORKING", working)).toEqual([]);
  });

  it("does not report a break as ended while it is still running under PERMISSION_ERROR", () => {
    const denied = stateAt(at("10:20"), {
      breakSessions: [brk("break-1", at("10:15"), at("10:30"))],
      permissionState: "DENIED",
    });
    expect(view(diffStates("ON_BREAK", denied))).toEqual([
      { event: "PERMISSION_NEEDS_ATTENTION", from: "ON_BREAK", to: "PERMISSION_ERROR", shiftId: "shift-day" },
      { event: "WORK_MODE_ENDED", from: "ON_BREAK", to: "PERMISSION_ERROR" },
    ]);
  });

  it("reports device-only states changing as a plain transition", () => {
    const off = stateAt(at("20:00"));
    expect(diffStates("SYNC_ERROR", off)).toEqual([{ from: "SYNC_ERROR", to: "OFF_SHIFT", at: off.computedAt }]);
  });
});
