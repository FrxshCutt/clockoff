import { randomUUID } from "node:crypto";
import pg from "pg";
import { prisma } from "@clockoff/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  PostgresEventBus,
  type PostgresEventBusOptions,
  type RealtimeEvent,
} from "@/server/events";

/**
 * The cross-process realtime bus against a real Postgres (the test database; setup.ts points
 * DATABASE_URL at it). Two buses stand in for the web and worker processes: each has its own LISTEN
 * connection and NOTIFYs through the shared pooled Prisma client, exactly as in production. Every test
 * uses its own channel, so nothing leaks between tests or concurrent runs.
 */

const url = process.env.DATABASE_URL!;
const ORG = "11111111-1111-4111-8111-111111111111";
const buses: PostgresEventBus[] = [];

afterEach(async () => {
  await Promise.all(buses.splice(0).map((bus) => bus.close(3_000)));
});

function uniqueChannel(): string {
  return `clockoff_it_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function makeBus(
  channel: string,
  name: string,
  extra: Partial<PostgresEventBusOptions> = {},
): { bus: PostgresEventBus; seen: RealtimeEvent[]; applicationName: string } {
  const applicationName = `clockoff-it-${name}-${randomUUID().slice(0, 8)}`;
  const bus = new PostgresEventBus({
    connectionString: url,
    channel,
    applicationName,
    random: () => 0.5,
    ...extra,
  });
  buses.push(bus);
  const seen: RealtimeEvent[] = [];
  bus.subscribeAll((event) => seen.push(event));
  return { bus, seen, applicationName };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function backendPids(applicationName: string): Promise<number[]> {
  const rows = await prisma.$queryRaw<Array<{ pid: number }>>`
    SELECT pid FROM pg_stat_activity WHERE application_name = ${applicationName}`;
  return rows.map((row) => row.pid);
}

function event(employeeId: string, payload: Record<string, unknown> = {}): RealtimeEvent {
  return {
    type: "SCHEDULE_CHANGED",
    organisationId: ORG,
    employeeId,
    payload: { employeeId, ...payload },
    at: new Date().toISOString(),
  };
}

describe("PostgresEventBus (LISTEN/NOTIFY)", () => {
  it("carries events both ways between two processes, never back to the sender", async () => {
    const channel = uniqueChannel();
    const a = makeBus(channel, "a");
    const b = makeBus(channel, "b");
    // The self-test doubles as "listener is up": a nonce sent through the pooled path came back.
    expect(await a.bus.selfTest(5_000)).toBe(true);
    expect(await b.bus.selfTest(5_000)).toBe(true);

    const fromA = event("from-a");
    a.bus.publish(fromA);
    await waitFor(() => b.seen.length === 1);
    const fromB = event("from-b");
    b.bus.publish(fromB);
    await waitFor(() => a.seen.length === 2);
    await sleep(300); // room for any duplicate to show up

    expect(a.seen).toEqual([fromA, fromB]);
    expect(b.seen).toEqual([fromA, fromB]);
    expect(a.bus.diagnostics()).toMatchObject({ mode: "postgres", listening: true, received: 1 });
    expect(b.bus.diagnostics()).toMatchObject({ received: 1, notifySent: 1 });
  });

  it("delivers a 500-event burst complete and in order, in batched round trips", async () => {
    const channel = uniqueChannel();
    const a = makeBus(channel, "a");
    const b = makeBus(channel, "b");
    expect(await b.bus.selfTest(5_000)).toBe(true);

    const events = Array.from({ length: 500 }, (_, i) => event(`employee-${i}`, { n: i }));
    for (const e of events) a.bus.publish(e);
    await a.bus.flush(5_000);
    await waitFor(() => b.seen.length === 500, 10_000);

    expect(b.seen).toEqual(events);
    expect(a.bus.diagnostics()).toMatchObject({ notifySent: 500, notifyBatches: 3 });
  });

  it("delivers an oversize event truncated, keeping type, organisation, employee and time", async () => {
    const channel = uniqueChannel();
    const a = makeBus(channel, "a");
    const b = makeBus(channel, "b");
    expect(await b.bus.selfTest(5_000)).toBe(true);

    const big = event("big", { blob: "x".repeat(20_000) });
    a.bus.publish(big);
    await waitFor(() => b.seen.length === 1);
    expect(b.seen[0]).toEqual({
      type: big.type,
      organisationId: big.organisationId,
      employeeId: big.employeeId,
      payload: { truncated: true },
      at: big.at,
    });
    expect(a.bus.diagnostics().notifyTruncated).toBe(1);
  });

  it("reconnects after its backend is terminated and receives again", async () => {
    const channel = uniqueChannel();
    const a = makeBus(channel, "a");
    const b = makeBus(channel, "b");
    expect(await b.bus.selfTest(5_000)).toBe(true);

    const [pid] = await backendPids(b.applicationName);
    expect(pid).toBeTypeOf("number");
    await prisma.$queryRaw`SELECT pg_terminate_backend(${pid}::int)`;
    await waitFor(
      () => b.bus.diagnostics().listening && b.bus.diagnostics().reconnects === 1,
      10_000,
    );
    expect(await backendPids(b.applicationName)).not.toContain(pid);

    const after = event("after-reconnect");
    a.bus.publish(after);
    await waitFor(() => b.seen.length === 1);
    expect(b.seen).toEqual([after]);
  });

  it("prepares the listener session: 2 min idle-session timeout, 10 s statement timeout", async () => {
    const clients: pg.Client[] = [];
    const { bus } = makeBus(uniqueChannel(), "settings", {
      clientFactory: (config) => {
        const client = new pg.Client(config);
        clients.push(client);
        return client;
      },
    });
    expect(await bus.selfTest(5_000)).toBe(true);
    expect(clients).toHaveLength(1);
    const idle = await clients[0]!.query<{ idle_session_timeout: string }>(
      "SHOW idle_session_timeout",
    );
    const statement = await clients[0]!.query<{ statement_timeout: string }>(
      "SHOW statement_timeout",
    );
    expect(idle.rows[0]!.idle_session_timeout).toBe("2min");
    expect(statement.rows[0]!.statement_timeout).toBe("10s");
  });

  it("close() leaves no listener backend behind", async () => {
    const { bus, applicationName } = makeBus(uniqueChannel(), "close");
    expect(await bus.selfTest(5_000)).toBe(true);
    expect(await backendPids(applicationName)).toHaveLength(1);

    await bus.close(3_000);
    await waitFor(async () => (await backendPids(applicationName)).length === 0, 5_000);
    expect(bus.diagnostics().listening).toBe(false);
  });
});
