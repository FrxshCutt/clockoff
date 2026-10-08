import pg from "pg";
import { errorSummary, type Logger } from "@/lib/logger";
import {
  isStatementError,
  pgClientConfig,
  prepareDirectSession,
  truncateApplicationName,
} from "@/server/db/pgDirect";

/**
 * Postgres session advisory locks for the worker (D3): ONE dedicated `pg.Client` per worker process on
 * DIRECT_URL (PgBouncer in transaction mode cannot hold a session lock: consecutive statements may run on
 * different backends). `pg_try_advisory_lock(key)` never waits; a key held by another instance answers
 * false (the job is skipped and logged), and a lock dies with its session, so a crashed worker frees its
 * keys.
 *
 * - **Zombie sessions.** Right after connect `prepareDirectSession()` sets `idle_session_timeout = '120s'`
 *   (+ a 10 s `statement_timeout`) and the session pings `SELECT 1` every 30 s: a live process never trips
 *   the timeout, while a vanished worker's backend (frozen container, no FIN) is ended by the server
 *   within ~2 min and its locks freed.
 * - **Lost session.** A rejection that is not a Postgres statement error (`isStatementError`: query
 *   timeout, socket error, `end`, a FATAL such as `pg_terminate_backend`) marks the session lost: the
 *   generation counter moves on, every held key counts as lost, the client is ended without awaiting and
 *   never reused (pg keeps a timed-out query active on it), and the next call reconnects with backoff
 *   (1 s × 2ⁿ, at most 30 s). Keys of an older generation are never unlocked on the new session.
 *   `onSessionLost` listeners run synchronously at that moment, so a holder (the push-bridge leader) can
 *   stand down at once instead of at its next poll of `isHeld`.
 * - **Session affinity.** After each connect `pg_backend_pid()` is read twice; two different pids mean
 *   the URL goes through a transaction pooler → `DirectUrlPooledError` (a configuration error: `serve`
 *   exits 1). A query error during the check is a lost session, not a configuration error.
 * - Session locks are re-entrant in Postgres, so this module never stacks a second hold of a key it
 *   already holds (or is acquiring): such a `tryAcquire` answers false.
 */

/** The subset of `pg.Client` this module uses (fakes implement it in tests). */
export interface PgLikeClient {
  connect(): Promise<unknown>;
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "end", listener: () => void): unknown;
}

export interface AdvisoryLockSession {
  tryAcquire(key: bigint): Promise<boolean>;
  release(key: bigint): Promise<void>;
  isHeld(key: bigint): boolean;
  withLock<T>(
    key: bigint,
    fn: () => Promise<T>,
  ): Promise<{ acquired: true; value: T } | { acquired: false }>;
  /** `pg_advisory_unlock_all()` and end the session; later calls reject. */
  close(): Promise<void>;
  /** Connect now (startup: surfaces a pooled DIRECT_URL early). Rejects like `tryAcquire`. */
  connect(): Promise<void>;
  /** Bumped every time the session is lost (diagnostics / tests). */
  generation(): number;
  /**
   * Called synchronously whenever the session is lost (after `isHeld` turned false for every key, never
   * after `close`). Returns the unsubscribe function. A throwing listener is logged and ignored.
   */
  onSessionLost(listener: (info: { generation: number; lostKeys: number }) => void): () => void;
}

/** The session-affinity check failed: DIRECT_URL goes through a transaction pooler (D3). */
export class DirectUrlPooledError extends Error {
  constructor() {
    super(
      "DIRECT_URL goes through a connection pooler (consecutive queries ran on different backends); " +
        "set it to the direct (non-pooled) connection string",
    );
    this.name = "DirectUrlPooledError";
  }
}

export interface AdvisoryLockSessionOptions {
  connectionString: string;
  /** `application_name` of the session (cut to 63 bytes), e.g. `clockoff-worker-locks:<instanceId>`. */
  applicationName: string;
  log: Logger;
  clientFactory?: (config: pg.ClientConfig) => PgLikeClient;
  /** Keep-alive ping interval (default 30 000 ms). */
  pingIntervalMs?: number;
  /** Runs right after connect (default `prepareDirectSession`: idle-session + statement timeouts). */
  prepareSession?: (client: PgLikeClient, log: Logger) => Promise<void>;
  /** Called once with the affinity-check failure (a configuration error; `serve` exits 1). */
  onConfigError?: (err: DirectUrlPooledError) => void;
  /** Clock for the reconnect backoff (tests). */
  now?: () => number;
}

export const LOCK_SESSION_PING_INTERVAL_MS = 30_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/** `clockoff-worker-locks:<instanceId>`, at most 63 bytes (Postgres truncates longer names). */
export function lockSessionApplicationName(instanceId: string): string {
  return truncateApplicationName(`clockoff-worker-locks:${instanceId}`);
}

/** Whether a query rejection means the session is gone (see the module comment). */
export function isSessionLostError(err: unknown): boolean {
  return !isStatementError(err);
}

function noop(): void {}

