import type { MigrationStatus } from "@clockoff/db";
import { errorSummary, type Logger } from "@/lib/logger";

/**
 * Migration gate (D20). Railway deploys web and worker independently and only web runs
 * `prisma migrate deploy` (pre-deploy), so a new worker can start against a schema that is not migrated
 * yet. Before any job or push leadership the worker polls `getMigrationStatus` every 15 s until it is
 * `up_to_date` (a database AHEAD of the code also counts, so an old worker keeps running after web
 * migrates). Any other status, or a database error, keeps waiting — never exits: the heartbeat (already
 * running, `details.waitingForMigrations: true`) and `/api/health` (`worker.jobs: waiting_for_migrations`)
 * show it. Logged at info on entry, then warn every 5 minutes.
 */

export const MIGRATION_GATE_POLL_MS = 15_000;
const WARN_EVERY_MS = 5 * 60_000;

export interface MigrationGateDeps {
  status: () => Promise<MigrationStatus>;
  pollMs?: number;
  log: Logger;
  signal: AbortSignal;
  onWaiting?: (waiting: boolean) => void;
  warnEveryMs?: number;
  clock?: () => number;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Resolves true once migrations are up to date, false when aborted first (shutdown). */
export async function waitForMigrations(deps: MigrationGateDeps): Promise<boolean> {
  const pollMs = deps.pollMs ?? MIGRATION_GATE_POLL_MS;
  const warnEveryMs = deps.warnEveryMs ?? WARN_EVERY_MS;
  const clock = deps.clock ?? Date.now;
  const { log, signal } = deps;
  let waitingSince: number | null = null;
  let lastWarnAt = 0;

  while (!signal.aborted) {
    let status: MigrationStatus | "error";
    let error: ReturnType<typeof errorSummary> | undefined;
    try {
      status = await deps.status();
    } catch (err) {
      status = "error";
      error = errorSummary(err);
    }
    if (status === "up_to_date") {
      if (waitingSince !== null) {
        log.info({ waitedMs: clock() - waitingSince }, "migrations up to date: starting jobs");
      }
      deps.onWaiting?.(false);
      return true;
    }
    const now = clock();
    if (waitingSince === null) {
      waitingSince = now;
      lastWarnAt = now;
      deps.onWaiting?.(true);
      log.info({ status, ...(error ? { error } : {}) }, "waiting for migrations");
    } else if (now - lastWarnAt >= warnEveryMs) {
      lastWarnAt = now;
      log.warn(
        { status, waitedMs: now - waitingSince, ...(error ? { error } : {}) },
        "still waiting for migrations",
      );
    }
    await sleep(pollMs, signal);
  }
  return false;
}
