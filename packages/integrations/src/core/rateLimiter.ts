/**
 * Client-side rate limiting primitives (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §4.5). They are pure
 * bookkeeping over an injected clock: each answers "how long until one more request may start?" and records a
 * request when told to. The HTTP layer combines several of them (per portal and per client id), sleeps the
 * longest delay, then takes a slot from each; because JavaScript runs one task at a time, the check and the take
 * happen without anything interleaving between them.
 */

/**
 * Token bucket: `capacity` requests may start back to back, after which they start at `refillPerSecond`. Planday
 * budgets: 10/s per portal, 50/s per client id (notes §6; the lower documented figures, D-046).
 */
export class TokenBucket {
  readonly capacity: number;
  readonly refillPerSecond: number;
  private tokens: number;
  private updatedAtMs: number | null = null;

  constructor(options: { capacity: number; refillPerSecond: number }) {
    if (!(options.capacity >= 1) || !(options.refillPerSecond > 0)) {
      throw new RangeError("TokenBucket needs capacity ≥ 1 and refillPerSecond > 0");
    }
    this.capacity = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
    this.tokens = options.capacity;
  }

  private refill(nowMs: number): void {
    if (this.updatedAtMs === null) {
      this.updatedAtMs = nowMs;
      return;
    }
    const elapsed = Math.max(0, nowMs - this.updatedAtMs);
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.refillPerSecond);
    this.updatedAtMs = Math.max(this.updatedAtMs, nowMs);
  }

  /** Milliseconds until a token is available at `nowMs` (0 when one is available now). */
  delayMs(nowMs: number): number {
    this.refill(nowMs);
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000);
  }

  /** Spends one token. Call only after `delayMs(nowMs)` returned 0. */
  take(nowMs: number): void {
    this.refill(nowMs);
    this.tokens -= 1;
  }

  /** Tokens left after refilling to `nowMs` (for tests and diagnostics). */
  available(nowMs: number): number {
    this.refill(nowMs);
    return this.tokens;
  }
}

/**
 * Sliding-window budget: at most `limit` requests in any `windowMs`. Planday budgets: 600 per 60 s per portal
 * (documented 750), 1500 per 60 s per client id (documented 2000).
 */
export class SlidingWindowBudget {
  readonly limit: number;
  readonly windowMs: number;
  /** Start times of the requests inside the window, oldest first. */
  private readonly starts: number[] = [];

  constructor(options: { limit: number; windowMs: number }) {
    if (!(options.limit >= 1) || !(options.windowMs > 0)) {
      throw new RangeError("SlidingWindowBudget needs limit ≥ 1 and windowMs > 0");
    }
    this.limit = options.limit;
    this.windowMs = options.windowMs;
  }

  private prune(nowMs: number): void {
    while (this.starts.length > 0 && (this.starts[0] as number) <= nowMs - this.windowMs) {
      this.starts.shift();
    }
  }

  /** Milliseconds until one more request fits in the window at `nowMs`. */
  delayMs(nowMs: number): number {
    this.prune(nowMs);
    if (this.starts.length < this.limit) return 0;
    const oldest = this.starts[this.starts.length - this.limit] as number;
    return Math.max(0, oldest + this.windowMs - nowMs);
  }

  /** Records one request at `nowMs`. Call only after `delayMs(nowMs)` returned 0. */
  take(nowMs: number): void {
    this.prune(nowMs);
    this.starts.push(nowMs);
  }

  /** Requests counted in the window ending at `nowMs`. */
  used(nowMs: number): number {
    this.prune(nowMs);
    return this.starts.length;
  }
}

/**
 * Runs tasks strictly one after another per key, in call order (one request stream per Planday portal inside a
 * process; across processes the per-portal lease does the same, §7.4). A task's failure never blocks the next
 * task for the key. Keys are dropped once their queue drains, so the map does not grow with the number of portals
 * ever seen.
 */
export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** Keys with queued or running tasks (for tests and diagnostics). */
  activeKeys(): string[] {
    return [...this.tails.keys()];
  }
}
