import { prisma, type Prisma } from "@clockoff/db";

/**
 * Worker heartbeat (D4) and the job-health signal `/api/health` reports (D11).
 *
 * The worker upserts one `worker_heartbeats` row per process every minute on its own timer (so the beat
 * stays fresh even while a job lane is wedged) and marks it stopped on a graceful shutdown — `stoppedAt`
 * is set and `lastBeatAt` left alone, so a stopped worker never reads as fresh (and a late beat of the
 * same process cannot clear `stoppedAt` again, see {@link recordWorkerHeartbeat}). Classification only looks
 * at LIVE rows (`stoppedAt IS NULL`).
 *
 * `worker.jobs` says whether work actually happens: `lastSuccessfulTickAt` is `worker_job_runs.lastOkAt`
 * of `work-mode-tick`, shared by every instance. None of this changes the health status code: a stale
 * worker must never fail web's health check (Railway gates web deploys on it).
 *
 * Rows carry no PII; `details` holds counters, flags and timestamps only.
 */

export const WORKER_HEARTBEAT_INTERVAL_MS = 60_000;
export const WORKER_HEARTBEAT_STALE_AFTER_MS = 180_000;
/** Rows whose last beat is older than this are pruned by the worker. */
export const WORKER_HEARTBEAT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** The job whose last success is reported as `lastSuccessfulTickAt`. */
export const WORK_MODE_TICK_JOB = "work-mode-tick";

export type WorkerHeartbeatState = "fresh" | "stale" | "stopped" | "never" | "unknown";
export type WorkerJobsState =
  "ok" | "starting" | "stale" | "waiting_for_migrations" | "disabled" | "unknown";

export interface WorkerHeartbeatStatus {
  status: WorkerHeartbeatState;
  lastHeartbeatAt: string | null;
  ageSeconds: number | null;
  /** Live rows beating within the stale window. */
  instances: number;
  jobs: WorkerJobsState;
  lastSuccessfulTickAt: string | null;
}

export const UNKNOWN_WORKER_STATUS: WorkerHeartbeatStatus = Object.freeze({
  status: "unknown",
  lastHeartbeatAt: null,
  ageSeconds: null,
  instances: 0,
  jobs: "unknown",
  lastSuccessfulTickAt: null,
});

/** Live rows only: newest beat within 180 s → fresh, otherwise stale; no live rows → stopped / never. */
export function classifyWorkerHeartbeat(
  input: { newestLiveBeatAt: Date | null; hasStoppedRows: boolean },
  now: Date,
): "fresh" | "stale" | "stopped" | "never" {
  if (!input.newestLiveBeatAt) return input.hasStoppedRows ? "stopped" : "never";
  return now.getTime() - input.newestLiveBeatAt.getTime() <= WORKER_HEARTBEAT_STALE_AFTER_MS
    ? "fresh"
    : "stale";
}

export interface LiveWorkerDetails {
  jobsEnabled?: boolean;
  waitingForMigrations?: boolean;
  jobsStartedAt?: string | null;
}

/**
 * First match wins: no live rows → unknown; every live row has jobs disabled → disabled; every live row
 * is waiting for migrations → waiting_for_migrations; a `work-mode-tick` success within 180 s → ok; the
 * newest live `jobsStartedAt` within 180 s → starting; otherwise stale.
 */
export function classifyWorkerJobs(
  input: { live: LiveWorkerDetails[]; lastTickOkAt: Date | null },
  now: Date,
): WorkerJobsState {
  const { live, lastTickOkAt } = input;
  if (live.length === 0) return "unknown";
  if (live.every((row) => row.jobsEnabled === false)) return "disabled";
  if (live.every((row) => row.waitingForMigrations === true)) return "waiting_for_migrations";
  const within = (at: number) =>
    Number.isFinite(at) && now.getTime() - at <= WORKER_HEARTBEAT_STALE_AFTER_MS;
  if (lastTickOkAt && within(lastTickOkAt.getTime())) return "ok";
  const startedAt = live
    .map((row) => (typeof row.jobsStartedAt === "string" ? Date.parse(row.jobsStartedAt) : NaN))
    .filter((at) => Number.isFinite(at));
  if (startedAt.length > 0 && within(Math.max(...startedAt))) return "starting";
  return "stale";
}

function asDetails(value: Prisma.JsonValue): LiveWorkerDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const v = value as Record<string, unknown>;
  return {
    ...(typeof v.jobsEnabled === "boolean" ? { jobsEnabled: v.jobsEnabled } : {}),
    ...(typeof v.waitingForMigrations === "boolean"
      ? { waitingForMigrations: v.waitingForMigrations }
      : {}),
    ...(typeof v.jobsStartedAt === "string" ? { jobsStartedAt: v.jobsStartedAt } : {}),
  };
}

