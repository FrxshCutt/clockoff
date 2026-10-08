import type { MigrationStatus } from "@clockoff/db";
import { env, envWarnings, isPooledPostgresUrl, type Env } from "@/lib/env";
import { childLogger, errorSummary, stackFrames, type Logger } from "@/lib/logger";
import {
  createAdvisoryLockSession,
  DirectUrlPooledError,
  lockSessionApplicationName,
} from "./advisoryLock";
import { createHeartbeatLoop, workerIdentity, type HeartbeatLoop } from "./heartbeat";
import { findWorkerJob, WORKER_JOBS, type WorkerJobName } from "./jobs";
import { waitForMigrations } from "./migrationGate";
import { createPushLeader, type PushLeader } from "./pushLeader";
import {
  createMinuteTrigger,
  createScheduler,
  type JobOutcome,
  type MinuteTrigger,
} from "./scheduler";
import { createWorkerShutdown } from "./shutdown";
import { createWatchdog, type Watchdog } from "./watchdog";

/**
 * The worker process's command line (D19) — `node main.mjs <command>` in the image, `pnpm worker
 * <command>` in development:
 *
 *   serve (default)            scheduler + heartbeat + push leadership, until SIGTERM
 *   list                       the jobs (needs no environment)
 *   run <job>                  one run under the job's lock, no slot claim
 *                              (exit 0 ok, 1 error, 3 locked elsewhere, 4 migrations not up to date)
 *   emit-diagnostic <orgId>    publish a `diagnostic.ping` realtime event, print its nonce (exit 2 when
 *                              the organisation is unknown)
 *
 * `serve` (D20), in order: (1) env + config checks — a missing DIRECT_URL in production, a pooled lock
 * URL or the retired `JOBS_ENABLED=false` is fatal (exit 1); (2) the heartbeat starts at once
 * (`waitingForMigrations: true`); (3) the event bus listener starts; (4) the migration gate waits for
 * `up_to_date`; (5) once the bus delivery self-test passes the worker competes for push leadership, and
 * the first attempt is awaited (≤ {@link LEADER_SETTLE_TIMEOUT_MS}) so the start-up pass's push events
 * reach a bridge; (6) unless WORKER_JOBS_ENABLED=false, the minute trigger starts with an immediate
 * catch-up pass (`jobsStartedAt`) and the watchdog is armed. It never exits on a transient database
 * error: Prisma connects lazily and the gate / heartbeat retry, the lock session and the listener
 * reconnect with backoff. Only configuration errors, uncaught exceptions and the watchdog exit 1
 * (Railway's ON_FAILURE restarts it).
 *
 * Liveness: almost every timer of the runtime is `unref`'d, and the database sockets are the only other
 * handles, so when the database drops every session at once (a Neon restart) nothing would keep Node
 * running while the lock session and the listener wait to reconnect — Node would exit 0, which
 * ON_FAILURE never restarts. `serve` therefore holds one ref'd keep-alive interval until shutdown, and a
 * `beforeExit` (the loop drained anyway) outside shutdown is logged fatal and exits 1.
 * Shutdown order: see `shutdown.ts`.
 */

export const EXIT_CODES = {
  ok: 0,
  error: 1,
  usage: 2,
  locked: 3,
  migrationsPending: 4,
} as const;

export const USAGE = [
  "Usage: node main.mjs <command>   (development: pnpm worker <command>)",
  "  serve                      run the jobs, the heartbeat and push leadership (default)",
  "  list                       list the jobs",
  "  run <job>                  run one job now under its lock (exit 0 ok, 1 error, 3 locked, 4 migrations pending)",
  "  emit-diagnostic <orgId>    publish a diagnostic.ping realtime event and print its nonce",
].join("\n");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type WorkerCommand =
  | { kind: "serve" }
  | { kind: "list" }
  | { kind: "help" }
  | { kind: "run"; job: WorkerJobName }
  | { kind: "emit-diagnostic"; organisationId: string }
  | { kind: "invalid"; message: string };

