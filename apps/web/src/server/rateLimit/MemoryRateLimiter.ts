import type { RateLimiter, RateLimitResult } from "./RateLimiter";

interface Bucket {
  /** Timestamps (ms) of allowed hits inside the window, oldest first; never more than `limit`. */
  hits: number[];
  windowMs: number;
}

/**
 * Sliding-window-log limiter held in process memory. Suitable for a single Node process (dev,
 * tests, single-instance deployments). Multi-instance deployments need the Redis backend.
 *
 * Memory is bounded: a bucket holds at most `limit` timestamps (blocked hits are not recorded), and
 * every `sweepEveryHits` hits buckets whose newest hit has left their own window are dropped.
 */
export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private hits = 0;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly sweepEveryHits = 1_000,
  ) {}

  async hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const nowMs = this.now();
    const windowMs = windowSeconds * 1_000;
    const cutoff = nowMs - windowMs;

    const live = (this.buckets.get(key)?.hits ?? []).filter((t) => t > cutoff);

    if (++this.hits % this.sweepEveryHits === 0) this.sweep(nowMs);

    if (live.length >= limit) {
      this.buckets.set(key, { hits: live, windowMs });
      const oldest = live[0] ?? nowMs;
      return { allowed: false, remaining: 0, resetAt: new Date(oldest + windowMs), limit };
    }

    live.push(nowMs);
    this.buckets.set(key, { hits: live, windowMs });
    const oldest = live[0] ?? nowMs;
    return {
      allowed: true,
      remaining: limit - live.length,
      resetAt: new Date(oldest + windowMs),
      limit,
    };
  }

  async reset(): Promise<void> {
    this.buckets.clear();
  }

  /** Number of tracked keys (diagnostics / tests). */
  get size(): number {
    return this.buckets.size;
  }

  private sweep(nowMs: number): void {
    for (const [key, bucket] of this.buckets) {
      const newest = bucket.hits[bucket.hits.length - 1];
      if (newest === undefined || newest <= nowMs - bucket.windowMs) this.buckets.delete(key);
    }
  }
}
