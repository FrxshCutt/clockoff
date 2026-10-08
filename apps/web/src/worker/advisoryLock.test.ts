import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAdvisoryLockSession,
  DirectUrlPooledError,
  isSessionLostError,
  lockSessionApplicationName,
  type AdvisoryLockSession,
  type PgLikeClient,
} from "./advisoryLock";
import { captureLogger } from "./testing";

const URL = "postgresql://u:p@db.example.test:5432/clockoff?schema=public";
const KEY = 4849333701445681153n;

function statementError(code = "42P01"): Error {
  return Object.assign(new Error("relation does not exist"), { code, severity: "ERROR" });
}

/** Locks of one fake database shared by every fake client. */
class FakeDatabase {
  nextPid = 100;
  readonly locks = new Map<string, FakeClient>();
  readonly clients: FakeClient[] = [];
  /** Answer a different pid on every query (a transaction pooler). */
  pooled = false;
  connectError: Error | null = null;
}

class FakeClient implements PgLikeClient {
  readonly queries: Array<{ text: string; values?: unknown[] }> = [];
  ended = false;
  readonly pid: number;
  /** The next query rejects with this (once). */
  failNext: Error | null = null;
  private readonly listeners: { error: Array<(err: Error) => void>; end: Array<() => void> } = {
    error: [],
    end: [],
  };

  constructor(
    readonly config: pg.ClientConfig,
    private readonly db: FakeDatabase,
  ) {
    this.pid = db.nextPid++;
    db.clients.push(this);
  }

  async connect(): Promise<void> {
    if (this.db.connectError) throw this.db.connectError;
  }

  async query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> {
    this.queries.push({ text, values });
    if (this.ended) throw new Error("Client was closed and is not queryable");
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    const key = String(values?.[0]);
    if (text.includes("pg_backend_pid")) {
      return { rows: [{ pid: this.db.pooled ? this.db.nextPid++ : this.pid }] };
    }
    if (text.includes("pg_try_advisory_lock")) {
      const holder = this.db.locks.get(key);
      if (holder && holder !== this) return { rows: [{ locked: false }] };
      this.db.locks.set(key, this);
      return { rows: [{ locked: true }] };
    }
    if (text.includes("pg_advisory_unlock_all")) {
      for (const [k, holder] of this.db.locks) if (holder === this) this.db.locks.delete(k);
      return { rows: [{}] };
    }
    if (text.includes("pg_advisory_unlock")) {
      const held = this.db.locks.get(key) === this;
      if (held) this.db.locks.delete(key);
      return { rows: [{ unlocked: held }] };
    }
    return { rows: [] };
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  on(event: "error", listener: (err: Error) => void): this;
  on(event: "end", listener: () => void): this;
  on(event: "error" | "end", listener: ((err: Error) => void) | (() => void)): this {
    (this.listeners[event] as Array<typeof listener>).push(listener);
    return this;
  }

  /** The server ended this session (pg_terminate_backend, idle timeout, network). */
  drop(): void {
    for (const [k, holder] of this.db.locks) if (holder === this) this.db.locks.delete(k);
    for (const l of this.listeners.error)
      l(new Error("terminating connection due to administrator command"));
    for (const l of this.listeners.end) l();
  }
}

const sessions: AdvisoryLockSession[] = [];

function setup(options: { now?: () => number; pingIntervalMs?: number } = {}) {
  const db = new FakeDatabase();
  const captured = captureLogger();
  const onConfigError = vi.fn();
  const session = createAdvisoryLockSession({
    connectionString: URL,
    applicationName: lockSessionApplicationName("replica-1"),
    log: captured.log,
    clientFactory: (config) => new FakeClient(config, db),
    onConfigError,
    ...options,
  });
  sessions.push(session);
  return { db, session, captured, onConfigError, client: () => db.clients.at(-1)! };
}

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  vi.useRealTimers();
});

