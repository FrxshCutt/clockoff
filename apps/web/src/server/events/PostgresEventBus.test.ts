import { EventEmitter } from "node:events";
import type { ClientConfig } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "@/lib/logger";
import type { RealtimeEvent } from "./EventBus";
import { decodeEnvelope, encodeEnvelope } from "./envelope";
import {
  eventBusDiagnostics,
  closeEventBus,
  flushEventBus,
  setEventBusForTesting,
  startEventBusListener,
  verifyEventBusDelivery,
} from "./index";
import {
  PostgresEventBus,
  REALTIME_NOTIFY_CHANNEL,
  type ListenerClient,
  type PostgresEventBusOptions,
} from "./PostgresEventBus";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "33333333-3333-4333-8333-333333333333";
const ORIGIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REMOTE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AT = "2026-10-08T09:00:00.000Z";

/** In-memory stand-in for `pg.Client`: records queries, emits what a test tells it to. */
class FakeClient extends EventEmitter implements ListenerClient {
  readonly queries: string[] = [];
  ended = false;
  connectImpl: () => Promise<void> = async () => undefined;
  queryImpl: (text: string) => Promise<unknown> = async () => ({});

  constructor(readonly config: ClientConfig) {
    super();
  }

  connect(): Promise<void> {
    return this.connectImpl();
  }

