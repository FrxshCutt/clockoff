import { prisma } from "@workmode/db";
import { schedule, type ScheduledTask } from "node-cron";
import { env, envWarnings } from "@/lib/env";
import { childLogger, errorSummary, stackFrames } from "@/lib/logger";
import { flushPushBridge, startPushBridge } from "@/server/realtime/pushBridge";
import { runWorkModeTick } from "@/server/workState/workStateJob";

/**
 * Background job runner — `pnpm --filter @workmode/web jobs` (tsx). Runs the Work Mode tick every minute
 * (node-cron `* * * * *`) while `JOBS_ENABLED` is true, with an in-process overlap guard (a tick that is
 * still running when the next minute fires is logged and the new one skipped — the tick is idempotent, so
 * nothing is lost), structured pino logging and a graceful SIGTERM/SIGINT shutdown that lets the running
 * tick finish, flushes pending silent pushes and disconnects Prisma.
 *
 * The same tick is reachable over HTTP (`POST /api/jobs/tick`, bearer `CRON_SECRET`) for platforms that
 * prefer an external scheduler. Both may run at once: every write in the tick is guarded. See
 * docs/WORK_MODE_SERVER_JOB.md.
 */

export const WORK_MODE_TICK_CRON = "* * * * *";

const log = childLogger({ module: "jobs" });

let running: Promise<void> | null = null;
let task: ScheduledTask | null = null;
let shuttingDown = false;

async function tick(): Promise<void> {
  if (running) {
    log.warn("work mode tick skipped: previous tick still running");
    return;
  }
  const started = Date.now();
  running = (async () => {
    try {
      const report = await runWorkModeTick(new Date(), { log });
      if (report.errors.length > 0) {
        log.warn(
          { errors: report.errors.length, durationMs: report.durationMs },
          "work mode tick finished with errors",
        );
      }
    } catch (err) {
      log.error(
        { error: errorSummary(err), stack: stackFrames(err), durationMs: Date.now() - started },
        "work mode tick failed",
      );
    } finally {
      running = null;
    }
  })();
  await running;
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "jobs: shutting down");
  task?.stop();
  try {
    if (running) await running;
    await flushPushBridge();
  } catch (err) {
    log.error({ error: errorSummary(err) }, "jobs: shutdown step failed");
  }
  await prisma.$disconnect().catch(() => undefined);
  log.info("jobs: stopped");
  process.exit(0);
}

export async function main(): Promise<void> {
  const config = env();
  for (const warning of envWarnings()) log.warn({ warning }, "environment warning");
  if (!config.JOBS_ENABLED) {
    log.info("JOBS_ENABLED is false: the scheduler will not run (use POST /api/jobs/tick instead)");
    return;
  }
  const bridged = await startPushBridge();
  log.info({ organisations: bridged }, "push bridge started");

  task = schedule(WORK_MODE_TICK_CRON, () => void tick());
  log.info({ cron: WORK_MODE_TICK_CRON }, "work mode scheduler started");

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  // Run once immediately so a fresh deploy catches up without waiting for the next minute boundary.
  await tick();
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  /[\\/]src[\\/]jobs[\\/]main\.(ts|js|mjs)$/.test(process.argv[1]);
if (isEntrypoint) {
  main().catch((err: unknown) => {
    log.error({ error: errorSummary(err), stack: stackFrames(err) }, "jobs: fatal");
    process.exit(1);
  });
}
