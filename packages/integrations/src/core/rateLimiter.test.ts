import { describe, expect, it } from "vitest";
import { KeyedSerialQueue, SlidingWindowBudget, TokenBucket } from "./rateLimiter";

describe("TokenBucket", () => {
  it("allows a burst of `capacity`, then one request per 1/rate", () => {
    const bucket = new TokenBucket({ capacity: 10, refillPerSecond: 10 });
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) {
      expect(bucket.delayMs(t0)).toBe(0);
      bucket.take(t0);
    }
    expect(bucket.delayMs(t0)).toBe(100);
    expect(bucket.delayMs(t0 + 50)).toBe(50);
    expect(bucket.delayMs(t0 + 100)).toBe(0);
    bucket.take(t0 + 100);
    expect(bucket.delayMs(t0 + 100)).toBe(100);
  });

  it("refills to capacity and no further", () => {
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1 });
    bucket.take(0);
    bucket.take(0);
    bucket.take(0);
    expect(bucket.available(0)).toBe(0);
    expect(bucket.available(60_000)).toBe(3);
  });

  it("ignores a clock that moves backwards", () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1 });
    bucket.take(10_000);
    expect(bucket.delayMs(9_000)).toBe(1_000);
  });

  it("rejects nonsensical configuration", () => {
    expect(() => new TokenBucket({ capacity: 0, refillPerSecond: 1 })).toThrow(RangeError);
    expect(() => new TokenBucket({ capacity: 1, refillPerSecond: 0 })).toThrow(RangeError);
  });
});

describe("SlidingWindowBudget", () => {
  it("allows `limit` requests per window and frees slots as they age out", () => {
    const window = new SlidingWindowBudget({ limit: 3, windowMs: 60_000 });
    window.take(0);
    window.take(10_000);
    window.take(20_000);
    expect(window.delayMs(30_000)).toBe(30_000);
    expect(window.delayMs(60_000)).toBe(0);
    window.take(60_000);
    expect(window.used(60_000)).toBe(3);
    expect(window.delayMs(60_000)).toBe(10_000);
  });

  it("matches Planday's per-portal minute budget (600 per 60 s)", () => {
    const window = new SlidingWindowBudget({ limit: 600, windowMs: 60_000 });
    for (let i = 0; i < 600; i++) window.take(i * 10);
    expect(window.delayMs(6_000)).toBe(54_000);
    expect(window.delayMs(60_000)).toBe(0);
  });
});

describe("KeyedSerialQueue", () => {
  it("runs tasks of one key strictly one after another, in call order", async () => {
    const queue = new KeyedSerialQueue();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = queue.run("portal-1", async () => {
      events.push("first:start");
      await gate;
      events.push("first:end");
      return 1;
    });
    const second = queue.run("portal-1", async () => {
      events.push("second:start");
      return 2;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events).toEqual(["first:start"]);
    release();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("runs different keys concurrently", async () => {
    const queue = new KeyedSerialQueue();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const a = queue.run("a", async () => {
      await gate;
      events.push("a");
    });
    const b = queue.run("b", async () => {
      events.push("b");
    });
    await b;
    expect(events).toEqual(["b"]);
    release();
    await a;
  });

  it("does not let a failure block the next task, and forgets drained keys", async () => {
    const queue = new KeyedSerialQueue();
    const failing = queue.run("k", async () => {
      throw new Error("boom");
    });
    const next = queue.run("k", async () => "ok");
    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queue.activeKeys()).toEqual([]);
  });
});
