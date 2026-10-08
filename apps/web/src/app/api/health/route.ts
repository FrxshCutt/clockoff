import { getMigrationStatus, prisma } from "@clockoff/db";
import { errorSummary, type Logger } from "@/lib/logger";
import { eventBusDiagnostics } from "@/server/events";
import {
  getWorkerHeartbeatStatus,
  type WorkerHeartbeatStatus,
} from "@/server/health/workerHeartbeat";
import { createHandler, json } from "@/server/http/apiHandler";

export const dynamic = "force-dynamic";

/** Reported when the database cannot be asked (nothing is queried). */
const WORKER_UNKNOWN: WorkerHeartbeatStatus = {
  status: "unknown",
  lastHeartbeatAt: null,
  ageSeconds: null,
  instances: 0,
  jobs: "unknown",
  lastSuccessfulTickAt: null,
};

/**
 * `GET /api/health` — liveness, database reachability and migration state for the platform's deploy
 * health check (railway/web.json), uptime checks and post-deploy verification, plus what the background
 * worker and the realtime bus are doing:
 *
 * ```json
 * { "status": "ok", "database": "ok", "migrations": "up_to_date",
 *   "worker": { "status": "fresh", "lastHeartbeatAt": "…", "ageSeconds": 12, "instances": 1,
 *               "jobs": "ok", "lastSuccessfulTickAt": "…" },
 *   "realtime": { "mode": "postgres", "listening": true },
 *   "time": "…" }
 * ```
 *
 * 200 when the database answers and every migration is applied; 503 `{ status: "degraded", … }` when the
 * database is unreachable or migrations are pending/failed. The worker never changes the status code or
 * the top-level `status`: the platform gates web deploys on this endpoint, and a stopped or stale worker
 * must not block (or roll back) the web service. `worker.status` is fresh | stale | stopped | never |
 * unknown (newest live heartbeat within 3 min; a gracefully stopped worker reads `stopped` at once);
 * `worker.jobs` says whether jobs actually complete (ok | starting | stale | waiting_for_migrations |
 * disabled | unknown), since the heartbeat beats on its own timer even when a job is stuck.
 * `realtime.mode` is `postgres` (LISTEN/NOTIFY across processes) or `in_process` (no DIRECT_URL).
 * Reveals no version, instance id, hostname, configuration or error detail.
 */
export const GET = createHandler({ auth: "public" }, async ({ log }) => {
  const now = new Date();
  const time = now.toISOString();
  const realtime = realtimeStatus(log);
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    log.error({ error: errorSummary(err) }, "health check: database unreachable");
    return json(
      {
        status: "degraded",
        database: "unreachable",
        migrations: "unknown",
        worker: WORKER_UNKNOWN,
        realtime,
        time,
      },
      503,
    );
  }
  const [migrations, worker] = await Promise.all([
    getMigrationStatus(prisma),
    workerStatus(now, log),
  ]);
  if (migrations !== "up_to_date")
    log.warn({ migrations }, "health check: migrations not up to date");
  const healthy = migrations === "up_to_date";
  return json(
    { status: healthy ? "ok" : "degraded", database: "ok", migrations, worker, realtime, time },
    healthy ? 200 : 503,
  );
});

/** Never throws: the worker report must not turn a healthy web process into a failed health check. */
async function workerStatus(now: Date, log: Logger): Promise<WorkerHeartbeatStatus> {
  try {
    return await getWorkerHeartbeatStatus(now);
  } catch (err) {
    log.warn({ error: errorSummary(err) }, "health check: worker heartbeat unavailable");
    return WORKER_UNKNOWN;
  }
}

function realtimeStatus(log: Logger): { mode: string; listening: boolean } {
  try {
    const { mode, listening } = eventBusDiagnostics();
    return { mode, listening };
  } catch (err) {
    log.warn({ error: errorSummary(err) }, "health check: event bus diagnostics unavailable");
    return { mode: "unknown", listening: false };
  }
}
