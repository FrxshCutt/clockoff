import { describe, expect, it } from "vitest";
import { backoffCeilingMs, fullJitterBackoff } from "./backoff";
import { boundedTimeoutMs, createDeadline, deadlineAt, withReserve } from "./deadline";

describe("fullJitterBackoff", () => {
  const request = { baseMs: 500, capMs: 8_000 };

  it("doubles the ceiling per attempt up to the cap", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((a) => backoffCeilingMs(a, request))).toEqual([
      500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000,
    ]);
    expect(backoffCeilingMs(1_000, request)).toBe(8_000);
  });

  it("stays inside [0, ceiling) whatever the random value", () => {
    for (const attempt of [1, 2, 3, 10]) {
      const ceiling = backoffCeilingMs(attempt, request);
      expect(fullJitterBackoff(attempt, request, () => 0)).toBe(0);
      expect(fullJitterBackoff(attempt, request, () => 0.5)).toBe(Math.floor(ceiling / 2));
      const top = fullJitterBackoff(attempt, request, () => 0.999_999_999);
      expect(top).toBeLessThan(ceiling);
      expect(top).toBeGreaterThanOrEqual(ceiling - 1);
      // Out-of-range randoms are clamped rather than escaping the interval.
      expect(fullJitterBackoff(attempt, request, () => 7)).toBeLessThan(ceiling);
      expect(fullJitterBackoff(attempt, request, () => -1)).toBe(0);
    }
  });

  it("supports the run-level schedule (5 s … 120 s)", () => {
    const run = { baseMs: 5_000, capMs: 120_000 };
    expect(backoffCeilingMs(1, run)).toBe(5_000);
    expect(backoffCeilingMs(2, run)).toBe(10_000);
    expect(backoffCeilingMs(9, run)).toBe(120_000);
  });

  it("treats attempt 0 or fractions as attempt 1 and rejects bad options", () => {
    expect(backoffCeilingMs(0, request)).toBe(500);
    expect(backoffCeilingMs(2.7, request)).toBe(1_000);
    expect(() => backoffCeilingMs(1, { baseMs: -1, capMs: 1 })).toThrow(RangeError);
    expect(() => backoffCeilingMs(1, { baseMs: 1, capMs: 1, factor: 0.5 })).toThrow(RangeError);
  });
});

describe("Deadline", () => {
  it("counts down on the injected clock and never goes negative", () => {
    let now = 1_000;
    const deadline = createDeadline(5_000, () => now);
    expect(deadline.remainingMs()).toBe(5_000);
    expect(deadline.expired()).toBe(false);
    now += 3_000;
    expect(deadline.remainingMs()).toBe(2_000);
    expect(deadline.expired(3_000)).toBe(true);
    expect(deadline.expired(2_000)).toBe(false);
    now += 10_000;
    expect(deadline.remainingMs()).toBe(0);
    expect(deadline.expired()).toBe(true);
  });

  it("keeps a reserve for the caller's last step", () => {
    let now = 0;
    const parent = deadlineAt(18_000, () => now);
    const proof = withReserve(parent, 2_000);
    expect(proof.remainingMs()).toBe(16_000);
    now = 17_000;
    expect(proof.remainingMs()).toBe(0);
    expect(proof.expired()).toBe(true);
  });

  it("bounds a request timeout and refuses to start below the floor", () => {
    expect(boundedTimeoutMs(10_000, undefined, 3_000)).toBe(10_000);
    expect(boundedTimeoutMs(10_000, { remainingMs: () => 15_000 }, 3_000)).toBe(10_000);
    expect(boundedTimeoutMs(10_000, { remainingMs: () => 4_500 }, 3_000)).toBe(4_500);
    expect(boundedTimeoutMs(10_000, { remainingMs: () => 3_000 }, 3_000)).toBe(3_000);
    expect(boundedTimeoutMs(10_000, { remainingMs: () => 2_999 }, 3_000)).toBeNull();
  });
});
