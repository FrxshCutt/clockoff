import { hostname } from "node:os";
import { errorSummary, type Logger } from "@/lib/logger";
import {
  pruneWorkerHeartbeats,
  recordWorkerHeartbeat,
  WORKER_HEARTBEAT_INTERVAL_MS,
  type WorkerHeartbeatInput,
} from "@/server/health/workerHeartbeat";

/**
 * The worker's identity and heartbeat loop (D4). The loop beats at start and then every 60 s on its own
 * timer — independent of the job lanes, so `/api/health` can tell "the process is alive" (heartbeat) from
 * "jobs are happening" (`worker.jobs`). A failed beat is logged and retried after 10 s, never fatal. Rows
 * older than 7 days are pruned at start and then hourly.
 *
 * Once `stop()` was called no further beat starts (a `beatNow` chained behind the beat in flight is
 * dropped), and `stop()` waits for every beat already started. A beat that still lands after the row was
 * marked stopped (the shutdown's step timeout gave up on it) cannot revive the row either:
 * `recordWorkerHeartbeat` never updates a stopped row of the same process start.
 */

export interface WorkerIdentity {
  /** `RAILWAY_REPLICA_ID`, else `<hostname>-<pid>` (≤ 128 chars). */
  instanceId: string;
  /** `RAILWAY_SERVICE_NAME`, else `worker` (≤ 64 chars). */
  service: string;
  /** First 12 characters of `RAILWAY_GIT_COMMIT_SHA`, else null. */
  version: string | null;
}

export function workerIdentity(
  source: Readonly<Record<string, string | undefined>> = process.env,
  host: string = hostname(),
  pid: number = process.pid,
): WorkerIdentity {
  const replica = source.RAILWAY_REPLICA_ID?.trim();
  const service = source.RAILWAY_SERVICE_NAME?.trim();
  const sha = source.RAILWAY_GIT_COMMIT_SHA?.trim();
  return {
    instanceId: (replica || `${host}-${pid}`).slice(0, 128),
    service: (service || "worker").slice(0, 64),
    version: sha ? sha.slice(0, 12) : null,
  };
}

export interface HeartbeatLoop {
  start(): void;
  /** Stop the timer and wait for a beat in flight. */
  stop(): Promise<void>;
  /**
   * Beat now (e.g. right after a state change worth reporting). A beat already in flight read its
   * details before the change, so a fresh beat follows it instead of sharing its result.
   */
  beatNow(): Promise<boolean>;
}

export interface HeartbeatLoopDeps {
  identity: WorkerIdentity;
  startedAt: Date;
  /** Current `details` (no PII: flags, counters, timestamps). */
  details: () => Record<string, unknown>;
  log: Logger;
  intervalMs?: number;
  retryMs?: number;
  pruneEveryMs?: number;
  /** Default `recordWorkerHeartbeat` (resolves false when the row was stopped by this process). */
  record?: (input: WorkerHeartbeatInput) => Promise<unknown>;
  prune?: typeof pruneWorkerHeartbeats;
  clock?: () => number;
}

export function createHeartbeatLoop(deps: HeartbeatLoopDeps): HeartbeatLoop {
  const intervalMs = deps.intervalMs ?? WORKER_HEARTBEAT_INTERVAL_MS;
  const retryMs = deps.retryMs ?? 10_000;
  const pruneEveryMs = deps.pruneEveryMs ?? 60 * 60 * 1000;
  const record = deps.record ?? recordWorkerHeartbeat;
  const prune = deps.prune ?? pruneWorkerHeartbeats;
  const clock = deps.clock ?? Date.now;
  const { log, identity } = deps;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let active = false;
  let inFlight: Promise<boolean> | null = null;
  /** `beatNow` calls waiting for the beat in flight to end before starting their own. */
  const chained = new Set<Promise<boolean>>();
  let failures = 0;
  let lastPruneAt: number | null = null;

  async function beatOnce(): Promise<boolean> {
    // A beat chained behind the one in flight (beatNow) starts later: never after stop().
    if (!active) return false;
    const now = new Date(clock());
    try {
      await record({
        instanceId: identity.instanceId,
        service: identity.service,
        version: identity.version,
        startedAt: deps.startedAt,
        now,
        details: deps.details(),
      });
    } catch (err) {
      failures += 1;
      // Every failure of a long outage would be noise: the first, then every 10th.
      if (failures === 1 || failures % 10 === 0) {
        log.warn({ failures, error: errorSummary(err) }, "worker heartbeat failed; retrying");
      }
      return false;
    }
    if (failures > 0) log.info({ failures }, "worker heartbeat recovered");
    else log.debug("worker heartbeat");
    failures = 0;
    if (lastPruneAt === null || now.getTime() - lastPruneAt >= pruneEveryMs) {
      lastPruneAt = now.getTime();
      try {
        const removed = await prune(now);
        if (removed > 0) log.info({ removed }, "pruned old worker heartbeats");
      } catch (err) {
        log.warn({ error: errorSummary(err) }, "pruning worker heartbeats failed");
      }
    }
    return true;
  }

  function beat(): Promise<boolean> {
    if (!inFlight) {
      inFlight = beatOnce().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  function loop(): void {
    void beat().then((ok) => {
      if (!active) return;
      timer = setTimeout(loop, ok ? intervalMs : retryMs);
      timer.unref?.();
    });
  }

  return {
    start() {
      if (active) return;
      active = true;
      loop();
    },
    async stop() {
      active = false;
      if (timer) clearTimeout(timer);
      timer = null;
      // A chained beat starts when the one in flight ends; wait until none is left.
      while (inFlight || chained.size > 0) {
        await Promise.all([inFlight, ...chained]);
      }
    },
    beatNow() {
      if (!active) return Promise.resolve(false);
      if (!inFlight) return beat();
      const next: Promise<boolean> = inFlight
        .then(() => (active ? beat() : false))
        .finally(() => {
          chained.delete(next);
        });
      chained.add(next);
      return next;
    },
  };
}
