import { afterEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { MemoryRateLimiter } from "./MemoryRateLimiter";
import { RATE_LIMITS, createRateLimiter, enforceRateLimit, rateLimitKey } from "./index";

describe("MemoryRateLimiter (sliding window)", () => {
  it("allows `limit` hits per window, then blocks without counting blocked hits", async () => {
    let now = 1_000_000;
    const limiter = new MemoryRateLimiter(() => now);
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await limiter.hit("k", 3, 60));
      now += 1_000;
    }
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
    expect(results[3]?.resetAt.getTime()).toBe(1_000_000 + 60_000);

    // Blocked hits do not extend the window: once the first hit ages out, exactly one slot frees up.
    for (let i = 0; i < 5; i++) expect((await limiter.hit("k", 3, 60)).allowed).toBe(false);
    now = 1_000_000 + 60_001;
    expect((await limiter.hit("k", 3, 60)).allowed).toBe(true);
    expect((await limiter.hit("k", 3, 60)).allowed).toBe(false);
  });

  it("slides: hits leave the window individually", async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(() => now);
    await limiter.hit("k", 2, 10); // t=0
    now = 5_000;
    await limiter.hit("k", 2, 10); // t=5
    now = 10_001; // first hit expired, second still counts
    expect((await limiter.hit("k", 2, 10)).allowed).toBe(true);
    expect((await limiter.hit("k", 2, 10)).allowed).toBe(false);
  });

  it("keeps keys independent and can be reset", async () => {
    const limiter = new MemoryRateLimiter();
    await limiter.hit("a", 1, 60);
    expect((await limiter.hit("a", 1, 60)).allowed).toBe(false);
    expect((await limiter.hit("b", 1, 60)).allowed).toBe(true);
    await limiter.reset();
    expect(limiter.size).toBe(0);
    expect((await limiter.hit("a", 1, 60)).allowed).toBe(true);
  });

  it("sweeps stale buckets to bound memory", async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(() => now, 3);
    await limiter.hit("old", 5, 60);
    now = 2 * 24 * 60 * 60 * 1000;
    await limiter.hit("x", 5, 60);
    await limiter.hit("y", 5, 60);
    expect(limiter.size).toBe(2);
  });

  it("sweeps a bucket as soon as its own window has passed (not after a fixed day)", async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(() => now, 4);
    await limiter.hit("short", 5, 60); // 1-minute window
    await limiter.hit("long", 5, 3600); // 1-hour window
    now = 2 * 60 * 1000; // 2 minutes later
    await limiter.hit("a", 5, 60);
    await limiter.hit("b", 5, 60); // 4th hit → sweep
    expect(limiter.size).toBe(3); // "short" dropped, "long" kept
  });
});

describe("enforceRateLimit", () => {
  it("throws RATE_LIMITED with retryAfterSeconds", async () => {
    const limiter = new MemoryRateLimiter();
    const rule = { key: "test", limit: 1, windowSeconds: 30 };
    await enforceRateLimit(rule, "1.2.3.4", limiter);
    await expect(enforceRateLimit(rule, "1.2.3.4", limiter)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
      details: { retryAfterSeconds: 30 },
    });
  });

  it("namespaces keys", () => {
    expect(rateLimitKey("auth:login", "1.2.3.4|A@B.C")).toBe("auth:login|1.2.3.4|a@b.c");
    expect(rateLimitKey("x", null)).toBe("x|unknown");
  });

  it("ships the documented auth presets", () => {
    expect(RATE_LIMITS.login).toEqual({
      key: "auth:login",
      limit: 10,
      windowSeconds: 900,
      by: "ip+body:email",
    });
    expect(RATE_LIMITS.loginPerIp).toEqual({
      key: "auth:login:ip",
      limit: 100,
      windowSeconds: 900,
      by: "ip",
    });
    expect(RATE_LIMITS.register).toMatchObject({ limit: 5, windowSeconds: 3600 });
    expect(RATE_LIMITS.forgotPassword).toMatchObject({ limit: 5, windowSeconds: 3600 });
    expect(RATE_LIMITS.resetPassword).toMatchObject({ limit: 20, windowSeconds: 3600 });
    expect(RATE_LIMITS.verifyEmail).toMatchObject({ limit: 20, windowSeconds: 3600 });
  });
});

describe("createRateLimiter", () => {
  const saved = { backend: process.env.RATE_LIMIT_BACKEND, url: process.env.REDIS_URL };
  afterEach(() => {
    if (saved.backend === undefined) delete process.env.RATE_LIMIT_BACKEND;
    else process.env.RATE_LIMIT_BACKEND = saved.backend;
    if (saved.url === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = saved.url;
    resetEnvCache();
  });

  it("uses memory by default and refuses the unimplemented redis backend loudly", () => {
    process.env.RATE_LIMIT_BACKEND = "memory";
    resetEnvCache();
    expect(createRateLimiter()).toBeInstanceOf(MemoryRateLimiter);
    process.env.RATE_LIMIT_BACKEND = "redis";
    process.env.REDIS_URL = "redis://localhost:6379";
    resetEnvCache();
    expect(() => createRateLimiter()).toThrow(/not implemented yet/);
  });
});
