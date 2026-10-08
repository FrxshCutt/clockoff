import { errorSummary, type Logger } from "@/lib/logger";

/**
 * The worker's graceful shutdown (D10), in order:
 *   1. stop the minute trigger, the lease timer, the heartbeat timer, the migration-gate poll and the
 *      watchdog (no new work starts);
 *   2. push leadership hand-over FIRST (disable the bridge with a flush ≤ 5 s, release the lease), so a
 *      standby worker takes over within ~5 s instead of after this worker's whole drain;
 *   3. let running jobs finish within SHUTDOWN_GRACE_MS (abandoned jobs are logged; their locks die with
 *      the session);
 *   4. mark the heartbeat row stopped (≤ 2 s; never bumps lastBeatAt);
 *   5. close the lock session (`pg_advisory_unlock_all()` + end, ≤ 3 s);
 *   6. close the event bus (flush queued NOTIFYs, UNLISTEN, ≤ 3 s), settle detached background tasks;
 *   7. disconnect Prisma, log `worker stopped`, exit 0.
 * A failing or slow step is logged and never blocks the ones after it. A second signal is ignored.
 * Worst case = SHUTDOWN_GRACE_MS + {@link WORKER_SHUTDOWN_FIXED_BUDGET_MS} (20.5 s), which must fit in
 * the worker's Railway draining period (railway/worker.json `drainingSeconds`; src/deploy/railwayConfig
 * .test.ts checks it against SHUTDOWN_GRACE_MS's maximum). A heartbeat still in flight when step 1 gives
 * up cannot undo step 4: `recordWorkerHeartbeat` never revives a row its own process stopped.
 */

/** Per-step upper bounds (ms) of the steps that are not bounded by SHUTDOWN_GRACE_MS. */
export const WORKER_SHUTDOWN_STEP_TIMEOUTS_MS = Object.freeze({
  stopTimers: 2_000,
  handOverPushLeadership: 6_000,
  markStopped: 2_000,
  closeLocks: 3_000,
  closeEventBus: 3_500,
  settleBackgroundTasks: 2_000,
  disconnectDatabase: 2_000,
});

/** The worst-case shutdown time on top of SHUTDOWN_GRACE_MS (20 500 ms). */
export const WORKER_SHUTDOWN_FIXED_BUDGET_MS = Object.values(
  WORKER_SHUTDOWN_STEP_TIMEOUTS_MS,
).reduce((sum, ms) => sum + ms, 0);

export interface WorkerShutdownDeps {
  log: Logger;
  graceMs: number;
  /** Step 1 (synchronous stops; the heartbeat stop also awaits a beat in flight). */
  stopTimers: () => void | Promise<void>;
  handOverPushLeadership: (timeoutMs: number) => Promise<void>;
  stopScheduler: (graceMs: number) => Promise<{ abandoned: string[] }>;
  markStopped: () => Promise<void>;
  closeLocks: () => Promise<void>;
  closeEventBus: (timeoutMs: number) => Promise<void>;
  settleBackgroundTasks: () => Promise<void>;
  disconnectDatabase: () => Promise<void>;
  exit: (code: number) => void;
}

async function step(
  log: Logger,
  name: string,
  timeoutMs: number | null,
  run: () => void | Promise<unknown>,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = Promise.resolve().then(run);
    if (timeoutMs === null) {
      await work;
      return;
    }
    const outcome = await Promise.race([
      work.then(() => "done" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
    if (outcome === "timeout") log.warn({ step: name, timeoutMs }, "shutdown step timed out");
  } catch (err) {
    log.error({ step: name, error: errorSummary(err) }, "shutdown step failed");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Returns the signal handler; only the first call does anything. */
export function createWorkerShutdown(deps: WorkerShutdownDeps): (signal: string) => Promise<void> {
  let started = false;
  return async (signal: string) => {
    if (started) {
      deps.log.info({ signal }, "worker already shutting down; signal ignored");
      return;
    }
    started = true;
    const { log } = deps;
    const startedAt = Date.now();
    log.info({ signal, graceMs: deps.graceMs }, "worker shutting down");

    const t = WORKER_SHUTDOWN_STEP_TIMEOUTS_MS;
    await step(log, "stop timers", t.stopTimers, deps.stopTimers);
    await step(log, "push leadership hand-over", t.handOverPushLeadership, () =>
      deps.handOverPushLeadership(5_000),
    );
    await step(log, "stop scheduler", null, async () => {
      const { abandoned } = await deps.stopScheduler(deps.graceMs);
      if (abandoned.length > 0) log.warn({ abandoned }, "jobs abandoned at shutdown");
    });
    await step(log, "mark heartbeat stopped", t.markStopped, deps.markStopped);
    await step(log, "close lock session", t.closeLocks, deps.closeLocks);
    await step(log, "close event bus", t.closeEventBus, () => deps.closeEventBus(3_000));
    await step(log, "settle background tasks", t.settleBackgroundTasks, deps.settleBackgroundTasks);
    await step(log, "disconnect database", t.disconnectDatabase, deps.disconnectDatabase);

    log.info({ signal, durationMs: Date.now() - startedAt }, "worker stopped");
    deps.exit(0);
  };
}