export function parseWorkerArgs(argv: readonly string[]): WorkerCommand {
  const [command, ...rest] = argv;
  const invalid = (message: string): WorkerCommand => ({ kind: "invalid", message });
  switch (command) {
    case undefined:
    case "serve":
      return rest.length === 0 ? { kind: "serve" } : invalid("serve takes no arguments");
    case "list":
      return rest.length === 0 ? { kind: "list" } : invalid("list takes no arguments");
    case "help":
    case "--help":
    case "-h":
      return { kind: "help" };
    case "run": {
      const [name, ...extra] = rest;
      if (!name) return invalid("run needs a job name (see `list`)");
      const job = findWorkerJob(name);
      if (!job) return invalid(`unknown job "${name}" (see \`list\`)`);
      if (extra.length > 0) return invalid("run takes exactly one job name");
      return { kind: "run", job: job.name };
    }
    case "emit-diagnostic": {
      const [organisationId, ...extra] = rest;
      if (!organisationId || !UUID.test(organisationId) || extra.length > 0) {
        return invalid("emit-diagnostic needs exactly one organisation id (a UUID)");
      }
      return { kind: "emit-diagnostic", organisationId: organisationId.toLowerCase() };
    }
    default:
      return invalid(`unknown command "${command}"`);
  }
}

/** `list` output: one tab-separated line per job. */
export function formatJobList(): string {
  return (
    WORKER_JOBS.map((job) =>
      [
        job.name,
        `every ${job.intervalMinutes} min`,
        `lane ${job.lane}`,
        `lock ${job.lockKey}`,
        job.description ?? "",
      ].join("\t"),
    ).join("\n") + "\n"
  );
}

/** A configuration problem the worker cannot run with (fatal, exit 1). Never contains a URL. */
export class WorkerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerConfigError";
  }
}

/**
 * The connection string of the advisory-lock session (D3): DIRECT_URL; in development without it,
 * DATABASE_URL with a warning. Required in production, and never a pooled URL (session locks leak
 * across PgBouncer backends).
 */
export function resolveLockConnection(
  config: Pick<Env, "DIRECT_URL" | "DATABASE_URL" | "isProduction">,
): { connectionString: string; warnings: string[] } {
  const warnings: string[] = [];
  if (!config.DIRECT_URL) {
    if (config.isProduction) {
      throw new WorkerConfigError(
        "DIRECT_URL is required for the worker in production: advisory locks and LISTEN need the direct (non-pooled) connection",
      );
    }
    warnings.push(
      "DIRECT_URL is not set: advisory locks use DATABASE_URL and realtime stays in-process (development only)",
    );
  }
  const connectionString = config.DIRECT_URL ?? config.DATABASE_URL;
  if (isPooledPostgresUrl(connectionString)) {
    throw new WorkerConfigError(
      config.DIRECT_URL
        ? "DIRECT_URL must be the direct (non-pooled) connection string: advisory locks and LISTEN do not work through PgBouncer"
        : "DATABASE_URL is a pooled connection string and DIRECT_URL is not set: set DIRECT_URL to the direct (non-pooled) connection string",
    );
  }
  return { connectionString, warnings };
}

/**
 * Whether `serve` runs jobs: WORKER_JOBS_ENABLED. The retired JOBS_ENABLED (Netlify era, where production
 * set it to "false" for an unrelated reason) is never a switch: "false" is a configuration error (exit 1)
 * so a value copied from the old site cannot silently stop every job while the heartbeat stays fresh;
 * "true" only warns (parseEnv).
 */
export function resolveJobsEnabled(
  config: Pick<Env, "WORKER_JOBS_ENABLED" | "JOBS_ENABLED">,
): boolean {
  if (config.JOBS_ENABLED === false) {
    throw new WorkerConfigError(
      "JOBS_ENABLED=false is a retired Netlify-era variable and no longer a switch: remove it (WORKER_JOBS_ENABLED=false pauses the jobs)",
    );
  }
  return config.WORKER_JOBS_ENABLED;
}

/** How long `serve` waits for the first push-leadership attempt before its first job pass. */
export const LEADER_SETTLE_TIMEOUT_MS = 8_000;

export interface StartAfterGateDeps {
  jobsEnabled: boolean;
  leader: Pick<PushLeader, "start">;
  trigger: Pick<MinuteTrigger, "start">;
  watchdog: Pick<Watchdog, "start">;
  heartbeat: Pick<HeartbeatLoop, "beatNow">;
  /** True once shutdown began (then nothing more starts). */
  isStopping: () => boolean;
  onJobsStarted: (at: number) => void;
  log: Logger;
  leaderSettleTimeoutMs?: number;
  clock?: () => number;
}

/**
 * Steps (5) and (6) of `serve`, after the migration gate: push leadership first — its first attempt
 * (self-test, then the lease) is awaited, bounded — so the immediate catch-up pass's OVERRIDE_EXPIRED /
 * SCHEDULE_CHANGED events reach a bridge when no other leader exists (cold start, ON_FAILURE restart);
 * then the minute trigger (immediate pass) and the watchdog; then a heartbeat with the new state.
 */
