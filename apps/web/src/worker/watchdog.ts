/**
 * Minute-lane watchdog (D20). The heartbeat runs on its own timer and stays fresh while a job lane is
 * wedged (a hung query, a deadlock), and Railway's ON_FAILURE policy only restarts a process that exits.
 * So every 30 s the watchdog checks when the minute lane last completed a pass (any outcome except
 * `skipped_overlap`); after 10 minutes without one it calls `onStall` ONCE — the worker logs fatal
 * `minute lane wedged` and exits 1 so Railway restarts it (its dead lock session frees the keys).
 *
 * Armed only while jobs run (not while waiting for migrations, with WORKER_JOBS_ENABLED=false, or during
 * shutdown). The integrations lane is not watched: a provider sync brings its own deadline.
 */

export const WATCHDOG_MAX_STALL_MS = 10 * 60_000;
export const WATCHDOG_CHECK_EVERY_MS = 30_000;

export interface Watchdog {
  start(): void;
  stop(): void;
}

export function createWatchdog(deps: {
  maxStallMs?: number;
  checkEveryMs?: number;
  /** Epoch ms of the last progress (last completed minute-lane pass, else when jobs started). */
  lastProgressAt: () => number;
  onStall: (stalledMs: number) => void;
  clock?: () => number;
}): Watchdog {
  const maxStallMs = deps.maxStallMs ?? WATCHDOG_MAX_STALL_MS;
  const checkEveryMs = deps.checkEveryMs ?? WATCHDOG_CHECK_EVERY_MS;
  const clock = deps.clock ?? Date.now;
  let timer: ReturnType<typeof setInterval> | null = null;
  let fired = false;

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        if (fired) return;
        const stalledMs = clock() - deps.lastProgressAt();
        if (stalledMs >= maxStallMs) {
          fired = true;
          deps.onStall(stalledMs);
        }
      }, checkEveryMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
