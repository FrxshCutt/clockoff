import { describe, expect, it } from "vitest";
import { fixedClock, nowUtc, systemClock } from "./clock";
import {
  addMinutes,
  isWithin,
  minutesBetween,
  overlaps,
  roundDownToMinute,
  roundUpToMinute,
} from "./intervals";

const t = (iso: string): Date => new Date(iso);

describe("overlaps — half-open [start, end)", () => {
  const a = { start: t("2026-10-06T09:00:00Z"), end: t("2026-10-06T15:00:00Z") };

  it.each<[string, string, string, boolean]>([
    ["identical", "2026-10-06T09:00:00Z", "2026-10-06T15:00:00Z", true],
    ["b starts inside a", "2026-10-06T12:00:00Z", "2026-10-06T18:00:00Z", true],
    ["b ends inside a", "2026-10-06T06:00:00Z", "2026-10-06T10:00:00Z", true],
    ["b contains a", "2026-10-06T00:00:00Z", "2026-10-06T23:00:00Z", true],
    ["b inside a", "2026-10-06T10:00:00Z", "2026-10-06T11:00:00Z", true],
    ["b starts exactly when a ends (touching)", "2026-10-06T15:00:00Z", "2026-10-06T20:00:00Z", false],
    ["b ends exactly when a starts (touching)", "2026-10-06T05:00:00Z", "2026-10-06T09:00:00Z", false],
    ["b entirely before", "2026-10-05T09:00:00Z", "2026-10-05T15:00:00Z", false],
    ["b entirely after", "2026-10-07T09:00:00Z", "2026-10-07T15:00:00Z", false],
    ["b one millisecond into a", "2026-10-06T14:59:59.999Z", "2026-10-06T20:00:00Z", true],
  ])("%s → %s", (_label, bStart, bEnd, expected) => {
    expect(overlaps(a.start, a.end, t(bStart), t(bEnd))).toBe(expected);
    // symmetric
    expect(overlaps(t(bStart), t(bEnd), a.start, a.end)).toBe(expected);
  });

  it("an empty or inverted interval contains no instant, so it overlaps nothing", () => {
    const noon = t("2026-10-06T12:00:00Z");
    expect(overlaps(noon, noon, a.start, a.end)).toBe(false);
    expect(overlaps(a.start, a.end, noon, noon)).toBe(false);
    expect(overlaps(a.start, a.start, a.start, a.end)).toBe(false);
    expect(overlaps(a.end, a.start, a.start, a.end)).toBe(false); // inverted
    expect(overlaps(noon, noon, noon, noon)).toBe(false);
    expect(isWithin(noon, noon, noon)).toBe(false);
  });

  it("isWithin includes the start and excludes the end", () => {
    expect(isWithin(a.start, a.start, a.end)).toBe(true);
    expect(isWithin(a.end, a.start, a.end)).toBe(false);
    expect(isWithin(t("2026-10-06T12:00:00Z"), a.start, a.end)).toBe(true);
    expect(isWithin(t("2026-10-06T08:59:59.999Z"), a.start, a.end)).toBe(false);
  });
});

describe("minute arithmetic", () => {
  it("minutesBetween is signed and may be fractional", () => {
    expect(minutesBetween(t("2026-10-06T09:00:00Z"), t("2026-10-06T15:00:00Z"))).toBe(360);
    expect(minutesBetween(t("2026-10-06T15:00:00Z"), t("2026-10-06T09:00:00Z"))).toBe(-360);
    expect(minutesBetween(t("2026-10-06T09:00:00Z"), t("2026-10-06T09:00:30Z"))).toBe(0.5);
  });

  it("roundUpToMinute leaves aligned instants alone and ceils everything else", () => {
    expect(roundUpToMinute(t("2026-10-06T09:00:00.000Z")).toISOString()).toBe("2026-10-06T09:00:00.000Z");
    expect(roundUpToMinute(t("2026-10-06T09:00:00.001Z")).toISOString()).toBe("2026-10-06T09:01:00.000Z");
    expect(roundUpToMinute(t("2026-10-06T09:00:59.999Z")).toISOString()).toBe("2026-10-06T09:01:00.000Z");
    expect(roundUpToMinute(t("2026-10-06T23:59:30Z")).toISOString()).toBe("2026-10-07T00:00:00.000Z");
  });

  it("roundDownToMinute floors", () => {
    expect(roundDownToMinute(t("2026-10-06T09:00:59.999Z")).toISOString()).toBe("2026-10-06T09:00:00.000Z");
    expect(roundDownToMinute(t("2026-10-06T09:00:00.000Z")).toISOString()).toBe("2026-10-06T09:00:00.000Z");
  });

  it("addMinutes", () => {
    expect(addMinutes(t("2026-10-06T09:00:00Z"), 90).toISOString()).toBe("2026-10-06T10:30:00.000Z");
    expect(addMinutes(t("2026-10-06T09:00:00Z"), -15).toISOString()).toBe("2026-10-06T08:45:00.000Z");
  });
});

describe("clock", () => {
  it("nowUtc reads from the injected clock", () => {
    const frozen = fixedClock("2026-10-06T09:00:00Z");
    expect(nowUtc(frozen).toISOString()).toBe("2026-10-06T09:00:00.000Z");
    // returns a fresh Date each call so callers cannot mutate the clock
    const a = nowUtc(frozen);
    a.setUTCFullYear(1999);
    expect(nowUtc(frozen).getUTCFullYear()).toBe(2026);
  });

  it("systemClock is close to Date.now()", () => {
    const before = Date.now();
    const now = nowUtc(systemClock).getTime();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });

  it("fixedClock rejects unparseable instants", () => {
    expect(() => fixedClock("not a date")).toThrow(TypeError);
  });
});
