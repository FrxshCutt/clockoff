import { errorSummary, type Logger } from "@/lib/logger";
import type { AdvisoryLockSession } from "./advisoryLock";
import { LOCK_KEYS } from "./lockKeys";

/**
 * Push-bridge leadership (D6). Events now reach every process over LISTEN/NOTIFY, so bridging them into
 * silent pushes anywhere but ONE process would send duplicates: only the worker holding the lease key
 * (`LOCK_KEYS.pushLeader`, a session advisory lock) enables the bridge; web never bridges.
 *
 * - Leadership is competed for only once the bus delivery self-test passed (`selfTest`, retried every
 *   30 s): a worker whose LISTEN cannot hear NOTIFYs would bridge nothing.
 * - Every 5 s a standby retries `pg_try_advisory_lock` (`push bridge standby` logged once per
 *   transition, retries at debug).
 * - Losing the lease: the lock session's `onSessionLost` fires the moment the session is known to be gone
 *   (a resumed zombie, a terminated backend, a network blip); the leader stands down AT ONCE — `push
 *   bridge leadership lost`, bridge disabled WITHOUT flushing (another worker may already be leading and
 *   bridging the same events) — and competes again on the next 5 s tick. The 5 s tick's `isHeld` check is
 *   the fallback. The bridge itself also checks `stillLeader` (the lease is held) before every lookup and
 *   send, so nothing is pushed after the loss even before the disable ran.
 * - `start()` resolves once the first self-test attempt and, when it passed, the first lease attempt
 *   have settled (leader or standby): the worker awaits it (bounded) before its first job pass, so the
 *   events of that pass reach a bridge when no other leader exists (cold start, restart).
 * - Shutdown hands over FIRST (`handOver`: disable with flush, then release the lease), so a standby
 *   takes over within ~5 s instead of after the old worker's whole drain.
 */

export const PUSH_LEASE_INTERVAL_MS = 5_000;
export const SELF_TEST_RETRY_MS = 30_000;

export interface PushLeader {
  /**
   * Start the self-test loop, then the lease loop. Resolves when the first self-test attempt and (if it
   * passed) the first lease attempt have settled; never rejects.
   */
  start(): Promise<void>;
  /** Stop all timers (no hand-over). */
  stop(): void;
  isLeader(): boolean;
  /** Shutdown: stop timers, wait for a lease tick in flight, and if leading disable + release. */
  handOver(disableTimeoutMs?: number): Promise<void>;
}

export interface PushLeaderDeps {
  locks: AdvisoryLockSession;
  log: Logger;
  /**
   * `enablePushBridge(getEventBus(), { stillLeader })` — idempotent. `stillLeader` answers whether the
   * lease is still held by this session.
   */
  enable: (stillLeader: () => boolean) => void;
  /** `disablePushBridge({ flush })`. */
  disable: (opts: { flush: boolean }) => Promise<void>;
  /** `verifyEventBusDelivery(5000)`. */
  selfTest: () => Promise<boolean>;
  lockKey?: bigint;
  intervalMs?: number;
  selfTestRetryMs?: number;
}

