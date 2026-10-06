import { describe, expect, it } from "vitest";
import {
  coveringShiftAt,
  isEffectiveShift,
  mergeShiftIntervals,
  nextWorkingIntervalAfter,
  normaliseShifts,
  workingIntervalAt,
} from "./mergeShiftIntervals";
import type { WorkModeShiftLike } from "./types";

const at = (hm: string, day = "2026-01-12"): string => `${day}T${hm}:00.000Z`;

function shift(
  id: string,
  start: Date | string,
  end: Date | string,
  extra: Partial<WorkModeShiftLike> = {},
): WorkModeShiftLike {
  return { id, startsAt: start, endsAt: end, status: "SCHEDULED", ...extra };
}

function summary(
  shifts: readonly WorkModeShiftLike[],
): { startsAt: string; endsAt: string; shiftIds: string[] }[] {
  return mergeShiftIntervals(shifts).map((i) => ({
    startsAt: i.startsAt.toISOString(),
    endsAt: i.endsAt.toISOString(),
    shiftIds: i.shiftIds,
  }));
}

describe("isEffectiveShift", () => {
  it("accepts only SCHEDULED, non-deleted shifts", () => {
    expect(isEffectiveShift(shift("a", at("09:00"), at("10:00")))).toBe(true);
    expect(isEffectiveShift(shift("a", at("09:00"), at("10:00"), { status: "CANCELLED" }))).toBe(
      false,
    );
    expect(isEffectiveShift(shift("a", at("09:00"), at("10:00"), { status: "COMPLETED" }))).toBe(
      false,
    );
    expect(isEffectiveShift(shift("a", at("09:00"), at("10:00"), { deletedAt: at("08:00") }))).toBe(
      false,
    );
    expect(
      isEffectiveShift(shift("a", at("09:00"), at("10:00"), { deletedAt: new Date(at("08:00")) })),
    ).toBe(false);
    expect(isEffectiveShift(shift("a", at("09:00"), at("10:00"), { deletedAt: null }))).toBe(true);
  });
});

