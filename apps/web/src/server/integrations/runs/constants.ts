import { availableParallelism } from "node:os";
import type { IntegrationSyncRunKind, IntegrationSyncTrigger } from "@clockoff/shared/enums";

/**
 * Constants of the integration run queue and its executor (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md
 * §7.3 to §7.7). Shared by the web services that enqueue runs, the worker's runner and the slice executor.
 */

/** A lease holder that dies frees the portal within this long (§7.4). */
export const LEASE_TTL_MS = 90_000;
/** A running slice renews its lease this often (§7.4). */
export const LEASE_RENEW_MS = 20_000;
/** A slice yields after this long between steps (§7.6). */
export const SLICE_MAX_MS = 120_000;
/** A slice still running this long after its `maxMs` is aborted by the runner (§7.5). */
export const SLICE_OVERRUN_MS = 60_000;
/** The runner polls the queue this often when no bus event woke it (§7.5). */
export const RUNNER_POLL_MS = 10_000;
/** Slices the runner executes at once, before the pool guard (§7.5). */
export const RUNNER_CONCURRENCY = 2;
/** A retryable failure parks the run for attempts 1 and 2; the third fails it (§7.10). */
export const RUN_RETRY_ATTEMPTS = 3;
/** Full-jitter backoff of a parked run (§7.6). */
export const RUN_RETRY_BACKOFF = { baseMs: 5_000, capMs: 120_000 } as const;
/** RUNNING runs older than this with a free lease are failed as STALLED by the upkeep job (§7.9 step 6). */
export const RUN_MAX_AGE_MS = 2 * 3_600_000;
/** Step, park, fail and finalise transactions (§7.6): database-only and short. */
export const STEP_TRANSACTION_TIMEOUT_MS = 10_000;
export const STEP_TRANSACTION_MAX_WAIT_MS = 5_000;
/** At most one progress event per run this often, except on a phase change, park, yield and finish (§7.11). */
export const PROGRESS_EVENT_MIN_INTERVAL_MS = 2_000;
/** `IntegrationSyncRun.warnings` keeps at most this many record-level problems. */
export const RUN_WARNINGS_MAX = 100;
/** Database-only phases (MATCH_EMPLOYEES, REACTIVATIONS, APPLY_EMPLOYEES) work in batches of this size (§6.1). */
export const DATABASE_PHASE_BATCH_SIZE = 100;

/**
 * Queue order, lower first (§7.3): interactive runs (wizard, manual syncs, settings saves), clock runs, recovery
 * runs and auth probes, scheduled runs. Applies to a run's first slice; a started run competes at
 * `max(priority, SCHEDULED)`.
 */
export const RUN_PRIORITY = {
  INTERACTIVE: 0,
  CLOCK: 1,
  RECOVERY: 2,
  SCHEDULED: 3,
} as const;

/** The default priority of a new run (§7.1 table). */
export function defaultRunPriority(
  kind: IntegrationSyncRunKind,
  trigger: IntegrationSyncTrigger,
): number {
  if (kind === "CLOCK") return RUN_PRIORITY.CLOCK;
  switch (trigger) {
    case "INITIAL":
    case "MANUAL":
      return RUN_PRIORITY.INTERACTIVE;
    case "RECOVERY":
      return RUN_PRIORITY.RECOVERY;
    case "SCHEDULED":
      return RUN_PRIORITY.SCHEDULED;
  }
}

/** Prisma's default pool size when `DATABASE_URL` has no `connection_limit`: `2 × CPUs + 1`. */
function defaultPoolSize(): number {
  return 2 * availableParallelism() + 1;
}

/** The Prisma pool size `DATABASE_URL` asks for (`connection_limit`, else Prisma's default). Never logs the URL. */
export function prismaPoolSize(databaseUrl: string): number {
  try {
    const raw = new URL(databaseUrl).searchParams.get("connection_limit");
    const parsed = raw === null ? Number.NaN : Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultPoolSize();
  } catch {
    return defaultPoolSize();
  }
}

/**
 * The runner's concurrency (§7.5 "Pool guard"): `min(RUNNER_CONCURRENCY, max(1, connectionLimit − 2))`. The
 * runner shares one Prisma pool with the per-minute Work Mode jobs, so two connections always stay free.
 */
export function runnerConcurrency(databaseUrl: string): number {
  return Math.min(RUNNER_CONCURRENCY, Math.max(1, prismaPoolSize(databaseUrl) - 2));
}
