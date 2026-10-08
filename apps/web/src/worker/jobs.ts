import type { JobContext, JobDefinition, JobResult } from "@/server/jobs/types";
import { LOCK_KEYS } from "./lockKeys";

/**
 * The worker's jobs (the owner's list → job):
 *   - Work Mode every minute, break expiry (step 1 of the tick) and the hourly notification digest
 *     (consumes the evaluation; keeps its own per-organisation xact lock) → `work-mode-tick`
 *   - override expiry (OVERRIDE_EXPIRED exactly once)                     → `override-expiry`
 *   - recurring shift materialisation + completing ended shifts          → `schedule-upkeep`
 *   - Planday syncs every 15 minutes (a documented no-op until a provider registers) → `integrations-sync`
 *
 * The minute lane runs its due jobs sequentially in this order (the old tick's order); the integrations
 * lane runs separately so a slow provider sync never delays Work Mode. Each job runs under its own
 * advisory lock and claims its minute slot first (`scheduler.ts`), so a slot runs once across workers.
 *
 * Order across workers: two workers can run different jobs of the same minute at once (one is skipped
 * on `work-mode-tick`'s lock and moves on). `schedule-upkeep` completes ended shifts, and a completed
 * shift turns the break sweep's EXPIRED closure into SHIFT_ENDED, so it declares
 * `runsAfter: "work-mode-tick"` (it waits, `skipped_waiting`, until that job finished this minute's slot
 * on some worker; the worker that ran it picks the slot up right after) and completes only shifts that
 * ended by the START of its minute, which every work-mode-tick run of that minute has already swept.
 * Override expiry only emits OVERRIDE_EXPIRED; the evaluation reads `expiresAt`, so its order is free.
 *
 * Job implementations are imported lazily: `node main.mjs list` must work without any environment, and
 * loading a job module pulls in Prisma and the services.
 */

export type WorkerJobName =
  "work-mode-tick" | "override-expiry" | "schedule-upkeep" | "integrations-sync";

export type WorkerLane = "minute" | "integrations";

export interface WorkerJob extends JobDefinition {
  name: WorkerJobName;
  lockKey: bigint;
  intervalMinutes: 1 | 15;
  lane: WorkerLane;
  /**
   * A scheduled run waits until this job has finished a run for the same minute slot (or a later one)
   * on any worker; until then it is `skipped_waiting` and leaves its slot unclaimed. Manual runs ignore it.
   */
  runsAfter?: WorkerJobName;
}

/** Start of the wall-clock minute of `now`. */
export function minuteStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / 60_000) * 60_000);
}

const workModeTick: WorkerJob = {
  name: "work-mode-tick",
  description:
    "Break expiry, scheduled breaks, Work Mode evaluation and the hourly manager digest.",
  lockKey: LOCK_KEYS.workModeTick,
  intervalMinutes: 1,
  lane: "minute",
  async run(ctx: JobContext): Promise<JobResult> {
    const { runWorkModeTick } = await import("@/server/workState/workStateJob");
    const report = await runWorkModeTick(ctx.now, {
      log: ctx.log,
      sweepOverrides: false,
      scheduleUpkeep: false,
    });
    // Per-organisation failures are logged by the tick and counted here; the run itself completed.
    return {
      ok: true,
      processed: report.employeesEvaluated,
      details: {
        organisations: report.organisations,
        employees: report.employeesEvaluated,
        changed: report.stateRowsChanged,
        breaksExpired: report.breaksExpired,
        breaksEndedByShift: report.breaksEndedByShift,
        scheduledBreaksStarted: report.scheduledBreaksStarted,
        syncDelayedEpisodes: report.syncDelayedEpisodes,
        resolutionWarnings: report.resolutionWarnings,
        digests: report.digestsSent,
        organisationErrors: report.errors.length,
      },
    };
  },
};

const overrideExpiry: WorkerJob = {
  name: "override-expiry",
  description: "OVERRIDE_EXPIRED exactly once for every override past its expiry.",
  lockKey: LOCK_KEYS.overrideExpiry,
  intervalMinutes: 1,
  lane: "minute",
  async run(ctx: JobContext): Promise<JobResult> {
    const { sweepExpiredOverrides } = await import("@/server/workState/workStateJob");
    const expired = await sweepExpiredOverrides(ctx.now);
    return { ok: true, processed: expired, details: { overridesExpired: expired } };
  },
};

const scheduleUpkeep: WorkerJob = {
  name: "schedule-upkeep",
  description: "Materialise recurring shifts and mark ended shifts completed.",
  lockKey: LOCK_KEYS.scheduleUpkeep,
  intervalMinutes: 1,
  lane: "minute",
  runsAfter: "work-mode-tick",
  async run(ctx: JobContext): Promise<JobResult> {
    const { runScheduleUpkeep } = await import("@/server/workState/workStateJob");
    // The minute's start, not the trigger time: never complete a shift the break sweep of this minute
    // (on whichever worker, at its own trigger time) may not have seen ended yet.
    const report = await runScheduleUpkeep(minuteStart(ctx.now), ctx.log);
    return {
      ok: report.errors.length === 0,
      processed: report.recurrencesCreated + report.shiftsCompleted,
      details: {
        recurrencesCreated: report.recurrencesCreated,
        shiftsCompleted: report.shiftsCompleted,
        ...(report.errors.length > 0 ? { failedSteps: report.errors } : {}),
      },
      ...(report.errors.length > 0 ? { error: `failed: ${report.errors.join(", ")}` } : {}),
    };
  },
};

const integrationsSync: WorkerJob = {
  name: "integrations-sync",
  description:
    "Scheduled workforce-provider syncs (Planday slot; a no-op until a provider registers).",
  lockKey: LOCK_KEYS.integrationsSync,
  intervalMinutes: 15,
  lane: "integrations",
  async run(ctx: JobContext): Promise<JobResult> {
    const { runScheduledIntegrationSyncs } = await import("@/server/integrations/scheduledSync");
    const report = await runScheduledIntegrationSyncs(ctx.now, { log: ctx.log });
    return { ok: true, processed: report.synced, details: { ...report } };
  },
};

export const WORKER_JOBS: readonly WorkerJob[] = Object.freeze([
  workModeTick,
  overrideExpiry,
  scheduleUpkeep,
  integrationsSync,
]);

export function findWorkerJob(name: string): WorkerJob | undefined {
  return WORKER_JOBS.find((job) => job.name === name);
}

export function isWorkerJobName(name: string): name is WorkerJobName {
  return findWorkerJob(name) !== undefined;
}