describe("mergeShiftIntervals", () => {
  it("returns no intervals for no shifts", () => {
    expect(mergeShiftIntervals([])).toEqual([]);
  });

  it("keeps a single shift as one interval", () => {
    expect(summary([shift("a", at("09:00"), at("15:00"))])).toEqual([
      { startsAt: at("09:00"), endsAt: at("15:00"), shiftIds: ["a"] },
    ]);
  });

  it("merges exactly adjacent shifts into one continuous interval", () => {
    expect(
      summary([shift("am", at("09:00"), at("13:00")), shift("pm", at("13:00"), at("17:00"))]),
    ).toEqual([{ startsAt: at("09:00"), endsAt: at("17:00"), shiftIds: ["am", "pm"] }]);
  });

  it("merges overlapping and contained shifts, keeping the furthest end", () => {
    expect(
      summary([
        shift("long", at("09:00"), at("17:00")),
        shift("inner", at("10:00"), at("12:00")),
        shift("tail", at("16:00"), at("18:00")),
      ]),
    ).toEqual([
      { startsAt: at("09:00"), endsAt: at("18:00"), shiftIds: ["long", "inner", "tail"] },
    ]);
  });

  it("chains merges transitively", () => {
    expect(
      summary([
        shift("c", at("13:00"), at("14:00")),
        shift("a", at("09:00"), at("11:00")),
        shift("b", at("10:00"), at("13:00")),
      ]),
    ).toEqual([{ startsAt: at("09:00"), endsAt: at("14:00"), shiftIds: ["a", "b", "c"] }]);
  });

  it("keeps shifts separated by any positive gap apart", () => {
    expect(
      summary([
        shift("a", at("09:00"), at("12:00")),
        shift("b", "2026-01-12T12:00:00.001Z", at("15:00")),
      ]),
    ).toEqual([
      { startsAt: at("09:00"), endsAt: at("12:00"), shiftIds: ["a"] },
      { startsAt: "2026-01-12T12:00:00.001Z", endsAt: at("15:00"), shiftIds: ["b"] },
    ]);
  });

  it("orders output by start regardless of input order", () => {
    const result = summary([
      shift("late", at("18:00"), at("20:00")),
      shift("early", at("06:00"), at("08:00")),
      shift("mid", at("10:00"), at("12:00")),
    ]);
    expect(result.map((i) => i.shiftIds[0])).toEqual(["early", "mid", "late"]);
  });

  it("ignores cancelled, completed, soft-deleted, zero-length, inverted and duplicate shifts", () => {
    expect(
      summary([
        shift("ok", at("09:00"), at("10:00")),
        shift("cancelled", at("10:00"), at("11:00"), { status: "CANCELLED" }),
        shift("completed", at("10:00"), at("11:00"), { status: "COMPLETED" }),
        shift("deleted", at("10:00"), at("11:00"), { deletedAt: at("08:00") }),
        shift("zero", at("10:00"), at("10:00")),
        shift("inverted", at("11:00"), at("10:00")),
        shift("ok", at("12:00"), at("13:00")),
      ]),
    ).toEqual([{ startsAt: at("09:00"), endsAt: at("10:00"), shiftIds: ["ok"] }]);
  });

  it("does not let a cancelled shift bridge two scheduled ones", () => {
    expect(
      summary([
        shift("a", at("09:00"), at("12:00")),
        shift("bridge", at("12:00"), at("13:00"), { status: "CANCELLED" }),
        shift("b", at("13:00"), at("15:00")),
      ]).map((i) => i.shiftIds),
    ).toEqual([["a"], ["b"]]);
  });

  it("accepts Date and offset ISO strings, and returns fresh Date objects", () => {
    const start = new Date(at("09:00"));
    const input = [shift("a", start, "2026-01-12T16:00:00+01:00")];
    const [interval] = mergeShiftIntervals(input);
    expect(interval?.endsAt.toISOString()).toBe(at("15:00"));
    interval?.startsAt.setTime(0);
    expect(start.toISOString()).toBe(at("09:00"));
  });

  it("rejects naive or invalid instants instead of guessing a zone", () => {
    expect(() => mergeShiftIntervals([shift("a", "2026-01-12T09:00:00", at("10:00"))])).toThrow(
      TypeError,
    );
    expect(() => mergeShiftIntervals([shift("a", "not a date", at("10:00"))])).toThrow(TypeError);
    expect(() => mergeShiftIntervals([shift("a", new Date(Number.NaN), at("10:00"))])).toThrow(
      TypeError,
    );
  });

  it("normaliseShifts orders ties by end then id", () => {
    const refs = normaliseShifts([
      shift("b", at("09:00"), at("12:00")),
      shift("c", at("09:00"), at("11:00")),
      shift("a", at("09:00"), at("12:00")),
    ]);
    expect(refs.map((r) => r.id)).toEqual(["c", "a", "b"]);
  });
});

describe("interval lookups", () => {
  const intervals = mergeShiftIntervals([
    shift("a", at("09:00"), at("13:00")),
    shift("b", at("12:00"), at("17:00")),
    shift("c", at("20:00"), at("22:00")),
  ]);

  it("workingIntervalAt is start-inclusive and end-exclusive", () => {
    expect(workingIntervalAt(intervals, new Date(at("08:59")))).toBeNull();
    expect(workingIntervalAt(intervals, new Date(at("09:00")))?.shiftIds).toEqual(["a", "b"]);
    expect(workingIntervalAt(intervals, new Date("2026-01-12T16:59:59.999Z"))?.shiftIds).toEqual([
      "a",
      "b",
    ]);
    expect(workingIntervalAt(intervals, new Date(at("17:00")))).toBeNull();
  });

  it("nextWorkingIntervalAfter returns the first interval starting strictly later", () => {
    expect(nextWorkingIntervalAfter(intervals, new Date(at("08:00")))?.shiftIds).toEqual([
      "a",
      "b",
    ]);
    expect(nextWorkingIntervalAfter(intervals, new Date(at("09:00")))?.shiftIds).toEqual(["c"]);
    expect(nextWorkingIntervalAfter(intervals, new Date(at("20:00")))).toBeNull();
  });

  it("coveringShiftAt prefers the earliest-starting covering shift", () => {
    const [first] = intervals;
    if (first === undefined) throw new Error("expected an interval");
    expect(coveringShiftAt(first, new Date(at("12:30")))?.id).toBe("a");
    expect(coveringShiftAt(first, new Date(at("13:00")))?.id).toBe("b");
    expect(coveringShiftAt(first, new Date(at("17:00")))).toBeNull();
  });
});
