import { randomUUID } from "node:crypto";
import { errorSummary, stackFrames, type Logger } from "@/lib/logger";
import type { JobResult } from "@/server/jobs/types";
import type { AdvisoryLockSession } from "./advisoryLock";
import { claimJobSlot, hasFinishedSlot, recordJobRunFinished, slotOf } from "./jobRuns";
import type { WorkerJob, WorkerJobName, WorkerLane } from "./jobs";

/**
 * The worker's job scheduler (D1).
 *
 * `onMinute(now)` (fired by the minute trigger below) starts, per lane, the jobs that are due this
 * minute (`Math.floor(now / 60 000) % intervalMinutes === 0`). A lane runs its due jobs sequentially in
 * `WORKER_JOBS` order; lanes run independently, so a slow integrations sync never delays Work Mode. A lane
 * that is still busy when the next minute fires skips that minute (`skipped_overlap`, warn) — every job is
 * idempotent, so the next pass catches up.
 *
 * One scheduled run = `pg_try_advisory_lock(job.lockKey)` (held elsewhere → `skipped_locked`) → for a job
 * with `runsAfter`, check that job finished this slot on some worker (not yet → `skipped_waiting`, slot
 * left unclaimed) → claim the minute slot in `worker_job_runs` (already claimed → `skipped_already_ran`)
 * → run → record the outcome → unlock. A manual `runOnce` takes the lock but never checks the order or
 * claims a slot (an operator asked for an extra run).
 * Every run logs one `job finished` line `{ job, outcome, durationMs, …counts }`.
 */

export type JobOutcome =
  | "ok"
  | "error"
  | "skipped_locked"
  | "skipped_already_ran"
  | "skipped_waiting"
  | "skipped_overlap"
  | "skipped_shutdown";

export interface JobRunSummary {
  at: string;
  outcome: JobOutcome;
  durationMs: number;
}

export interface Scheduler {
  /** Scheduled: lock → claim slot → run → record. Resolves when the passes it started have finished. */
  onMinute(now: Date): Promise<void>;
  /** Manual: lock → run → record (no slot claim). */
  runOnce(
    name: WorkerJobName,
    now?: Date,
  ): Promise<{ outcome: JobOutcome; durationMs: number; result?: JobResult }>;
  /** Stop starting jobs and wait up to `graceMs` for running ones; reports the jobs still running. */
  stop(graceMs: number): Promise<{ abandoned: string[] }>;
  /** When a minute-lane pass last completed (any outcome except skipped_overlap); watchdog + heartbeat. */
  minuteLaneLastCompletedAt(): number | null;
  /** Last outcome per job (heartbeat details). */
  lastRuns(): Record<string, JobRunSummary>;
  /** Jobs running right now (watchdog log). */
  inFlight(): Array<{ lane: WorkerLane; job: WorkerJobName; runningForMs: number }>;
}

export interface SchedulerDeps {
  jobs: readonly WorkerJob[];
  locks: AdvisoryLockSession;
  log: Logger;
  claimSlot?: typeof claimJobSlot;
  recordFinished?: typeof recordJobRunFinished;
  finishedSlot?: typeof hasFinishedSlot;
  /** Clock for durations / progress timestamps (tests). */
  clock?: () => number;
}

export function isJobDue(job: Pick<WorkerJob, "intervalMinutes">, now: Date): boolean {
  return Math.floor(now.getTime() / 60_000) % job.intervalMinutes === 0;
}