export async function startAfterMigrationGate(deps: StartAfterGateDeps): Promise<void> {
  const { log } = deps;
  const timeoutMs = deps.leaderSettleTimeoutMs ?? LEADER_SETTLE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    deps.leader.start().then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!settled) {
    log.warn({ timeoutMs }, "push leadership not settled yet; starting jobs anyway");
  }
  if (deps.isStopping()) return;

  if (deps.jobsEnabled) {
    deps.onJobsStarted((deps.clock ?? Date.now)());
    deps.trigger.start(true);
    deps.watchdog.start();
    log.info("jobs started");
  } else {
    log.warn(
      "WORKER_JOBS_ENABLED=false: no jobs will run (heartbeat and push leadership continue)",
    );
  }
  void deps.heartbeat.beatNow();
}

export interface WorkerCliDeps {
  /** Resolves once the text is written (so an exit right after never truncates it). */
  stdout: (text: string) => Promise<void>;
  stderr: (text: string) => Promise<void>;
  exit: (code: number) => void;
  loadEnv: () => Env;
  envWarnings: () => readonly string[];
  migrationStatus: () => Promise<MigrationStatus>;
  log: Logger;
}

function writeTo(stream: NodeJS.WriteStream): (text: string) => Promise<void> {
  return (text) =>
    new Promise((resolve) => {
      stream.write(text, () => resolve());
    });
}

function defaultDeps(): WorkerCliDeps {
  return {
    stdout: writeTo(process.stdout),
    stderr: writeTo(process.stderr),
    exit: (code) => process.exit(code),
    loadEnv: env,
    envWarnings,
    migrationStatus: async () => {
      const { prisma, getMigrationStatus } = await import("@clockoff/db");
      return getMigrationStatus(prisma);
    },
    log: childLogger({ module: "worker" }),
  };
}

/** Validated env, or null after reporting the problem (the caller exits 1). */
async function loadConfig(deps: WorkerCliDeps): Promise<Env | null> {
  let config: Env;
  try {
    config = deps.loadEnv();
  } catch (err) {
    deps.log.fatal({ error: errorSummary(err) }, "worker configuration invalid");
    // The env error lists every problem by variable name (never a value); the log line keeps only the
    // first line of a message, so the full list goes to stderr.
    await deps.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return null;
  }
  for (const warning of deps.envWarnings()) deps.log.warn({ warning }, "environment warning");
  return config;
}

async function lockConnection(
  config: Env,
  deps: WorkerCliDeps,
): Promise<{ connectionString: string } | null> {
  try {
    const resolved = resolveLockConnection(config);
    for (const warning of resolved.warnings)
      deps.log.warn({ warning }, "worker configuration warning");
    return resolved;
  } catch (err) {
    if (!(err instanceof WorkerConfigError)) throw err;
    deps.log.fatal({ error: errorSummary(err) }, "worker configuration invalid");
    await deps.stderr(`${err.message}\n`);
    return null;
  }
}

/** Flush and close what a one-shot command opened (bus NOTIFYs, detached tasks, Prisma). */
async function closeOneShotResources(log: Logger): Promise<void> {
  try {
    const [{ closeEventBus }, { settleBackgroundTasks }, { prisma }] = await Promise.all([
      import("@/server/events"),
      import("@/server/background"),
      import("@clockoff/db"),
    ]);
    await closeEventBus(5_000);
    await settleBackgroundTasks();
    await prisma.$disconnect();
  } catch (err) {
    log.warn({ error: errorSummary(err) }, "closing resources failed");
  }
}

function exitCodeFor(outcome: JobOutcome): number {
  if (outcome === "ok") return EXIT_CODES.ok;
  if (outcome === "skipped_locked") return EXIT_CODES.locked;
  return EXIT_CODES.error;
}

async function runJobCommand(name: WorkerJobName, deps: WorkerCliDeps): Promise<number> {
  const { log } = deps;
  const config = await loadConfig(deps);
  if (!config) return EXIT_CODES.error;
  const lock = await lockConnection(config, deps);
  if (!lock) return EXIT_CODES.error;

  let status: MigrationStatus;
  try {
    status = await deps.migrationStatus();
  } catch (err) {
    log.error({ error: errorSummary(err) }, "migration status unavailable");
    await deps.stderr("Could not read the migration status (is the database reachable?)\n");
    return EXIT_CODES.error;
  }
  if (status !== "up_to_date") {
    log.error({ status }, "migrations are not up to date: refusing to run a job");
    await deps.stderr(
      `Migrations are ${status}: run the web service's pre-deploy migration first\n`,
    );
    return EXIT_CODES.migrationsPending;
  }

  let configError = false;
  const locks = createAdvisoryLockSession({
    connectionString: lock.connectionString,
    applicationName: lockSessionApplicationName(workerIdentity().instanceId),
    log,
    onConfigError: () => {
      configError = true;
    },
  });
  const scheduler = createScheduler({ jobs: WORKER_JOBS, locks, log });
  try {
    const run = await scheduler.runOnce(name);
    await deps.stdout(
      `${JSON.stringify({
        job: name,
        outcome: run.outcome,
        durationMs: run.durationMs,
        ...(run.result?.details ? { details: run.result.details } : {}),
      })}\n`,
    );
    return configError ? EXIT_CODES.error : exitCodeFor(run.outcome);
  } finally {
    await locks.close();
    await closeOneShotResources(log);
  }
}