export function createAdvisoryLockSession(opts: AdvisoryLockSessionOptions): AdvisoryLockSession {
  const log = opts.log;
  const now = opts.now ?? Date.now;
  const pingIntervalMs = opts.pingIntervalMs ?? LOCK_SESSION_PING_INTERVAL_MS;
  const factory =
    opts.clientFactory ?? ((config: pg.ClientConfig) => new pg.Client(config) as PgLikeClient);
  const prepare = opts.prepareSession ?? prepareDirectSession;
  const applicationName = truncateApplicationName(opts.applicationName);

  let client: PgLikeClient | null = null;
  let connecting: Promise<PgLikeClient> | null = null;
  let generation = 0;
  /** key → generation it was acquired in. */
  const held = new Map<string, number>();
  const acquiring = new Set<string>();
  let failures = 0;
  let retryAt = 0;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  const lostListeners = new Set<(info: { generation: number; lostKeys: number }) => void>();

  function stopPing(): void {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  }

  function scheduleRetry(): void {
    failures += 1;
    retryAt = now() + Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
  }

  function markLost(lost: PgLikeClient, reason: string, err?: unknown): void {
    if (client !== lost) return;
    client = null;
    generation += 1;
    const lostKeys = held.size;
    held.clear();
    stopPing();
    lost.end().catch(noop);
    scheduleRetry();
    if (closed) return;
    log.warn(
      {
        reason,
        lostKeys,
        generation,
        ...(err !== undefined ? { error: errorSummary(err) } : {}),
      },
      "advisory lock session lost",
    );
    for (const listener of [...lostListeners]) {
      try {
        listener({ generation, lostKeys });
      } catch (listenerErr) {
        log.error(
          { error: errorSummary(listenerErr) },
          "advisory lock session-lost listener failed",
        );
      }
    }
  }

  async function run(
    c: PgLikeClient,
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }> {
    try {
      return await c.query(text, values);
    } catch (err) {
      if (isSessionLostError(err)) markLost(c, "query failed", err);
      throw err;
    }
  }

  function startPing(c: PgLikeClient): void {
    stopPing();
    let pinging = false;
    pingTimer = setInterval(() => {
      if (pinging || client !== c) return;
      pinging = true;
      c.query("SELECT 1")
        .catch((err: unknown) => {
          if (isSessionLostError(err)) markLost(c, "ping failed", err);
        })
        .finally(() => {
          pinging = false;
        });
    }, pingIntervalMs);
    pingTimer.unref?.();
  }

  async function open(): Promise<PgLikeClient> {
    const c = factory(pgClientConfig(opts.connectionString, applicationName));
    let established = false;
    c.on("error", (err) => {
      if (established) markLost(c, "client error", err);
    });
    c.on("end", () => {
      if (established) markLost(c, "connection ended");
    });
    try {
      await c.connect();
      await prepare(c, log);
      const first = await c.query("SELECT pg_backend_pid() AS pid");
      const second = await c.query("SELECT pg_backend_pid() AS pid");
      if (String(first.rows[0]?.pid) !== String(second.rows[0]?.pid)) {
        throw new DirectUrlPooledError();
      }
    } catch (err) {
      c.end().catch(noop);
      scheduleRetry();
      if (err instanceof DirectUrlPooledError) opts.onConfigError?.(err);
      throw err;
    }
    if (closed) {
      c.end().catch(noop);
      throw new Error("advisory lock session closed");
    }
    established = true;
    client = c;
    failures = 0;
    retryAt = 0;
    startPing(c);
    log.info({ generation }, "advisory lock session connected");
    return c;
  }

  async function ensureClient(): Promise<PgLikeClient> {
    if (closed) throw new Error("advisory lock session closed");
    if (client) return client;
    if (!connecting) {
      const wait = retryAt - now();
      if (wait > 0) {
        throw new Error(`advisory lock session reconnecting (next attempt in ${wait} ms)`);
      }
      connecting = open().finally(() => {
        connecting = null;
      });
    }
    return connecting;
  }

  function isHeld(key: bigint): boolean {
    return client !== null && held.get(key.toString()) === generation;
  }

  async function tryAcquire(key: bigint): Promise<boolean> {
    const k = key.toString();
    if (isHeld(key) || acquiring.has(k)) return false;
    acquiring.add(k);
    try {
      const c = await ensureClient();
      const gen = generation;
      const result = await run(c, "SELECT pg_try_advisory_lock($1::bigint) AS locked", [k]);
      if (gen !== generation || client !== c) {
        throw new Error("advisory lock session lost while acquiring");
      }
      const locked = result.rows[0]?.locked === true;
      if (locked) held.set(k, gen);
      return locked;
    } finally {
      acquiring.delete(k);
    }
  }

  async function release(key: bigint): Promise<void> {
    const k = key.toString();
    const gen = held.get(k);
    if (gen === undefined) return;
    held.delete(k);
    const c = client;
    // Lost with its session: the server already dropped it, and the new session never held it.
    if (!c || gen !== generation) return;
    try {
      const result = await run(c, "SELECT pg_advisory_unlock($1::bigint) AS unlocked", [k]);
      if (result.rows[0]?.unlocked !== true) {
        log.warn({ key: k }, "advisory unlock: the key was not held by this session");
      }
    } catch (err) {
      log.warn({ key: k, error: errorSummary(err) }, "advisory unlock failed");
    }
  }

  return {
    tryAcquire,
    release,
    isHeld,
    async withLock<T>(key: bigint, fn: () => Promise<T>) {
      if (!(await tryAcquire(key))) return { acquired: false } as const;
      try {
        return { acquired: true, value: await fn() } as const;
      } finally {
        await release(key);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      stopPing();
      const c = client;
      client = null;
      held.clear();
      if (connecting) await connecting.catch(noop);
      if (!c) return;
      try {
        await c.query("SELECT pg_advisory_unlock_all()");
      } catch (err) {
        log.warn({ error: errorSummary(err) }, "advisory lock session: unlock-all failed");
      }
      await c.end().catch(noop);
    },
    async connect() {
      await ensureClient();
    },
    generation: () => generation,
    onSessionLost(listener) {
      lostListeners.add(listener);
      return () => {
        lostListeners.delete(listener);
      };
    },
  };
}