/** Rows read per health check (a handful in practice: one per worker deploy within the retention). */
const MAX_LIVE_ROWS = 50;

/**
 * The worker block of `/api/health`. Never throws: any query error → `unknown`. Jobs are classified over
 * the fresh live rows when there are any (a long-dead crashed row must not mask what the running worker
 * reports), otherwise over every live row.
 */
export async function getWorkerHeartbeatStatus(
  now: Date = new Date(),
): Promise<WorkerHeartbeatStatus> {
  try {
    const [live, stopped, tick] = await Promise.all([
      prisma.workerHeartbeat.findMany({
        where: { stoppedAt: null },
        orderBy: { lastBeatAt: "desc" },
        take: MAX_LIVE_ROWS,
        select: { lastBeatAt: true, details: true },
      }),
      prisma.workerHeartbeat.findFirst({
        where: { stoppedAt: { not: null } },
        select: { instanceId: true },
      }),
      prisma.workerJobRun.findUnique({
        where: { job: WORK_MODE_TICK_JOB },
        select: { lastOkAt: true },
      }),
    ]);
    const newest = live[0]?.lastBeatAt ?? null;
    const status = classifyWorkerHeartbeat(
      { newestLiveBeatAt: newest, hasStoppedRows: stopped !== null },
      now,
    );
    const fresh = live.filter(
      (row) => now.getTime() - row.lastBeatAt.getTime() <= WORKER_HEARTBEAT_STALE_AFTER_MS,
    );
    const lastTickOkAt = tick?.lastOkAt ?? null;
    const jobs = classifyWorkerJobs(
      {
        live: (fresh.length > 0 ? fresh : live).map((row) => asDetails(row.details)),
        lastTickOkAt,
      },
      now,
    );
    return {
      status,
      lastHeartbeatAt: newest?.toISOString() ?? null,
      ageSeconds: newest
        ? Math.max(0, Math.floor((now.getTime() - newest.getTime()) / 1000))
        : null,
      instances: fresh.length,
      jobs,
      lastSuccessfulTickAt: lastTickOkAt?.toISOString() ?? null,
    };
  } catch {
    return { ...UNKNOWN_WORKER_STATUS };
  }
}

export interface WorkerHeartbeatInput {
  instanceId: string;
  service: string;
  version: string | null;
  startedAt: Date;
  now: Date;
  details: Record<string, unknown>;
}

/**
 * Upsert this instance's row: `lastBeatAt = now`, `stoppedAt` cleared. A row already marked stopped is
 * only taken over by a LATER process start of the same instance id (a restarted replica): a late beat of
 * the process that stopped it (same `startedAt`, e.g. one still in flight when its shutdown marked the
 * row stopped) changes nothing, so a gracefully stopped worker never reads as live again. Returns
 * whether the row was written.
 */
export async function recordWorkerHeartbeat(input: WorkerHeartbeatInput): Promise<boolean> {
  const details = JSON.stringify(input.details);
  const written = await prisma.$executeRaw`
    INSERT INTO worker_heartbeats
      (instance_id, service, version, started_at, last_beat_at, stopped_at, details, updated_at)
    VALUES
      (${input.instanceId}, ${input.service}, ${input.version}, ${input.startedAt}, ${input.now}, NULL,
       ${details}::jsonb, ${input.now})
    ON CONFLICT (instance_id) DO UPDATE SET
      service = EXCLUDED.service,
      version = EXCLUDED.version,
      started_at = EXCLUDED.started_at,
      last_beat_at = EXCLUDED.last_beat_at,
      stopped_at = NULL,
      details = EXCLUDED.details,
      updated_at = EXCLUDED.updated_at
    WHERE worker_heartbeats.stopped_at IS NULL
       OR worker_heartbeats.started_at < EXCLUDED.started_at`;
  return written === 1;
}

/** Graceful shutdown: `stoppedAt` + `details.stoppedAt`; `lastBeatAt` untouched. */
export async function markWorkerStopped(instanceId: string, now: Date): Promise<void> {
  await prisma.$executeRaw`
    UPDATE worker_heartbeats
    SET stopped_at = ${now},
        details = details || jsonb_build_object('stoppedAt', ${now.toISOString()}::text),
        updated_at = ${now}
    WHERE instance_id = ${instanceId}`;
}

/** Delete rows whose last beat is older than `olderThanMs` (default 7 days). Returns the count. */
export async function pruneWorkerHeartbeats(
  now: Date,
  olderThanMs: number = WORKER_HEARTBEAT_RETENTION_MS,
): Promise<number> {
  const result = await prisma.workerHeartbeat.deleteMany({
    where: { lastBeatAt: { lt: new Date(now.getTime() - olderThanMs) } },
  });
  return result.count;
}
