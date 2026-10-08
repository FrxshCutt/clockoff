/**
 * A time bound for work that must finish before something else does (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md
 * §4.1, §5.6). Web's connect proof runs inside the web process's graceful-shutdown window, so it creates a
 * deadline of `CONNECT_BUDGET_MS` (minus the reserve the connect transaction needs) and every Planday request
 * started under it uses `min(its own timeout, remainingMs())` and starts only while that is long enough. Worker
 * slices have no deadline: they yield between steps instead.
 *
 * Structurally compatible with `ProviderContext.deadline` (`{ remainingMs(): number }`).
 */
export interface Deadline {
  /** Milliseconds left before the bound; never negative. */
  remainingMs(): number;
  /** True when fewer than `minMs` milliseconds remain (0 by default: the bound has passed). */
  expired(minMs?: number): boolean;
}

/** A deadline `budgetMs` from now. `nowMs` is injectable so tests can move time. */
export function createDeadline(budgetMs: number, nowMs: () => number = Date.now): Deadline {
  if (!Number.isFinite(budgetMs)) throw new RangeError("budgetMs must be a finite number");
  return deadlineAt(nowMs() + budgetMs, nowMs);
}

/** A deadline at the absolute epoch millisecond `atMs`. */
export function deadlineAt(atMs: number, nowMs: () => number = Date.now): Deadline {
  if (!Number.isFinite(atMs)) throw new RangeError("atMs must be a finite number");
  const remainingMs = () => Math.max(0, atMs - nowMs());
  return {
    remainingMs,
    expired: (minMs = 0) => {
      const left = remainingMs();
      return minMs <= 0 ? left <= 0 : left < minMs;
    },
  };
}

/**
 * A child deadline that keeps `reserveMs` of the parent for the caller's own last step (the connect proof keeps
 * 2 s for the connect transaction, §5.6).
 */
export function withReserve(parent: { remainingMs(): number }, reserveMs: number): Deadline {
  const remainingMs = () => Math.max(0, parent.remainingMs() - reserveMs);
  return {
    remainingMs,
    expired: (minMs = 0) => {
      const left = remainingMs();
      return minMs <= 0 ? left <= 0 : left < minMs;
    },
  };
}

/**
 * The timeout for one request under an optional deadline: `min(normalMs, remaining)`, or `null` when less than
 * `minMs` would be left, in which case the request must not start (§4.1: a request starts only while its
 * timeout is at least `CONNECT_MIN_REQUEST_MS`).
 */
export function boundedTimeoutMs(
  normalMs: number,
  deadline: { remainingMs(): number } | undefined,
  minMs: number,
): number | null {
  if (!deadline) return normalMs;
  const t = Math.min(normalMs, deadline.remainingMs());
  return t >= minMs ? t : null;
}
