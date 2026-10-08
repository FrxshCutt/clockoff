/**
 * Full-jitter exponential backoff (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §4.5, §7.6, §7.10): the wait
 * before retry `attempt` (1-based: the first retry is attempt 1) is a uniformly random value in
 * `[0, min(capMs, baseMs × factor^(attempt − 1)))`. Spreading retries over the whole interval keeps many portals
 * that failed together from retrying together.
 *
 * - Planday requests: `{ baseMs: 500, capMs: 8_000 }` between the attempts of one request.
 * - Run-level retries: `{ baseMs: 5_000, capMs: 120_000 }` before a parked run resumes.
 */
export interface BackoffOptions {
  readonly baseMs: number;
  readonly capMs: number;
  /** Growth per attempt; 2 unless stated. */
  readonly factor?: number;
}

/** The upper bound of the jittered wait for `attempt` (exclusive). */
export function backoffCeilingMs(attempt: number, options: BackoffOptions): number {
  const { baseMs, capMs, factor = 2 } = options;
  if (!(baseMs >= 0) || !(capMs >= 0) || !(factor >= 1)) {
    throw new RangeError("Backoff needs baseMs ≥ 0, capMs ≥ 0 and factor ≥ 1");
  }
  const n = Math.max(1, Math.floor(attempt));
  // Exponentiation overflows to Infinity for large attempts; min() caps it.
  return Math.min(capMs, baseMs * factor ** (n - 1));
}

/**
 * A full-jitter wait in whole milliseconds. `random` returns a value in [0, 1) (Math.random by default) and is
 * injectable so tests can pin the jitter.
 */
export function fullJitterBackoff(
  attempt: number,
  options: BackoffOptions,
  random: () => number = Math.random,
): number {
  const ceiling = backoffCeilingMs(attempt, options);
  const r = Math.min(Math.max(random(), 0), 1 - Number.EPSILON);
  return Math.floor(r * ceiling);
}