describe("createAdvisoryLockSession", () => {
  it("prepares the direct session, checks backend affinity, then locks with a ::bigint string parameter", async () => {
    const { session, client } = setup();
    expect(await session.tryAcquire(KEY)).toBe(true);
    const texts = client().queries.map((q) => q.text);
    expect(texts[0]).toMatch(/^SET idle_session_timeout = '120s'/);
    expect(texts[1]).toMatch(/^SET statement_timeout = '10s'/);
    expect(texts.slice(2, 4)).toEqual([
      "SELECT pg_backend_pid() AS pid",
      "SELECT pg_backend_pid() AS pid",
    ]);
    expect(client().queries[4]).toEqual({
      text: "SELECT pg_try_advisory_lock($1::bigint) AS locked",
      values: ["4849333701445681153"],
    });
    expect(session.isHeld(KEY)).toBe(true);
  });

  it("passes the direct-session client config with an application_name carrying the instance id (≤ 63 bytes)", async () => {
    const { session, client } = setup();
    await session.connect();
    expect(client().config.application_name).toBe("clockoff-worker-locks:replica-1");
    expect(client().config.query_timeout).toBe(10_000);
    expect(client().config.keepAliveInitialDelayMillis).toBe(10_000);
    expect(client().config.connectionString).not.toContain("schema=");

    const long = lockSessionApplicationName(`${"é".repeat(40)}-instance`);
    expect(long.startsWith("clockoff-worker-locks:")).toBe(true);
    expect(Buffer.byteLength(long, "utf8")).toBeLessThanOrEqual(63);
  });

  it("answers false for a key held by another session, and never stacks a second hold of its own key", async () => {
    const a = setup();
    const db = a.db;
    const b = createAdvisoryLockSession({
      connectionString: URL,
      applicationName: "b",
      log: a.captured.log,
      clientFactory: (config) => new FakeClient(config, db),
    });
    sessions.push(b);
    expect(await a.session.tryAcquire(KEY)).toBe(true);
    expect(await b.tryAcquire(KEY)).toBe(false);
    const queriesBefore = a.client().queries.length;
    expect(await a.session.tryAcquire(KEY)).toBe(false);
    expect(a.client().queries.length).toBe(queriesBefore);
    await a.session.release(KEY);
    expect(await b.tryAcquire(KEY)).toBe(true);
  });

  it("withLock releases on success and on throw", async () => {
    const { session, client } = setup();
    expect(await session.withLock(KEY, async () => 42)).toEqual({ acquired: true, value: 42 });
    expect(session.isHeld(KEY)).toBe(false);
    await expect(
      session.withLock(KEY, async () => {
        throw new Error("job failed");
      }),
    ).rejects.toThrow("job failed");
    expect(session.isHeld(KEY)).toBe(false);
    const unlocks = client().queries.filter((q) => q.text.startsWith("SELECT pg_advisory_unlock("));
    expect(unlocks).toHaveLength(2);
  });

  it("counts held keys as lost when the session drops, never unlocks them on the new session, and reconnects after backoff", async () => {
    let clock = 1_000_000;
    const { session, db, captured } = setup({ now: () => clock });
    expect(await session.tryAcquire(KEY)).toBe(true);
    const first = db.clients[0]!;

    first.drop();
    expect(session.isHeld(KEY)).toBe(false);
    expect(session.generation()).toBe(1);
    expect(first.ended).toBe(true);
    expect(captured.messages()).toContain("advisory lock session lost");

    await session.release(KEY); // no-op: the key died with its session
    expect(db.clients).toHaveLength(1);

    // Backoff: 1 s before the first reconnect.
    await expect(session.tryAcquire(KEY)).rejects.toThrow(/reconnecting/);
    clock += 1_000;
    expect(await session.tryAcquire(KEY)).toBe(true);
    const second = db.clients[1]!;
    expect(second).not.toBe(first);
    expect(second.queries.some((q) => q.text.startsWith("SELECT pg_advisory_unlock("))).toBe(false);
    expect(session.isHeld(KEY)).toBe(true);
  });

  it("treats a non-statement rejection (query timeout) as a lost session: client ended, never reused, keys lost", async () => {
    let clock = 0;
    const { session, db } = setup({ now: () => clock });
    expect(await session.tryAcquire(KEY)).toBe(true);
    const first = db.clients[0]!;
    first.failNext = new Error("Query read timeout");
    await expect(session.tryAcquire(KEY + 1n)).rejects.toThrow("Query read timeout");
    expect(first.ended).toBe(true);
    expect(session.isHeld(KEY)).toBe(false);

    clock += 1_000;
    expect(await session.tryAcquire(KEY + 1n)).toBe(true);
    expect(db.clients).toHaveLength(2);
    expect(first.queries.at(-1)?.text).toContain("pg_try_advisory_lock");
  });

  it("keeps the session after a statement error (SQLSTATE, severity ERROR)", async () => {
    const { session, db } = setup();
    expect(await session.tryAcquire(KEY)).toBe(true);
    db.clients[0]!.failNext = statementError("57014");
    await expect(session.tryAcquire(KEY + 1n)).rejects.toThrow();
    expect(session.isHeld(KEY)).toBe(true);
    expect(db.clients).toHaveLength(1);
    expect(isSessionLostError(statementError())).toBe(false);
    expect(isSessionLostError(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(
      isSessionLostError(
        Object.assign(new Error("terminating"), { code: "57P01", severity: "FATAL" }),
      ),
    ).toBe(true);
  });

  it("pings SELECT 1 every 30 s and treats a failed ping as a lost session", async () => {
    vi.useFakeTimers();
    const { session, db } = setup();
    await session.tryAcquire(KEY);
    const client = db.clients[0]!;
    await vi.advanceTimersByTimeAsync(29_999);
    expect(client.queries.filter((q) => q.text === "SELECT 1")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.queries.filter((q) => q.text === "SELECT 1")).toHaveLength(1);

    client.failNext = new Error("Connection terminated unexpectedly");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.ended).toBe(true);
    expect(session.isHeld(KEY)).toBe(false);
  });

  it("rejects a pooled URL (two different backend pids) with DirectUrlPooledError", async () => {
    const { session, db, onConfigError } = setup();
    db.pooled = true;
    await expect(session.tryAcquire(KEY)).rejects.toBeInstanceOf(DirectUrlPooledError);
    expect(onConfigError).toHaveBeenCalledTimes(1);
    expect(db.clients[0]!.ended).toBe(true);
  });

  it("a connect failure throws (job error) and backs off 1 s, 2 s, … before retrying", async () => {
    let clock = 0;
    const { session, db } = setup({ now: () => clock });
    db.connectError = new Error("connect ECONNREFUSED");
    await expect(session.tryAcquire(KEY)).rejects.toThrow("ECONNREFUSED");
    clock += 999;
    await expect(session.tryAcquire(KEY)).rejects.toThrow(/reconnecting/);
    clock += 1;
    await expect(session.tryAcquire(KEY)).rejects.toThrow("ECONNREFUSED");
    clock += 1_999;
    await expect(session.tryAcquire(KEY)).rejects.toThrow(/reconnecting/);
    clock += 1;
    db.connectError = null;
    expect(await session.tryAcquire(KEY)).toBe(true);
    expect(db.clients).toHaveLength(3);
  });

  it("close() unlocks everything, ends the client, and later calls reject", async () => {
    const { session, db } = setup();
    await session.tryAcquire(KEY);
    await session.close();
    const client = db.clients[0]!;
    expect(client.queries.at(-1)?.text).toBe("SELECT pg_advisory_unlock_all()");
    expect(client.ended).toBe(true);
    expect(db.locks.size).toBe(0);
    await expect(session.tryAcquire(KEY)).rejects.toThrow(/closed/);
  });
});