function withTimeout(promise: Promise<void>, ms: number): Promise<"done" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.then(() => "done" as const),
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function createPushLeader(deps: PushLeaderDeps): PushLeader {
  const { locks, log } = deps;
  const lockKey = deps.lockKey ?? LOCK_KEYS.pushLeader;
  const intervalMs = deps.intervalMs ?? PUSH_LEASE_INTERVAL_MS;
  const selfTestRetryMs = deps.selfTestRetryMs ?? SELF_TEST_RETRY_MS;
  const stillLeader = () => locks.isHeld(lockKey);

  let leader = false;
  let stopped = true;
  let selfTestPassed = false;
  let selfTestTimer: ReturnType<typeof setTimeout> | null = null;
  let leaseTimer: ReturnType<typeof setInterval> | null = null;
  let tickInFlight: Promise<void> | null = null;
  /** Disables started by a lost lease (awaited by `handOver`). */
  const standingDown = new Set<Promise<void>>();
  /** Last state logged at info, so standby is logged once per transition. */
  let announced: "leader" | "standby" | null = null;

  /** The lease is gone: stop bridging now and drop what is queued (another worker may be leading). */
  function standDown(reason: "session lost" | "lease not held"): void {
    if (!leader) return;
    leader = false;
    announced = null;
    log.warn({ reason }, "push bridge leadership lost");
    const disabling = deps
      .disable({ flush: false })
      .catch((err: unknown) => {
        log.warn({ error: errorSummary(err) }, "push bridge disable failed");
      })
      .finally(() => {
        standingDown.delete(disabling);
      });
    standingDown.add(disabling);
  }

  const unsubscribeLost = locks.onSessionLost(() => standDown("session lost"));

  async function leaseTick(): Promise<void> {
    if (stopped) return;
    if (leader) {
      if (locks.isHeld(lockKey)) return;
      standDown("lease not held");
    }
    if (standingDown.size > 0) await Promise.all([...standingDown]);
    if (stopped) return;
    let acquired = false;
    try {
      acquired = await locks.tryAcquire(lockKey);
    } catch (err) {
      log.debug({ error: errorSummary(err) }, "push bridge lease: lock session unavailable");
    }
    if (stopped) {
      if (acquired) await locks.release(lockKey);
      return;
    }
    if (acquired) {
      leader = true;
      announced = "leader";
      deps.enable(stillLeader);
      log.info("push bridge leader acquired");
    } else if (announced !== "standby") {
      announced = "standby";
      log.info("push bridge standby");
    } else {
      log.debug("push bridge standby: lease held elsewhere");
    }
  }

  function runLeaseTick(): Promise<void> {
    if (tickInFlight) return tickInFlight;
    tickInFlight = leaseTick()
      .catch((err: unknown) => {
        log.error({ error: errorSummary(err) }, "push bridge lease tick failed");
      })
      .finally(() => {
        tickInFlight = null;
      });
    return tickInFlight;
  }

  /** Arms the lease timer and returns the first tick. */
  function startLease(): Promise<void> {
    if (stopped || leaseTimer) return Promise.resolve();
    const first = runLeaseTick();
    leaseTimer = setInterval(() => void runLeaseTick(), intervalMs);
    leaseTimer.unref?.();
    return first;
  }

  async function trySelfTest(): Promise<void> {
    if (stopped) return;
    let ok = false;
    try {
      ok = await deps.selfTest();
    } catch (err) {
      log.error({ error: errorSummary(err) }, "event bus self-test failed");
    }
    if (stopped) return;
    if (ok) {
      selfTestPassed = true;
      log.info("event bus self-test passed: competing for push bridge leadership");
      await startLease();
      return;
    }
    log.error(
      { retryInMs: selfTestRetryMs },
      "event bus self-test failed: NOTIFY did not come back on LISTEN; not competing for push leadership",
    );
    selfTestTimer = setTimeout(() => void trySelfTest(), selfTestRetryMs);
    selfTestTimer.unref?.();
  }

  function stopTimers(): void {
    stopped = true;
    if (selfTestTimer) clearTimeout(selfTestTimer);
    if (leaseTimer) clearInterval(leaseTimer);
    selfTestTimer = null;
    leaseTimer = null;
  }

  return {
    start() {
      if (!stopped) return Promise.resolve();
      stopped = false;
      return selfTestPassed ? startLease() : trySelfTest();
    },
    stop: stopTimers,
    isLeader: () => leader,
    async handOver(disableTimeoutMs = 5_000) {
      stopTimers();
      unsubscribeLost();
      if (tickInFlight) await tickInFlight;
      if (standingDown.size > 0) await Promise.all([...standingDown]);
      if (!leader) return;
      leader = false;
      const result = await withTimeout(
        deps.disable({ flush: true }).catch((err: unknown) => {
          log.warn({ error: errorSummary(err) }, "push bridge disable failed");
        }),
        disableTimeoutMs,
      );
      if (result === "timeout") log.warn({ disableTimeoutMs }, "push bridge flush timed out");
      await locks.release(lockKey);
      log.info("push bridge leadership handed over");
    },
  };
}
