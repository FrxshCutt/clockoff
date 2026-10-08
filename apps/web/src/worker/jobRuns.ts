import { prisma } from "@clockoff/db";
import type { WorkerJobName } from "./jobs";

/**
 * `worker_job_runs` writes (D1, D4): one row per job.
 *
 * - `claimJobSlot` — a scheduled run claims its minute slot INSIDE the job's advisory lock. The upsert
 *   only moves `last_slot` forward, so when two workers fire the same minute back to back the second one
 *   (which got the lock after the first released it) finds the slot taken → `skipped_already_ran`.
 * - `hasFinishedSlot` — the ordering check of a job with `runsAfter` (schedule-upkeep after work-mode-tick).
 * - `recordJobRunFinished` — outcome of a run (`last_ok_at` feeds `/api/health`'s
 *   `worker.lastSuccessfulTickAt` for `work-mode-tick`). A manual run records its outcome without
 *   claiming a slot; a job that never had a scheduled run gets slot 0 (always older than a real slot).
 */

/** The minute slot of `now` (whole minutes since the epoch). */
export function slotOf(now: Date): bigint {
  return BigInt(Math.floor(now.getTime() / 60_000));
}

/** Claim `slot` for `job`. False when this or a later slot was already claimed (another instance ran it). */
export async function claimJobSlot(job: WorkerJobName, slot: bigint, now: Date): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ job: string }>>`
    INSERT INTO worker_job_runs (job, last_slot, last_started_at, last_finished_at, last_outcome, updated_at)
    VALUES (${job}, ${slot}, ${now}, NULL, 'running', ${now})
    ON CONFLICT (job) DO UPDATE SET
      last_slot = EXCLUDED.last_slot,
      last_started_at = EXCLUDED.last_started_at,
      last_finished_at = NULL,
      last_outcome = 'running',
      updated_at = EXCLUDED.updated_at
    WHERE worker_job_runs.last_slot < EXCLUDED.last_slot
    RETURNING job`;
  return rows.length === 1;
}

/**
 * Whether `job` has FINISHED a scheduled run for `slot` or a later one (any outcome). A job with
 * `runsAfter` waits for this before claiming its own slot (`scheduler.ts`), so across instances it still
 * runs after its predecessor, as in the old single tick.
 */
export async function hasFinishedSlot(job: WorkerJobName, slot: bigint): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ job: string }>>`
    SELECT job FROM worker_job_runs
    WHERE job = ${job} AND last_slot >= ${slot} AND last_finished_at IS NOT NULL`;
  return rows.length === 1;
}

/** Record how a run ended; `ok` also moves `last_ok_at`. */
export async function recordJobRunFinished(
  job: WorkerJobName,
  outcome: "ok" | "error",
  now: Date,
): Promise<void> {
  await prisma.workerJobRun.upsert({
    where: { job },
    create: {
      job,
      lastSlot: 0n,
      lastStartedAt: now,
      lastFinishedAt: now,
      lastOutcome: outcome,
      lastOkAt: outcome === "ok" ? now : null,
    },
    update: {
      lastFinishedAt: now,
      lastOutcome: outcome,
      ...(outcome === "ok" ? { lastOkAt: now } : {}),
    },
  });
}