/** Numeric/string/boolean fields of a job's details, for the `job finished` line. */
function logCounts(details: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details ?? {})) {
    if (["number", "string", "boolean"].includes(typeof value)) out[key] = value;
    else if (Array.isArray(value) && value.every((v) => typeof v === "string")) out[key] = value;
  }
  return out;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { jobs, locks, log } = deps;
  const claimSlot = deps.claimSlot ?? claimJobSlot;
  const recordFinished = deps.recordFinished ?? recordJobRunFinished;
  const finishedSlot = deps.finishedSlot ?? hasFinishedSlot;
  const clock = deps.clock ?? Date.now;
  const running = new Map<WorkerLane, Promise<void>>();
  const current = new Map<WorkerLane, { job: WorkerJobName; startedAt: number }>();
  const last: Record<string, JobRunSummary> = {};
  let minuteLaneCompletedAt: number | null = null;
  let stopping = false;

  function finish(
    job: WorkerJob,
    outcome: JobOutcome,
    startedAt: number,
    extra: Record<string, unknown> = {},
  ): { outcome: JobOutcome; durationMs: number } {
    const durationMs = Math.max(0, clock() - startedAt);
    last[job.name] = { at: new Date(clock()).toISOString(), outcome, durationMs };
    const line = { job: job.name, outcome, durationMs, ...extra };
    if (outcome === "error") log.error(line, "job finished");
    else if (outcome === "skipped_overlap") log.warn(line, "job finished");
    else log.info(line, "job finished");
    return { outcome, durationMs };
  }

  async function execute(
    job: WorkerJob,
    now: Date,
    mode: "scheduled" | "manual",
  ): Promise<{ outcome: JobOutcome; durationMs: number; result?: JobResult }> {
    const startedAt = clock();
    if (stopping) return finish(job, "skipped_shutdown", startedAt);

    let acquired: boolean;
    try {
      acquired = await locks.tryAcquire(job.lockKey);
    } catch (err) {
      return finish(job, "error", startedAt, { stage: "lock", error: errorSummary(err) });
    }
    if (!acquired) return finish(job, "skipped_locked", startedAt);

    try {
      if (mode === "scheduled") {
        if (job.runsAfter) {
          let ready: boolean;
          try {
            ready = await finishedSlot(job.runsAfter, slotOf(now));
          } catch (err) {
            return finish(job, "error", startedAt, { stage: "order", error: errorSummary(err) });
          }
          if (!ready) return finish(job, "skipped_waiting", startedAt, { after: job.runsAfter });
        }
        let claimed: boolean;
        try {
          claimed = await claimSlot(job.name, slotOf(now), new Date(clock()));
        } catch (err) {
          return finish(job, "error", startedAt, { stage: "claim", error: errorSummary(err) });
        }
        if (!claimed) return finish(job, "skipped_already_ran", startedAt);
      }

      let result: JobResult;
      current.set(job.lane, { job: job.name, startedAt });
      try {
        result = await job.run({
          now,
          requestId: randomUUID(),
          log: log.child({ job: job.name }),
        });
      } catch (err) {
        log.error(
          { job: job.name, error: errorSummary(err), stack: stackFrames(err) },
          "job failed",
        );
        result = { ok: false, error: errorSummary(err).message };
      } finally {
        current.delete(job.lane);
      }

      const outcome = result.ok ? "ok" : "error";
      try {
        await recordFinished(job.name, outcome, new Date(clock()));
      } catch (err) {
        log.warn({ job: job.name, error: errorSummary(err) }, "job outcome not recorded");
      }
      return {
        ...finish(job, outcome, startedAt, {
          ...logCounts(result.details),
          ...(result.error ? { error: result.error } : {}),
        }),
        result,
      };
    } finally {
      await locks.release(job.lockKey);
    }
  }

  function startLane(lane: WorkerLane, due: WorkerJob[], now: Date): Promise<void> {
    const pass = (async () => {
      for (const job of due) {
        await execute(job, now, "scheduled");
      }
      if (lane === "minute") minuteLaneCompletedAt = clock();
    })()
      .catch((err: unknown) => {
        // execute() handles every job error itself; this is a bug guard, never expected.
        log.error({ lane, error: errorSummary(err), stack: stackFrames(err) }, "lane pass failed");
      })
      .finally(() => {
        running.delete(lane);
      });
    running.set(lane, pass);
    return pass;
  }

  return {
    onMinute(now: Date): Promise<void> {
      if (stopping) return Promise.resolve();
      const passes: Promise<void>[] = [];
      const lanes = [...new Set(jobs.map((job) => job.lane))];
      for (const lane of lanes) {
        const due = jobs.filter((job) => job.lane === lane && isJobDue(job, now));
        if (due.length === 0) continue;
        if (running.has(lane)) {
          const busy = current.get(lane);
          for (const job of due) {
            finish(job, "skipped_overlap", clock(), {
              lane,
              ...(busy ? { busyWith: busy.job, busyForMs: clock() - busy.startedAt } : {}),
            });
          }
          continue;
        }
        passes.push(startLane(lane, due, now));
      }
      return Promise.all(passes).then(() => undefined);
    },

    async runOnce(name: WorkerJobName, now: Date = new Date(clock())) {
      const job = jobs.find((j) => j.name === name);
      if (!job) throw new Error(`Unknown worker job: ${name}`);
      return execute(job, now, "manual");
    },

    async stop(graceMs: number) {
      stopping = true;
      const pending = [...running.values()];
      if (pending.length === 0) return { abandoned: [] };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        Promise.all(pending).then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), graceMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!timedOut) return { abandoned: [] };
      const abandoned = [...current.values()].map((c) => c.job);
      log.warn({ abandoned, graceMs }, "worker stop: jobs still running after the grace period");
      return { abandoned };
    },

    minuteLaneLastCompletedAt: () => minuteLaneCompletedAt,

    lastRuns: () => ({ ...last }),

    inFlight: () =>
      [...current.entries()].map(([lane, c]) => ({
        lane,
        job: c.job,
        runningForMs: clock() - c.startedAt,
      })),
  };
}

export interface MinuteTrigger {
  /** Arm the trigger; `immediate` also fires once right away (catch up after a deploy). */
  start(immediate?: boolean): void;
  stop(): void;
}

/**
 * Calls `onMinute(new Date())` at the start of every wall-clock minute (setTimeout re-armed for the next
 * boundary each time, so it never drifts; an early wake-up is re-armed for the remainder).
 */
export function createMinuteTrigger(
  onMinute: (now: Date) => void,
  opts: { clock?: () => number } = {},
): MinuteTrigger {
  const clock = opts.clock ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active = false;

  function arm(target: number): void {
    timer = setTimeout(
      () => {
        if (!active) return;
        if (clock() < target) {
          arm(target);
          return;
        }
        arm((Math.floor(clock() / 60_000) + 1) * 60_000);
        onMinute(new Date(clock()));
      },
      Math.max(0, target - clock()),
    );
  }

  return {
    start(immediate = false) {
      if (active) return;
      active = true;
      arm((Math.floor(clock() / 60_000) + 1) * 60_000);
      if (immediate) onMinute(new Date(clock()));
    },
    stop() {
      active = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