async function emitDiagnosticCommand(organisationId: string, deps: WorkerCliDeps): Promise<number> {
  const config = await loadConfig(deps);
  if (!config) return EXIT_CODES.error;
  if (!config.DIRECT_URL) {
    await deps.stderr(
      "emit-diagnostic needs DIRECT_URL: without it the realtime bus is in-process and the event would reach no other process\n",
    );
    return EXIT_CODES.error;
  }
  const { emitDiagnostic } = await import("./diagnostic");
  try {
    const result = await emitDiagnostic(organisationId);
    if (!result.ok) {
      await deps.stderr(
        result.reason === "UNKNOWN_ORGANISATION"
          ? "No organisation with that id\n"
          : "The organisation id must be a UUID\n",
      );
      return EXIT_CODES.usage;
    }
    deps.log.info({ organisationId, nonce: result.nonce }, "diagnostic event published");
    await deps.stdout(`${result.nonce}\n`);
    return EXIT_CODES.ok;
  } finally {
    await closeOneShotResources(deps.log);
  }
}

async function serve(deps: WorkerCliDeps): Promise<void> {
  const { log } = deps;
  // (1) Configuration.
  const config = await loadConfig(deps);
  if (!config) return deps.exit(EXIT_CODES.error);
  const lock = await lockConnection(config, deps);
  if (!lock) return deps.exit(EXIT_CODES.error);
  let jobsEnabled: boolean;
  try {
    jobsEnabled = resolveJobsEnabled(config);
  } catch (err) {
    if (!(err instanceof WorkerConfigError)) throw err;
    log.fatal({ error: errorSummary(err) }, "worker configuration invalid");
    await deps.stderr(`${err.message}\n`);
    return deps.exit(EXIT_CODES.error);
  }

  const [
    { prisma },
    events,
    { enablePushBridge, disablePushBridge },
    { settleBackgroundTasks },
    { markWorkerStopped },
  ] = await Promise.all([
    import("@clockoff/db"),
    import("@/server/events"),
    import("@/server/realtime/pushBridge"),
    import("@/server/background"),
    import("@/server/health/workerHeartbeat"),
  ]);

  process.on("uncaughtException", (err) => {
    log.fatal({ error: errorSummary(err), stack: stackFrames(err) }, "uncaught exception");
    deps.exit(EXIT_CODES.error);
  });
  process.on("unhandledRejection", (reason) => {
    log.fatal({ error: errorSummary(reason), stack: stackFrames(reason) }, "unhandled rejection");
    deps.exit(EXIT_CODES.error);
  });

  const identity = workerIdentity();
  const startedAt = new Date();
  const state = {
    stopping: false,
    waitingForMigrations: true,
    jobsStartedAt: null as number | null,
  };
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

  // Liveness (see the module comment): one ref'd handle for the whole of `serve`, cleared at shutdown.
  const keepAlive = setInterval(() => undefined, 60_000);
  process.on("beforeExit", (code) => {
    if (state.stopping) return;
    log.fatal(
      { code },
      "worker event loop drained unexpectedly; exiting so the platform restarts it",
    );
    deps.exit(EXIT_CODES.error);
  });

  const locks = createAdvisoryLockSession({
    connectionString: lock.connectionString,
    applicationName: lockSessionApplicationName(identity.instanceId),
    log: log.child({ component: "locks" }),
    onConfigError: (err) => {
      log.fatal({ error: errorSummary(err) }, "worker configuration invalid");
      deps.exit(EXIT_CODES.error);
    },
  });
  const scheduler = createScheduler({ jobs: WORKER_JOBS, locks, log });
  const leader = createPushLeader({
    locks,
    log: log.child({ component: "pushLeader" }),
    enable: (stillLeader) => enablePushBridge(events.getEventBus(), { stillLeader }),
    disable: (opts) => disablePushBridge(opts),
    selfTest: () => events.verifyEventBusDelivery(5_000),
  });
  const heartbeat = createHeartbeatLoop({
    identity,
    startedAt,
    log: log.child({ component: "heartbeat" }),
    details: () => ({
      jobsEnabled,
      waitingForMigrations: state.waitingForMigrations,
      jobsStartedAt: iso(state.jobsStartedAt),
      minuteLaneLastCompletedAt: iso(scheduler.minuteLaneLastCompletedAt()),
      pushLeader: leader.isLeader(),
      jobs: scheduler.lastRuns(),
    }),
  });
  const trigger = createMinuteTrigger((now) => void scheduler.onMinute(now));
  const watchdog = createWatchdog({
    lastProgressAt: () =>
      scheduler.minuteLaneLastCompletedAt() ?? state.jobsStartedAt ?? Date.now(),
    onStall: (stalledMs) => {
      log.fatal({ stalledMs, inFlight: scheduler.inFlight() }, "minute lane wedged");
      deps.exit(EXIT_CODES.error);
    },
  });
  const gate = new AbortController();

  const shutdown = createWorkerShutdown({
    log,
    graceMs: config.SHUTDOWN_GRACE_MS,
    stopTimers: async () => {
      state.stopping = true;
      clearInterval(keepAlive);
      trigger.stop();
      leader.stop();
      gate.abort();
      watchdog.stop();
      await heartbeat.stop();
    },
    handOverPushLeadership: (timeoutMs) => leader.handOver(timeoutMs),
    stopScheduler: (graceMs) => scheduler.stop(graceMs),
    markStopped: () => markWorkerStopped(identity.instanceId, new Date()),
    closeLocks: () => locks.close(),
    closeEventBus: (timeoutMs) => events.closeEventBus(timeoutMs),
    settleBackgroundTasks,
    disconnectDatabase: () => prisma.$disconnect(),
    exit: deps.exit,
  });
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  log.info(
    {
      instanceId: identity.instanceId,
      // Not `service`: the logger's base binding already uses that key ("clockoff-worker").
      railwayService: identity.service,
      version: identity.version,
      jobsEnabled,
      jobs: WORKER_JOBS.map((job) => job.name),
    },
    "worker starting",
  );

  // (2) Heartbeat, (3) event-bus listener, and an early lock-session connect (a pooled DIRECT_URL fails
  // here, not at the first job; a transient error is retried with backoff by the next lock call).
  heartbeat.start();
  events.startEventBusListener();
  locks.connect().catch((err: unknown) => {
    if (err instanceof DirectUrlPooledError) return;
    log.warn({ error: errorSummary(err) }, "advisory lock session not connected yet; will retry");
  });

  // (4) Migration gate.
  const ready = await waitForMigrations({
    status: deps.migrationStatus,
    log,
    signal: gate.signal,
    onWaiting: (waiting) => {
      state.waitingForMigrations = waiting;
    },
  });
  if (!ready || state.stopping) return;
  state.waitingForMigrations = false;

  // (5) Push leadership (first attempt awaited, bounded), (6) jobs.
  await startAfterMigrationGate({
    jobsEnabled,
    leader,
    trigger,
    watchdog,
    heartbeat,
    isStopping: () => state.stopping,
    onJobsStarted: (at) => {
      state.jobsStartedAt = at;
    },
    log,
  });
}

/** Entry point (`src/worker/main.ts`). `deps` replaces process I/O in tests. */
export async function runWorkerCli(
  argv: readonly string[],
  overrides: Partial<WorkerCliDeps> = {},
): Promise<void> {
  const deps: WorkerCliDeps = { ...defaultDeps(), ...overrides };
  const command = parseWorkerArgs(argv);
  try {
    switch (command.kind) {
      case "help":
        await deps.stdout(`${USAGE}\n`);
        return deps.exit(EXIT_CODES.ok);
      case "invalid":
        await deps.stderr(`${command.message}\n${USAGE}\n`);
        return deps.exit(EXIT_CODES.usage);
      case "list":
        await deps.stdout(formatJobList());
        return deps.exit(EXIT_CODES.ok);
      case "run":
        return deps.exit(await runJobCommand(command.job, deps));
      case "emit-diagnostic":
        return deps.exit(await emitDiagnosticCommand(command.organisationId, deps));
      case "serve":
        return await serve(deps);
    }
  } catch (err) {
    deps.log.fatal({ error: errorSummary(err), stack: stackFrames(err) }, "worker: fatal");
    deps.exit(EXIT_CODES.error);
  }
}
