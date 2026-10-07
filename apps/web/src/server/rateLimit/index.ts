import { AppError } from "@clockoff/shared/errors";
import { env } from "@/lib/env";
import { MemoryRateLimiter } from "./MemoryRateLimiter";
import type { RateLimiter, RateLimitResult, RateLimitRule } from "./RateLimiter";

export { MemoryRateLimiter } from "./MemoryRateLimiter";
export type { RateLimiter, RateLimitResult, RateLimitRule } from "./RateLimiter";

/**
 * Pick the limiter backend from the environment.
 *
 * - `memory` (default): {@link MemoryRateLimiter}.
 * - `redis`: not implemented yet. Selecting it (RATE_LIMIT_BACKEND=redis with REDIS_URL set) throws so
 *   a production deployment cannot silently run with per-instance limits. Adding it requires a Redis
 *   client dependency (`ioredis`) and a sliding-window Lua script; see docs/SECURITY.md.
 */
export function createRateLimiter(): RateLimiter {
  const e = env();
  if (e.RATE_LIMIT_BACKEND === "redis" && e.REDIS_URL) {
    throw new Error(
      "RATE_LIMIT_BACKEND=redis is not implemented yet. Use RATE_LIMIT_BACKEND=memory (single instance) " +
        "or add the Redis backend (see apps/web/src/server/rateLimit/index.ts).",
    );
  }
  return new MemoryRateLimiter();
}

declare global {
  var __clockoffRateLimiter: RateLimiter | undefined;
}

/** Process-wide limiter (cached on globalThis so Next dev HMR does not reset counters). */
export function getRateLimiter(): RateLimiter {
  if (!globalThis.__clockoffRateLimiter) globalThis.__clockoffRateLimiter = createRateLimiter();
  return globalThis.__clockoffRateLimiter;
}

/** Replace the process-wide limiter (tests). Pass `undefined` to recreate from env on next use. */
export function setRateLimiterForTesting(limiter: RateLimiter | undefined): void {
  globalThis.__clockoffRateLimiter = limiter;
}

/** Build a stable counter key from a rule namespace and caller identity parts. */
export function rateLimitKey(
  namespace: string,
  ...parts: Array<string | null | undefined>
): string {
  return [namespace, ...parts.map((p) => (p ?? "unknown").toLowerCase().slice(0, 200))].join("|");
}

/**
 * Record a hit and throw `RATE_LIMITED` (429, `details.retryAfterSeconds`) when over the limit.
 * Returns the result so callers can add informational headers.
 */
export async function enforceRateLimit(
  rule: Pick<RateLimitRule, "key" | "limit" | "windowSeconds">,
  identity: string,
  limiter: RateLimiter = getRateLimiter(),
): Promise<RateLimitResult> {
  const result = await limiter.hit(
    rateLimitKey(rule.key, identity),
    rule.limit,
    rule.windowSeconds,
  );
  if (!result.allowed) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((result.resetAt.getTime() - Date.now()) / 1_000),
    );
    throw new AppError("RATE_LIMITED", "Too many requests. Please try again later.", {
      details: { retryAfterSeconds },
    });
  }
  return result;
}

/**
 * Shared limit presets. Auth limits are applied by this package's routes; the mobile join / employee
 * invite presets are exported for the engineers implementing those endpoints.
 */
export const RATE_LIMITS = {
  login: { key: "auth:login", limit: 10, windowSeconds: 15 * 60, by: "ip+body:email" },
  /**
   * Overall login attempts per IP across all emails (credential stuffing walks many accounts from one
   * address; the per-email rule alone would never trigger). Generous enough for an office behind NAT.
   */
  loginPerIp: { key: "auth:login:ip", limit: 100, windowSeconds: 15 * 60, by: "ip" },
  register: { key: "auth:register", limit: 5, windowSeconds: 60 * 60, by: "ip" },
  forgotPassword: { key: "auth:forgot", limit: 5, windowSeconds: 60 * 60, by: "ip" },
  resetPassword: { key: "auth:reset", limit: 20, windowSeconds: 60 * 60, by: "ip" },
  verifyEmail: { key: "auth:verify", limit: 20, windowSeconds: 60 * 60, by: "ip" },
  resendVerification: { key: "auth:resend", limit: 5, windowSeconds: 60 * 60, by: "ip" },
  /** Slows guessing of the current password from a hijacked session. */
  changePassword: { key: "auth:change-password", limit: 10, windowSeconds: 15 * 60, by: "ip" },
  acceptManagerInvite: {
    key: "invites:manager:accept",
    limit: 10,
    windowSeconds: 60 * 60,
    by: "ip",
  },
  lookupManagerInvite: {
    key: "invites:manager:lookup",
    limit: 30,
    windowSeconds: 60 * 60,
    by: "ip",
  },
  inviteManager: { key: "members:invite", limit: 30, windowSeconds: 60 * 60, by: "ip" },
  /** Mobile join by company code (another engineer's endpoint). */
  mobileJoin: { key: "mobile:join", limit: 10, windowSeconds: 60 * 60, by: "ip" },
  /** Employee invite sending (another engineer's endpoint). */
  employeeInvite: { key: "employees:invite", limit: 60, windowSeconds: 60 * 60, by: "ip" },
  /** Mobile refresh-token rotation (another engineer's endpoint). */
  mobileRefresh: { key: "mobile:refresh", limit: 60, windowSeconds: 15 * 60, by: "ip" },
  /** Phone test tools ("Create test shift…"): plenty for a person testing, not for a script. */
  testShift: { key: "test-tools:test-shift", limit: 30, windowSeconds: 60 * 60, by: "ip" },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitPreset = keyof typeof RATE_LIMITS;
