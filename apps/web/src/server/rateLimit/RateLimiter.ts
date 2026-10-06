/**
 * Rate limiter contract. Implementations must be safe to call concurrently from many requests.
 */
export interface RateLimitResult {
  allowed: boolean;
  /** Requests left in the current window (0 when blocked). */
  remaining: number;
  /** When the oldest counted hit leaves the window, i.e. the earliest moment a blocked caller may retry. */
  resetAt: Date;
  limit: number;
}

export interface RateLimiter {
  /**
   * Record one hit against `key` and report whether it is within `limit` hits per `windowSeconds`.
   * A blocked hit is NOT counted (so a flood does not push the reset time further away).
   */
  hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
  /** Forget everything (tests / admin). */
  reset(): Promise<void>;
}

/** A named limit applied by the API handler wrapper. */
export interface RateLimitRule {
  /** Namespace for the counter, e.g. `auth:login`. */
  key: string;
  limit: number;
  windowSeconds: number;
  /**
   * What identifies the caller: the client IP (default) or the IP combined with a field of the
   * parsed JSON body (e.g. `ip+body:email` so one attacker cannot lock out a victim's IP alone).
   */
  by?: "ip" | `ip+body:${string}`;
}