  async query(text: string): Promise<unknown> {
    if (this.ended) throw new Error("Client was closed and is not queryable");
    this.queries.push(text);
    return this.queryImpl(text);
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  deliver(channel: string, payload: string): void {
    this.emit("notification", { channel, payload });
  }
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function fakeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger & Record<"info" | "warn" | "error" | "debug", ReturnType<typeof vi.fn>>;
}

function scheduleChanged(employeeId: string, organisationId = ORG): RealtimeEvent {
  return {
    type: "SCHEDULE_CHANGED",
    organisationId,
    employeeId,
    payload: { employeeId, shiftIds: ["s1"], reason: "UPDATED" },
    at: AT,
  };
}

function setup(options: Partial<PostgresEventBusOptions> = {}) {
  const clients: FakeClient[] = [];
  const created: number[] = [];
  const sent: Array<{ channel: string; payloads: string[] }> = [];
  const notify =
    options.notify ??
    vi.fn(async (channel: string, payloads: string[]) => {
      sent.push({ channel, payloads });
    });
  const log = fakeLog();
  const prepare = options.clientFactory;
  const bus = new PostgresEventBus({
    connectionString: "postgresql://u:p@localhost:5433/clockoff?schema=public",
    applicationName: "clockoff-test-events",
    originId: ORIGIN,
    random: () => 0.5,
    log,
    notify,
    ...options,
    clientFactory: (config) => {
      created.push(Date.now());
      const client = prepare ? (prepare(config) as FakeClient) : new FakeClient(config);
      clients.push(client);
      return client;
    },
  });
  const current = () => clients.at(-1)!;
  return { bus, clients, created, sent, notify, log, current };
}

/** Lets pending microtasks (connect → SET → LISTEN chains, drain loops) run under fake timers. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  setEventBusForTesting(undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PostgresEventBus — publish", () => {
  it("delivers to local subscribers synchronously and NOTIFYs one envelope", async () => {
    const { bus, sent } = setup();
    const handler = vi.fn();
    bus.subscribe(ORG, handler);
    const event = scheduleChanged("e1");
    bus.publish(event);
    expect(handler).toHaveBeenCalledExactlyOnceWith(event);
    expect(sent).toHaveLength(0); // sent on a microtask, so a synchronous burst shares a round trip

    await bus.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.channel).toBe(REALTIME_NOTIFY_CHANNEL);
    expect(sent[0]!.payloads.map((p) => decodeEnvelope(p))).toEqual([{ originId: ORIGIN, event }]);
    expect(bus.diagnostics()).toMatchObject({ notifySent: 1, notifyBatches: 1 });
  });

  it("keeps one round trip in flight at a time, in order, at most batchSize envelopes each", async () => {
    let active = 0;
    let maxActive = 0;
    const gates: Deferred[] = [];
    const calls: string[][] = [];
    const notify = vi.fn(async (_channel: string, payloads: string[]) => {
      active++;
      maxActive = Math.max(maxActive, active);
      calls.push(payloads.map((p) => decodeEnvelope(p)!.event.employeeId!));
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      active--;
    });
    const { bus } = setup({ notify, batchSize: 3 });

    bus.publish(scheduleChanged("e1"));
    await settle();
    expect(calls).toEqual([["e1"]]);
    for (let i = 2; i <= 8; i++) bus.publish(scheduleChanged(`e${i}`));
    await settle();
    expect(calls).toHaveLength(1); // still blocked on the first round trip

    for (let i = 0; i < 4; i++) {
      gates[i]!.resolve();
      await settle();
    }
    await bus.flush();
    expect(calls).toEqual([["e1"], ["e2", "e3", "e4"], ["e5", "e6", "e7"], ["e8"]]);
    expect(maxActive).toBe(1);
    expect(bus.diagnostics()).toMatchObject({ notifySent: 8, notifyBatches: 4 });
  });

  it("drops (and counts) a batch whose round trip fails, without affecting local delivery", async () => {
    const notify = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const { bus, log } = setup({ notify });
    const handler = vi.fn();
    bus.subscribe(ORG, handler);
    bus.publish(scheduleChanged("e1"));
    bus.publish(scheduleChanged("e2"));
    await bus.flush();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(bus.diagnostics()).toMatchObject({ notifySent: 0, notifyDropped: 2 });
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ count: 2 }),
      "realtime notify failed; batch dropped",
    );
  });

  it("sends an oversize event truncated", async () => {
    const { bus, sent } = setup();
    bus.publish({ ...scheduleChanged("e1"), payload: { blob: "x".repeat(10_000) } });
    await bus.flush();
    const decoded = decodeEnvelope(sent[0]!.payloads[0]!)!;
    expect(decoded.event).toMatchObject({ employeeId: "e1", payload: { truncated: true } });
    expect(bus.diagnostics().notifyTruncated).toBe(1);
  });

  it("coalesces an overflow per organisation and type, never dropping push-bridge events", async () => {
    const gate = deferred();
    const calls: string[][] = [];
    const notify = vi.fn(async (_channel: string, payloads: string[]) => {
      calls.push(payloads);
      if (calls.length === 1) await gate.promise;
    });
    const { bus, log } = setup({ notify });

    bus.publish(scheduleChanged("warm-up", OTHER_ORG));
    await settle(); // the first round trip is now blocked
    const employees = Array.from({ length: 2_500 }, (_, i) => `employee-${i}`);
    for (const id of employees) bus.publish(scheduleChanged(id));
    expect(bus.diagnostics().notifyCoalesced).toBeGreaterThan(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ coalesced: expect.any(Number) }),
      "realtime notify queue overflow; coalesced into organisation-wide events",
    );

    gate.resolve();
    await bus.flush();
    expect(calls.length).toBeLessThanOrEqual(10 + 1);

    const delivered = calls
      .slice(1)
      .flat()
      .map((p) => decodeEnvelope(p)!.event);
    const orgWide = delivered.some(
      (e) =>
        e.type === "SCHEDULE_CHANGED" &&
        e.organisationId === ORG &&
        e.employeeId === undefined &&
        e.payload.truncated === true,
    );
    const own = new Set(delivered.map((e) => e.employeeId).filter(Boolean));
    for (const id of employees) expect(own.has(id) || orgWide).toBe(true);
    expect(orgWide).toBe(true);
    expect(bus.diagnostics().notifyDropped).toBe(0);
  });

  it("drops the oldest non-push events once coalescing cannot bring the queue under the cap", async () => {
    const gate = deferred();
    let calls = 0;
    const notify = vi.fn(async () => {
      calls++;
      if (calls === 1) await gate.promise;
    });
    const { bus } = setup({ notify, maxPending: 50 });
    const orgs = Array.from({ length: 60 }, (_, i) => `org-${i}`);

    bus.publish(scheduleChanged("warm-up"));
    await settle();
    // Distinct organisations: nothing to coalesce.
    for (const org of orgs) {
      bus.publish({ type: "activity.recorded", organisationId: org, payload: {}, at: AT });
    }
    expect(bus.diagnostics()).toMatchObject({ notifyDropped: 10, notifyCoalesced: 0 });

    // Push-bridge kinds are kept even above the cap.
    for (const org of orgs) bus.publish(scheduleChanged("e1", `push-${org}`));
    expect(bus.diagnostics().notifyDropped).toBe(60);
    gate.resolve();
    await bus.flush();
    expect(bus.diagnostics().notifySent).toBe(1 + 60); // warm-up + every push-bridge event
  });

  it("drops (and logs) an event that cannot fit even truncated", async () => {
    const { bus, sent, log } = setup();
    bus.publish({ ...scheduleChanged("e1"), type: "x".repeat(8_000) });
    await bus.flush();
    expect(sent).toHaveLength(0);
    expect(bus.diagnostics().notifyDropped).toBe(1);
    expect(log.error).toHaveBeenCalled();
  });
});

describe("PostgresEventBus — listener", () => {
  it("connects lazily, prepares the direct session, then LISTENs", async () => {
    const { bus, clients, current } = setup();
    expect(clients).toHaveLength(0);
    bus.subscribe(ORG, () => undefined);
    bus.subscribeAll(() => undefined);
    await settle();
    expect(clients).toHaveLength(1);
    expect(current().queries).toEqual([
      "SET idle_session_timeout = '120s'",
      "SET statement_timeout = '10s'",
      `LISTEN "${REALTIME_NOTIFY_CHANNEL}"`,
    ]);
    expect(current().config).toMatchObject({
      application_name: "clockoff-test-events",
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      query_timeout: 10_000,
      connectionString: "postgresql://u:p@localhost:5433/clockoff",
    });
    expect(bus.diagnostics().listening).toBe(true);
  });

  it("delivers a remote event once to the organisation's and the all-organisations subscribers", async () => {
    const { bus, current } = setup();
    const orgHandler = vi.fn();
    const allHandler = vi.fn();
    const otherHandler = vi.fn();
    bus.subscribe(ORG, orgHandler);
    bus.subscribe(OTHER_ORG, otherHandler);
    bus.subscribeAll(allHandler);
    await settle();

    const event = scheduleChanged("e1");
    current().deliver(REALTIME_NOTIFY_CHANNEL, encodeEnvelope(REMOTE, event)!.payload);
    expect(orgHandler).toHaveBeenCalledExactlyOnceWith(event);
    expect(allHandler).toHaveBeenCalledExactlyOnceWith(event);
    expect(otherHandler).not.toHaveBeenCalled();
    expect(bus.diagnostics().received).toBe(1);
  });

  it("ignores its own notifications, malformed ones and other channels", async () => {
    const { bus, current, log } = setup();
    const handler = vi.fn();
    bus.subscribeAll(handler);
    await settle();

    // Published here: delivered locally once; its NOTIFY echo must not deliver it again.
    const event = scheduleChanged("e1");
    bus.publish(event);
    current().deliver(REALTIME_NOTIFY_CHANNEL, encodeEnvelope(ORIGIN, event)!.payload);
    current().deliver(REALTIME_NOTIFY_CHANNEL, "{not json");
    current().deliver("some_other_channel", encodeEnvelope(REMOTE, event)!.payload);
    expect(handler).toHaveBeenCalledOnce();
    expect(bus.diagnostics().received).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.anything(),
      "malformed realtime notification dropped",
    );
  });

  it("reconnects with backoff 1, 2, 4 … capped at 30 s, and resets once listening again", async () => {
    const { bus, clients, created, current } = setup({
      clientFactory: (config) => {
        const client = new FakeClient(config);
        // The first seven connection attempts fail.
        if (clients.length < 7) {
          client.connectImpl = async () => {
            throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
          };
        }
        return client;
      },
    });
    bus.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(clients).toHaveLength(8);
    const gaps = created.slice(1).map((t, i) => t - created[i]!);
    expect(gaps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    expect(bus.diagnostics().listening).toBe(true);
    expect(clients.slice(0, 7).every((c) => c.ended)).toBe(true);

    // Reset: the next loss retries after 1 s again.
    const before = created.length;
    current().emit("error", new Error("terminating connection due to administrator command"));
    expect(bus.diagnostics().listening).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(created).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(created).toHaveLength(before + 1);
    await settle();
    expect(bus.diagnostics()).toMatchObject({ listening: true, reconnects: 1 });
  });

  it("keeps every retry delay within ±20 % jitter", async () => {
    for (const r of [0, 1]) {
      const { bus, clients, created } = setup({
        random: () => r,
        clientFactory: (config) => {
          const client = new FakeClient(config);
          client.connectImpl = async () => {
            throw new Error("down");
          };
          return client;
        },
      });
      bus.start();
      await vi.advanceTimersByTimeAsync(200_000);
      const gaps = created.slice(1).map((t, i) => t - created[i]!);
      const factor = r === 0 ? 0.8 : 1.2;
      const expected = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000].map((ms) =>
        Math.round(ms * factor),
      );
      expect(gaps.slice(0, expected.length)).toEqual(expected);
      expect(clients.length).toBeGreaterThan(expected.length);
      await bus.close();
    }
  });

  it("treats a failed or hanging ping as a lost connection", async () => {
    const { bus, clients, current } = setup();
    bus.start();
    await settle();
    const first = current();

    first.queryImpl = async (text) => {
      if (text === "SELECT 1") throw new Error("Connection terminated unexpectedly");
      return {};
    };
    await vi.advanceTimersByTimeAsync(30_000);
    expect(first.queries).toContain("SELECT 1");
    expect(first.ended).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(clients).toHaveLength(2);
    expect(bus.diagnostics().listening).toBe(true);

    // A ping that never answers is abandoned after 10 s.
    const second = current();
    second.queryImpl = (text) =>
      text === "SELECT 1" ? new Promise(() => undefined) : Promise.resolve({});
    await vi.advanceTimersByTimeAsync(30_000);
    expect(second.ended).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(second.ended).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(clients).toHaveLength(3);
  });

  it("survives late errors from a discarded client", async () => {
    const { bus, current } = setup();
    bus.start();
    await settle();
    const old = current();
    old.emit("end");
    expect(() => old.emit("error", new Error("late"))).not.toThrow();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(current()).not.toBe(old);
  });

  it("retries when the client cannot even be created", async () => {
    let attempts = 0;
    const { bus, clients } = setup({
      clientFactory: (config) => {
        attempts++;
        if (attempts === 1) throw new Error("bad config");
        return new FakeClient(config);
      },
    });
    bus.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(clients).toHaveLength(1);
    expect(bus.diagnostics().listening).toBe(true);
  });
});

describe("PostgresEventBus — self-test", () => {
  it("is true when the nonce comes back on the listener, and UNLISTENs", async () => {
    const { bus, current } = setup({
      notify: async (channel, payloads) => {
        // Postgres would deliver this to the session LISTENing on the channel.
        if (channel.startsWith("clockoff_selftest_")) current().deliver(channel, payloads[0]!);
      },
    });
    expect(bus.selfTestChannel).toBe(`clockoff_selftest_${ORIGIN.replace(/-/g, "")}`);
    const result = bus.selfTest(5_000);
    await settle();
    await expect(result).resolves.toBe(true);
    const channel = `"${bus.selfTestChannel}"`;
    expect(current().queries).toEqual(
      expect.arrayContaining([`LISTEN ${channel}`, `UNLISTEN ${channel}`]),
    );
    expect(vi.getTimerCount()).toBe(1); // only the listener's ping interval remains
  });

  it("is false after the timeout when nothing arrives, and still UNLISTENs", async () => {
    const { bus, current } = setup({ notify: async () => undefined });
    const result = bus.selfTest(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toBe(false);
    expect(current().queries).toContain(`UNLISTEN "${bus.selfTestChannel}"`);
  });

  it("is false when the listener never comes up", async () => {
    const { bus } = setup({
      clientFactory: (config) => {
        const client = new FakeClient(config);
        client.connectImpl = () => new Promise(() => undefined);
        return client;
      },
    });
    const result = bus.selfTest(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toBe(false);
  });
});

describe("PostgresEventBus — close", () => {
  it("drains the queue, UNLISTENs, ends the connection and clears every timer; later publishes stay local", async () => {
    const { bus, sent, current, notify } = setup();
    const handler = vi.fn();
    bus.subscribe(ORG, handler);
    await settle();
    bus.publish(scheduleChanged("e1"));
    bus.publish(scheduleChanged("e2"));

    await bus.close();
    expect(sent.flatMap((s) => s.payloads)).toHaveLength(2);
    expect(current().queries.at(-1)).toBe("UNLISTEN *");
    expect(current().ended).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(bus.diagnostics().listening).toBe(false);

    const calls = vi.mocked(notify).mock.calls.length;
    bus.publish(scheduleChanged("e3"));
    await settle();
    expect(handler).toHaveBeenCalledTimes(3);
    expect(vi.mocked(notify).mock.calls.length).toBe(calls);
    bus.start(); // no reconnect after close
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);
    await expect(bus.close()).resolves.toBeUndefined();
  });

  it("stops a pending reconnect", async () => {
    const { bus, clients } = setup({
      clientFactory: (config) => {
        const client = new FakeClient(config);
        client.connectImpl = async () => {
          throw new Error("down");
        };
        return client;
      },
    });
    bus.start();
    await settle();
    expect(vi.getTimerCount()).toBe(1);
    await bus.close();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(clients).toHaveLength(1);
  });
});

describe("bus helpers on a bus from another module copy (duck typing)", () => {
  it("start, flush, verify, diagnose and close it without instanceof", async () => {
    vi.resetModules();
    const copy = await import("./PostgresEventBus");
    expect(copy.PostgresEventBus).not.toBe(PostgresEventBus);

    const clients: FakeClient[] = [];
    const sent: string[][] = [];
    const bus = new copy.PostgresEventBus({
      connectionString: "postgresql://u:p@localhost:5433/clockoff",
      originId: ORIGIN,
      log: fakeLog(),
      random: () => 0.5,
      notify: async (channel, payloads) => {
        sent.push(payloads);
        if (channel.startsWith("clockoff_selftest_"))
          clients.at(-1)!.deliver(channel, payloads[0]!);
      },
      clientFactory: (config) => {
        const client = new FakeClient(config);
        clients.push(client);
        return client;
      },
    });
    expect(bus instanceof PostgresEventBus).toBe(false);
    setEventBusForTesting(bus);

    startEventBusListener();
    await settle();
    expect(clients).toHaveLength(1);
    expect(eventBusDiagnostics()).toMatchObject({ mode: "postgres", listening: true });

    bus.publish(scheduleChanged("e1"));
    await flushEventBus();
    expect(sent).toHaveLength(1);

    const verified = verifyEventBusDelivery(5_000);
    await settle();
    await expect(verified).resolves.toBe(true);

    await closeEventBus();
    expect(clients[0]!.ended).toBe(true);
    expect(eventBusDiagnostics().listening).toBe(false);
  });
});
