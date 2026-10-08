import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "@/lib/logger";
import { pgClientConfig } from "@/server/db/pgDirect";
import {
  createAdvisoryLockSession,
  lockSessionApplicationName,
  type AdvisoryLockSession,
} from "@/worker/advisoryLock";
import { LOCK_KEYS } from "@/worker/lockKeys";

/**
 * Worker advisory locks against the real test database (D3): exclusivity across sessions, release,
 * a killed holder frees its key, and a vanished ("zombie") holder is ended by the server's
 * idle_session_timeout so a standby can take its lease.
 */

const log = createLogger({ level: "silent" });
const url = () => process.env.DATABASE_URL!;
const KEY = LOCK_KEYS.pushLeader;

const open: AdvisoryLockSession[] = [];
const rawClients: pg.Client[] = [];

function session(name: string): AdvisoryLockSession {
  const s = createAdvisoryLockSession({
    connectionString: url(),
    applicationName: lockSessionApplicationName(`test-${name}-${process.pid}`),
    log,
  });
  open.push(s);
  return s;
}

async function rawClient(applicationName: string): Promise<pg.Client> {
  const client = new pg.Client(pgClientConfig(url(), applicationName));
  client.on("error", () => undefined); // the server ends it on purpose below
  await client.connect();
  rawClients.push(client);
  return client;
}

async function waitFor<T>(fn: () => Promise<T>, accept: (v: T) => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => undefined as T);
    if (value !== undefined && accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
  for (const c of rawClients.splice(0)) await c.end().catch(() => undefined);
});

describe("worker advisory locks (Postgres)", () => {
  it("holds a key exclusively across sessions until released", async () => {
    const a = session("a");
    const b = session("b");
    expect(await a.tryAcquire(KEY)).toBe(true);
    expect(await b.tryAcquire(KEY)).toBe(false);
    expect(a.isHeld(KEY)).toBe(true);
    expect(b.isHeld(KEY)).toBe(false);

    const result = await b.withLock(KEY, async () => "never");
    expect(result).toEqual({ acquired: false });

    await a.release(KEY);
    expect(await b.tryAcquire(KEY)).toBe(true);
    expect(await a.tryAcquire(KEY)).toBe(false);
  });

  it("runs the session with the direct-session settings and its application_name", async () => {
    const appName = lockSessionApplicationName(`settings-${process.pid}`);
    let captured: pg.Client | null = null;
    const s = createAdvisoryLockSession({
      connectionString: url(),
      applicationName: appName,
      log,
      clientFactory: (config) => {
        captured = new pg.Client(config);
        return captured;
      },
    });
    open.push(s);
    await s.connect();
    const client = captured as pg.Client | null;
    expect(client).not.toBeNull();
    const idle = await client!.query<{ idle_session_timeout: string }>("SHOW idle_session_timeout");
    expect(idle.rows[0]?.idle_session_timeout).toBe("2min");
    const statement = await client!.query<{ statement_timeout: string }>("SHOW statement_timeout");
    expect(statement.rows[0]?.statement_timeout).toBe("10s");

    const probe = await rawClient("clockoff-test-probe");
    const rows = await probe.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1", [
      appName,
    ]);
    expect(rows.rowCount).toBe(1);
  });

  it("frees the key when the holder's backend is terminated, and the holder notices", async () => {
    const appName = lockSessionApplicationName(`victim-${process.pid}`);
    const victim = createAdvisoryLockSession({
      connectionString: url(),
      applicationName: appName,
      log,
    });
    open.push(victim);
    const standby = session("standby");
    expect(await victim.tryAcquire(KEY)).toBe(true);
    expect(await standby.tryAcquire(KEY)).toBe(false);

    const admin = await rawClient("clockoff-test-admin");
    const killed = await admin.query(
      "SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE application_name = $1",
      [appName],
    );
    expect(killed.rows[0]?.ok).toBe(true);

    await waitFor(
      () => standby.tryAcquire(KEY),
      (ok) => ok === true,
      5_000,
    );
    await waitFor(
      async () => victim.isHeld(KEY),
      (held) => held === false,
      5_000,
    );
    expect(victim.generation()).toBeGreaterThanOrEqual(1);
  });

  it("a vanished holder (zombie) is ended by idle_session_timeout and a standby takes the lease", async () => {
    // The production timeout is 120 s (prepareDirectSession); this differs only in the number.
    const zombie = await rawClient("clockoff-test-zombie");
    await zombie.query("SET idle_session_timeout = '1s'");
    const taken = await zombie.query("SELECT pg_try_advisory_lock($1::bigint) AS locked", [
      KEY.toString(),
    ]);
    expect(taken.rows[0]?.locked).toBe(true);
    // …and then it sends nothing (frozen container, no FIN).

    const standby = session("standby");
    expect(await standby.tryAcquire(KEY)).toBe(false);
    const started = Date.now();
    await waitFor(
      () => standby.tryAcquire(KEY),
      (ok) => ok === true,
      6_000,
    );
    expect(Date.now() - started).toBeLessThan(6_000);
  });

  it("close() releases every key of the session", async () => {
    const a = session("a");
    const b = session("b");
    expect(await a.tryAcquire(LOCK_KEYS.workModeTick)).toBe(true);
    expect(await a.tryAcquire(LOCK_KEYS.overrideExpiry)).toBe(true);
    await a.close();
    expect(await b.tryAcquire(LOCK_KEYS.workModeTick)).toBe(true);
    expect(await b.tryAcquire(LOCK_KEYS.overrideExpiry)).toBe(true);
  });
});
