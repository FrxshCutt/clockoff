import { describe, expect, it } from "vitest";
import { computeExpectedState } from "./computeExpectedState";
import { diffStates } from "./diffStates";
import { replayTransitions } from "./replay";
import type { ComputeExpectedStateInput, Transition, WorkModeBreakSessionLike } from "./types";

const at = (hm: string, day = "2026-01-12"): string => `${day}T${hm}:00.000Z`;

function brk(
  id: string,
  start: string,
  planned: string,
  extra: Partial<WorkModeBreakSessionLike> = {},
): WorkModeBreakSessionLike {
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

function day(
  now: string,
  breakSessions: WorkModeBreakSessionLike[] = [],
): ComputeExpectedStateInput {
  return {
    now,
    shifts: [{ id: "shift-day", startsAt: at("09:00"), endsAt: at("15:00"), status: "SCHEDULED" }],
    breakSessions,
    overrides: [
      {
        id: "ov-temp",
        type: "TEMPORARY_EXCEPTION",
        startsAt: at("12:00"),
        expiresAt: at("12:30"),
        employeeId: "emp-1",
        payload: {},
      },
    ],
    permissionState: "APPROVED",
    timezone: "Europe/London",
  };
}

const view = (ts: Transition[]): string[] =>
  ts.map((t) => `${t.at.toISOString().slice(11, 16)} ${t.eventType ?? `${t.from}→${t.to}`}`);

describe("replayTransitions", () => {
  it("replays the canonical day with exact instants", () => {
    const result = replayTransitions(
      day(at("16:00"), [brk("break-1", at("10:15"), at("10:30"))]),
      at("08:00"),
    );
    expect(view(result.transitions)).toEqual([
      "08:45 OFF_SHIFT→SHIFT_STARTING_SOON",
      "09:00 WORK_MODE_STARTED",
      "10:15 BREAK_STARTED",
      "10:30 BREAK_EXPIRED",
      "12:00 WORKING→WORKING",
      "12:30 OVERRIDE_EXPIRED",
      "14:55 WORKING→SHIFT_ENDING",
      "15:00 WORK_MODE_ENDED",
    ]);
    expect(result.states[0]?.computedAt.toISOString()).toBe(at("08:00"));
    expect(result.states.at(-1)?.computedAt.toISOString()).toBe(at("16:00"));
    expect(result.states.at(-1)?.state).toBe("OFF_SHIFT");
  });

  it("does not collapse a whole break between two ticks, unlike a single diff", () => {
    const input = day(at("11:00"), [brk("break-1", at("10:15"), at("10:30"))]);
    const collapsed = diffStates(
      computeExpectedState({ ...input, now: at("10:00") }),
      computeExpectedState(input),
    );
    expect(collapsed).toEqual([]);
    expect(view(replayTransitions(input, at("10:00")).transitions)).toEqual([
      "10:15 BREAK_STARTED",
      "10:30 BREAK_EXPIRED",
    ]);
  });

  it("sees an early-ended break through its endedAt", () => {
    const input = day(at("11:00"), [
      brk("break-1", at("10:15"), at("10:30"), { status: "ENDED", endedAt: at("10:20") }),
    ]);
    const transitions = replayTransitions(input, at("10:00")).transitions;
    expect(view(transitions)).toEqual(["10:15 BREAK_STARTED", "10:20 BREAK_ENDED"]);
    expect(transitions[1]?.breakSessionId).toBe("break-1");
  });

  it("includes a transition exactly at now, and none exactly at since", () => {
    const input = day(at("09:00"));
    expect(view(replayTransitions(input, at("08:45")).transitions)).toEqual([
      "09:00 WORK_MODE_STARTED",
    ]);
  });

  it("returns one state and no transitions when since equals now", () => {
    const result = replayTransitions(day(at("11:00")), at("11:00"));
    expect(result.states).toHaveLength(1);
    expect(result.transitions).toEqual([]);
  });

  it("accepts a Date for since", () => {
    expect(replayTransitions(day(at("09:30")), new Date(at("08:00"))).transitions).toHaveLength(2);
  });

  it("rejects since after now", () => {
    expect(() => replayTransitions(day(at("09:00")), at("10:00"))).toThrow(RangeError);
  });

  it("names the shift in progress at each change across back-to-back shifts", () => {
    const input: ComputeExpectedStateInput = {
      ...day(at("18:00")),
      shifts: [
        { id: "am", startsAt: at("09:00"), endsAt: at("13:00"), status: "SCHEDULED" },
        { id: "pm", startsAt: at("13:00"), endsAt: at("17:00"), status: "SCHEDULED" },
      ],
      overrides: [
        {
          id: "ov-exempt",
          type: "EXEMPT_TEMPORARILY",
          startsAt: at("12:00"),
          expiresAt: at("14:00"),
          employeeId: "emp-1",
        },
      ],
      options: { shiftEndingWarningMinutes: 0 },
    };
    const transitions = replayTransitions(input, at("08:00")).transitions.filter(
      (t) => t.eventType !== undefined,
    );
    expect(
      transitions.map(
        (t) => `${t.at.toISOString().slice(11, 16)} ${t.eventType ?? ""} ${t.shiftId ?? ""}`,
      ),
    ).toEqual([
      "09:00 WORK_MODE_STARTED am",
      "12:00 WORK_MODE_ENDED am",
      "14:00 OVERRIDE_EXPIRED pm",
      "14:00 WORK_MODE_STARTED pm",
      "17:00 WORK_MODE_ENDED pm",
    ]);
  });
});

describe("replayTransitions with a previous state", () => {
  it("omitting previous, or passing null, emits nothing at since", () => {
    const input = { ...day(at("11:05")), permissionState: "DENIED" as const };
    expect(replayTransitions(input, at("11:00")).transitions).toEqual([]);
    expect(replayTransitions(input, at("11:00"), null).transitions).toEqual([]);
  });

  it("a bare persisted state that no longer matches the rows is reconciled at since", () => {
    // Persisted WORKING at 11:00; permission has since been reported DENIED (the rows say so for the whole replay).
    const result = replayTransitions(
      { ...day(at("11:05")), permissionState: "DENIED" },
      at("11:00"),
      "WORKING",
    );
    expect(view(result.transitions)).toEqual([
      "11:00 PERMISSION_NEEDS_ATTENTION",
      "11:00 WORK_MODE_ENDED",
    ]);
    expect(result.transitions.every((t) => t.at.toISOString() === at("11:00"))).toBe(true);
  });

  it("a full previous ExpectedState reconciles a break that was ended before since", () => {
    const running = brk("break-1", at("10:15"), at("10:30"));
    const previous = computeExpectedState(day(at("10:18"), [running]));
    expect(previous.state).toBe("ON_BREAK");
    // The device later reported the break ended at 10:17, before the last persisted evaluation's view changed.
    const ended = brk("break-1", at("10:15"), at("10:30"), {
      status: "ENDED",
      endedAt: at("10:17"),
    });
    const result = replayTransitions(day(at("10:25"), [ended]), at("10:18"), previous);
    expect(view(result.transitions)).toEqual(["10:18 BREAK_ENDED"]);
    expect(result.transitions[0]?.breakSessionId).toBe("break-1");
  });

  it("a previous state that still matches emits nothing extra", () => {
    const input = day(at("16:00"), [brk("break-1", at("10:15"), at("10:30"))]);
    const previous = computeExpectedState({ ...input, now: at("08:00") });
    expect(replayTransitions(input, at("08:00"), previous).transitions).toEqual(
      replayTransitions(input, at("08:00")).transitions,
    );
  });
});
