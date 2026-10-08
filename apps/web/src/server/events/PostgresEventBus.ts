import { randomUUID } from "node:crypto";
import pg, { type ClientConfig } from "pg";
import { prisma } from "@clockoff/db";
import { childLogger, errorSummary, type Logger } from "@/lib/logger";
import { pgClientConfig, prepareDirectSession } from "@/server/db/pgDirect";
import {
  isPushBridgeEventType,
  type EventBus,
  type RealtimeEvent,
  type RealtimeEventHandler,
  type Unsubscribe,
} from "./EventBus";
import { decodeEnvelope, encodeEnvelope, organisationWideTruncatedEvent } from "./envelope";
import { InProcessEventBus } from "./InProcessEventBus";

/**
 * Cross-process realtime bus on Postgres LISTEN/NOTIFY: events the worker raises (override expiry, work
 * state changes, digests) reach the web process's SSE streams, and manager edits made on web reach the
 * worker's push bridge.
 *
 * - **Publish** delivers to this process's subscribers synchronously (exactly like `InProcessEventBus`)
 *   and queues a NOTIFY envelope (`envelope.ts`) on the {@link REALTIME_NOTIFY_CHANNEL} channel. One drain
 *   loop sends the queue through the normal pooled Prisma connection, up to `batchSize` envelopes (and
 *   1 MB) per round trip, never two round trips at once, so order is kept. A failed round trip drops its
 *   batch (logged and counted): dashboards recover through their 30 s refresh, phones at their next sync.
 * - **Overflow** (more than `maxPending` queued, e.g. a 5000-row import publishing in one synchronous loop
 *   while a round trip is in flight): queued entries of the same organisation and type collapse into one
 *   organisation-wide truncated event ("refetch" / "every device"); only if that is not enough are the
 *   oldest entries of kinds the push bridge ignores dropped. Push-bridge kinds are never dropped.
 * - **Listen**: one `pg.Client` per process on the DIRECT url (PgBouncer cannot hold a LISTEN), started by
 *   the first `subscribe` / `subscribeAll` or by `start()`. It runs `prepareDirectSession` (idle-session
 *   and statement timeouts) before `LISTEN`, pings `SELECT 1` every 30 s, and on any error, end or failed
 *   ping discards the client and reconnects with backoff (1 s × 2ⁿ ≤ 30 s, ± 20 % jitter; reset once
 *   listening again). Notifications from this bus's own `originId` are ignored (already delivered
 *   locally); malformed ones are dropped. Events NOTIFYed while the listener is down are missed — the
 *   dashboard's 30 s refresh / polling fallback covers them.
 *
 * Postgres folds identical notifications within one transaction; two byte-identical events in one batch
 * therefore arrive once, which is harmless for hints.
 */

export const REALTIME_NOTIFY_CHANNEL = "clockoff_events";
export const DEFAULT_NOTIFY_MAX_PENDING = 2_000;
export const DEFAULT_NOTIFY_BATCH_SIZE = 200;
/** Upper bound on the summed payload bytes of one NOTIFY round trip. */
export const NOTIFY_BATCH_MAX_BYTES = 1_000_000;
export const LISTENER_PING_INTERVAL_MS = 30_000;
export const LISTENER_PING_TIMEOUT_MS = 10_000;
export const LISTENER_RECONNECT_BASE_MS = 1_000;
export const LISTENER_RECONNECT_MAX_MS = 30_000;
export const LISTENER_RECONNECT_JITTER = 0.2;

export interface EventBusDiagnostics {
  mode: "postgres" | "in_process";
  /** The LISTEN connection is up (always false in-process). */
  listening: boolean;
  /** Times the listener came back after losing its connection. */
  reconnects: number;
  /** Envelopes NOTIFYed, and the round trips that carried them. */
  notifySent: number;
  notifyBatches: number;
  /** Events sent with their payload replaced by `{ truncated: true }` (too large). */
  notifyTruncated: number;
  /** Queued envelopes merged away by overflow coalescing. */
  notifyCoalesced: number;
  /** Envelopes never sent: too large even truncated, overflow drops, failed round trips. */
  notifyDropped: number;
  /** Events received from other processes and delivered locally. */
  received: number;
}

export interface ListenerNotification {
  channel: string;
  payload?: string;
}

/** The slice of `pg.Client` the listener uses (a test seam). */
export interface ListenerClient {
  connect(): Promise<unknown>;
  query(text: string): Promise<unknown>;
  end(): Promise<unknown>;
  on(event: "notification", listener: (message: ListenerNotification) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "end", listener: () => void): unknown;
}

export interface PostgresEventBusOptions {
  /** DIRECT (non-pooled) Postgres URL for the LISTEN connection. */
  connectionString: string;
  channel?: string;
  /** `application_name` of the LISTEN session (≤ 63 bytes, visible in `pg_stat_activity`). */
  applicationName?: string;
  /** Defaults to a random UUID. */
  originId?: string;
  /** Sends one batch of payloads on `channel`. Default: one pooled-Prisma `pg_notify … unnest` statement. */
  notify?: (channel: string, payloads: string[]) => Promise<void>;
  maxPending?: number;
  batchSize?: number;
  clientFactory?: (config: ClientConfig) => ListenerClient;
  random?: () => number;
  log?: Logger;
  pingIntervalMs?: number;
}

interface QueuedEnvelope {
  event: RealtimeEvent;
  payload: string;
  bytes: number;
}

type Timer = ReturnType<typeof setTimeout>;

const CHANNEL_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** `$executeRaw` because `$queryRaw` cannot decode pg_notify's `void` result. */
async function notifyThroughPrisma(channel: string, payloads: string[]): Promise<void> {
  await prisma.$executeRaw`SELECT pg_notify(${channel}, t.payload) FROM unnest(${payloads}::text[]) WITH ORDINALITY AS t(payload, n) ORDER BY t.n`;
}

function createPgClient(config: ClientConfig): ListenerClient {
  return new pg.Client(config);
}

/** Rejects with `message` after `ms` unless `promise` settles first; never leaves its timer behind. */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: Timer | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), Math.max(0, ms));
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export class PostgresEventBus implements EventBus {
  readonly originId: string;
  readonly channel: string;
  /** Private channel for {@link selfTest}: a nonce sent through the pooled NOTIFY path must arrive here. */
  readonly selfTestChannel: string;

  private readonly local = new InProcessEventBus();
  private readonly connectionString: string;
  private readonly applicationName: string;
  private readonly notify: (channel: string, payloads: string[]) => Promise<void>;
  private readonly maxPending: number;
  private readonly batchSize: number;
  private readonly clientFactory: (config: ClientConfig) => ListenerClient;
  private readonly random: () => number;
  private readonly log: Logger;
  private readonly pingIntervalMs: number;

  // Send side. Invariant: `queue` is non-empty only while `drain` is set.
  private queue: QueuedEnvelope[] = [];
  private drain: Promise<void> | null = null;

  // Listen side.
  private started = false;
  private closed = false;
  private client: ListenerClient | null = null;
  private listening = false;
  private everListened = false;
  private failures = 0;
  private reconnectTimer: Timer | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pingInFlight = false;
  private readonly listeningWaiters = new Set<(listening: boolean) => void>();
  private readonly selfTestNonces = new Map<string, () => void>();

  private readonly stats = {
    reconnects: 0,
    notifySent: 0,
    notifyBatches: 0,
    notifyTruncated: 0,
    notifyCoalesced: 0,
    notifyDropped: 0,
    received: 0,
  };

  constructor(options: PostgresEventBusOptions) {
    this.connectionString = options.connectionString;
    this.channel = options.channel ?? REALTIME_NOTIFY_CHANNEL;
    if (!CHANNEL_NAME.test(this.channel)) {
      throw new Error("realtime channel must be a lowercase identifier of at most 63 characters");
    }
    this.originId = options.originId ?? randomUUID();
    const originHex =
      this.originId
        .toLowerCase()
        .replace(/[^0-9a-z]/g, "")
        .slice(0, 40) || "x";
    this.selfTestChannel = `clockoff_selftest_${originHex}`;
    this.applicationName = options.applicationName ?? "clockoff-events";
    this.notify = options.notify ?? notifyThroughPrisma;
    this.maxPending = Math.max(1, options.maxPending ?? DEFAULT_NOTIFY_MAX_PENDING);
    this.batchSize = Math.max(1, options.batchSize ?? DEFAULT_NOTIFY_BATCH_SIZE);
    this.clientFactory = options.clientFactory ?? createPgClient;
    this.random = options.random ?? Math.random;
    this.log = options.log ?? childLogger({ module: "realtimeBus" });
    this.pingIntervalMs = options.pingIntervalMs ?? LISTENER_PING_INTERVAL_MS;
  }

  // ── EventBus ──────────────────────────────────────────────────────────────

  publish(event: RealtimeEvent): void {
    this.local.publish(event);
    if (this.closed) return;
    this.enqueue(event);
  }

  subscribe(organisationId: string, handler: RealtimeEventHandler): Unsubscribe {
    this.start();
    return this.local.subscribe(organisationId, handler);
  }

  subscribeAll(handler: RealtimeEventHandler): Unsubscribe {
    this.start();
    return this.local.subscribeAll(handler);
  }

  subscriberCount(organisationId: string): number {
    return this.local.subscriberCount(organisationId);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Opens the LISTEN connection (idempotent; a no-op after `close`). */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.connect();
  }

  /** Resolves once every queued NOTIFY has been sent, or after `timeoutMs` (logged) — never rejects. */
  async flush(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.drain) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.log.warn({ pending: this.queue.length }, "realtime notify flush timed out");
        return;
      }
      await withTimeout(this.drain, remaining, "flush timed out").catch(() => undefined);
    }
  }

  /**
   * Flushes the send queue (bounded by `timeoutMs`), stops reconnecting and pinging, UNLISTENs and ends
   * the LISTEN connection. Later publishes are delivered locally only. Idempotent; never rejects.
   */
  async close(timeoutMs = 3_000): Promise<void> {
    if (this.closed) return;
    const deadline = Date.now() + timeoutMs;
    await this.flush(timeoutMs);
    this.closed = true;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.disarmPing();
    for (const waiter of [...this.listeningWaiters]) waiter(false);
    const client = this.client;
    this.client = null;
    this.listening = false;
    if (client) {
      await withTimeout(
        client.query("UNLISTEN *"),
        Math.max(250, deadline - Date.now()),
        "UNLISTEN timed out",
      ).catch(() => undefined);
      await withTimeout(
        client.end(),
        Math.max(250, deadline - Date.now()),
        "listener end timed out",
      ).catch(() => undefined);
    }
    this.log.info(this.diagnostics(), "realtime event bus closed");
  }

  /**
   * End-to-end check that this process can hear what it NOTIFYs: LISTEN on {@link selfTestChannel}, send
   * a nonce through the normal pooled notify path, true once it arrives within `timeoutMs`. UNLISTENs
   * either way. False when the URL goes through a pooler that drops LISTEN, or the database is down.
   */
  async selfTest(timeoutMs = 5_000): Promise<boolean> {
    if (this.closed) return false;
    this.start();
    const deadline = Date.now() + timeoutMs;
    if (!(await this.waitForListening(timeoutMs))) return false;
    const client = this.client;
    if (!client) return false;

    const nonce = randomUUID();
    let arrived!: () => void;
    const arrival = new Promise<void>((resolve) => (arrived = resolve));
    this.selfTestNonces.set(nonce, arrived);
    try {
      await withTimeout(
        client.query(`LISTEN ${quoteIdentifier(this.selfTestChannel)}`),
        deadline - Date.now(),
        "self-test LISTEN timed out",
      );
      await withTimeout(
        this.notify(this.selfTestChannel, [nonce]),
        deadline - Date.now(),
        "self-test NOTIFY timed out",
      );
      await withTimeout(arrival, deadline - Date.now(), "self-test notification did not arrive");
      return true;
    } catch (err) {
      // A broken listener connection surfaces through its own error/end events or the next ping.
      this.log.warn({ error: errorSummary(err) }, "realtime self-test failed");
      return false;
    } finally {
      this.selfTestNonces.delete(nonce);
      if (this.selfTestNonces.size === 0 && this.client === client && !this.closed) {
        await withTimeout(
          client.query(`UNLISTEN ${quoteIdentifier(this.selfTestChannel)}`),
          LISTENER_PING_TIMEOUT_MS,
          "self-test UNLISTEN timed out",
        ).catch(() => undefined);
      }
    }
  }

  diagnostics(): EventBusDiagnostics {
    return { mode: "postgres", listening: this.listening, ...this.stats };
  }

  // ── Send side ─────────────────────────────────────────────────────────────

  private enqueue(event: RealtimeEvent): void {
    const encoded = encodeEnvelope(this.originId, event);
    if (!encoded) {
      this.stats.notifyDropped++;
      this.log.error({ eventType: event.type }, "realtime event too large to notify; dropped");
      return;
    }
    if (encoded.truncated) {
      this.stats.notifyTruncated++;
      this.log.warn(
        { eventType: event.type, bytes: Buffer.byteLength(JSON.stringify(event), "utf8") },
        "realtime event payload too large to notify; sent truncated",
      );
    }
    this.queue.push({ event, payload: encoded.payload, bytes: encoded.bytes });
    if (this.queue.length > this.maxPending) this.compact();
    this.kickDrain();
  }

  /** Overflow: coalesce per (organisation, type), then drop the oldest non-push kinds if still over. */
  private compact(): void {
    const before = this.queue.length;
    const key = (e: RealtimeEvent) => `${e.organisationId}\u0000${e.type}`;
    const counts = new Map<string, number>();
    for (const item of this.queue)
      counts.set(key(item.event), (counts.get(key(item.event)) ?? 0) + 1);

    const emitted = new Set<string>();
    let next: QueuedEnvelope[] = [];
    for (const item of this.queue) {
      const k = key(item.event);
      if ((counts.get(k) ?? 0) <= 1) {
        next.push(item);
        continue;
      }
      if (emitted.has(k)) continue;
      emitted.add(k);
      const event = organisationWideTruncatedEvent(item.event);
      // Never larger than the entry it replaces, which fitted.
      const encoded = encodeEnvelope(this.originId, event) ?? item;
      next.push({ event, payload: encoded.payload, bytes: encoded.bytes });
    }
    const coalesced = before - next.length;
    this.stats.notifyCoalesced += coalesced;

    let dropped = 0;
    if (next.length > this.maxPending) {
      let excess = next.length - this.maxPending;
      next = next.filter((item) => {
        if (excess > 0 && !isPushBridgeEventType(item.event.type)) {
          excess--;
          dropped++;
          return false;
        }
        return true;
      });
      this.stats.notifyDropped += dropped;
    }
    this.queue = next;

    if (coalesced > 0) {
      this.log.warn(
        { before, after: next.length, coalesced },
        "realtime notify queue overflow; coalesced into organisation-wide events",
      );
    }
    if (dropped > 0) {
      this.log.error(
        { dropped, pending: next.length },
        "realtime notify queue overflow; dropped the oldest non-push events",
      );
    }
  }

  private kickDrain(): void {
    if (this.drain) return;
    // Started on a microtask so a synchronous burst of publishes shares its first round trip.
    this.drain = Promise.resolve().then(() => this.drainLoop());
  }

  private async drainLoop(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const batch = this.takeBatch();
        try {
          await this.notify(
            this.channel,
            batch.map((item) => item.payload),
          );
          this.stats.notifySent += batch.length;
          this.stats.notifyBatches++;
        } catch (err) {
          this.stats.notifyDropped += batch.length;
          this.log.error(
            { error: errorSummary(err), count: batch.length },
            "realtime notify failed; batch dropped",
          );
        }
      }
    } finally {
      // Synchronously after the last emptiness check, so a later publish always starts a new drain.
      this.drain = null;
    }
  }

  private takeBatch(): QueuedEnvelope[] {
    let count = 0;
    let bytes = 0;
    while (count < this.batchSize && count < this.queue.length) {
      const next = this.queue[count]!;
      if (count > 0 && bytes + next.bytes > NOTIFY_BATCH_MAX_BYTES) break;
      bytes += next.bytes;
      count++;
    }
    return this.queue.splice(0, count);
  }

  // ── Listen side ───────────────────────────────────────────────────────────

  private connect(): void {
    this.reconnectTimer = undefined;
    if (this.closed) return;
    let client: ListenerClient;
    try {
      client = this.clientFactory(pgClientConfig(this.connectionString, this.applicationName));
    } catch (err) {
      const retryInMs = this.scheduleReconnect();
      this.log.error(
        { error: errorSummary(err), retryInMs },
        "realtime listener could not be created",
      );
      return;
    }
    this.client = client;
    // Listeners stay attached for the client's whole life: a late "error" from a discarded client must
    // still find a handler (an unhandled "error" event would crash the process). Stale clients are ignored.
    client.on("notification", (message) => {
      if (this.client === client) this.onNotification(message);
    });
    client.on("error", (err) => this.lose(client, err));
    client.on("end", () => this.lose(client, new Error("listener connection ended")));
    void this.establish(client);
  }

  private async establish(client: ListenerClient): Promise<void> {
    try {
      await client.connect();
      if (this.client === client) await prepareDirectSession(client, this.log);
      if (this.client === client) await client.query(`LISTEN ${quoteIdentifier(this.channel)}`);
      if (this.client === client && this.selfTestNonces.size > 0) {
        await client.query(`LISTEN ${quoteIdentifier(this.selfTestChannel)}`);
      }
    } catch (err) {
      this.lose(client, err);
      return;
    }
    if (this.client !== client) {
      // Closed (or replaced) while connecting.
      void client.end().catch(() => undefined);
      return;
    }
    this.listening = true;
    this.failures = 0;
    if (this.everListened) this.stats.reconnects++;
    this.log.info(
      { channel: this.channel, reconnects: this.stats.reconnects },
      this.everListened ? "realtime listener reconnected" : "realtime listener started",
    );
    this.everListened = true;
    this.armPing(client);
    for (const waiter of [...this.listeningWaiters]) waiter(true);
  }

  /** Discards `client` (if still current) and schedules a reconnect. Idempotent per client. */
  private lose(client: ListenerClient, err: unknown): void {
    if (this.client !== client) return;
    this.client = null;
    const wasListening = this.listening;
    this.listening = false;
    this.disarmPing();
    void client.end().catch(() => undefined);
    if (this.closed) return;
    const retryInMs = this.scheduleReconnect();
    this.log.warn(
      { error: errorSummary(err), wasListening, retryInMs },
      "realtime listener lost; reconnecting",
    );
  }

  private scheduleReconnect(): number {
    const base = Math.min(
      LISTENER_RECONNECT_MAX_MS,
      LISTENER_RECONNECT_BASE_MS * 2 ** Math.min(this.failures, 16),
    );
    this.failures++;
    const jitter = 1 + (this.random() * 2 - 1) * LISTENER_RECONNECT_JITTER;
    const delay = Math.round(base * jitter);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.reconnectTimer.unref?.();
    return delay;
  }

  private armPing(client: ListenerClient): void {
    this.disarmPing();
    this.pingTimer = setInterval(() => void this.ping(client), this.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  private disarmPing(): void {
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  private async ping(client: ListenerClient): Promise<void> {
    if (this.pingInFlight || this.client !== client) return;
    this.pingInFlight = true;
    try {
      await withTimeout(
        client.query("SELECT 1"),
        LISTENER_PING_TIMEOUT_MS,
        "listener ping timed out",
      );
    } catch (err) {
      this.lose(client, err);
    } finally {
      this.pingInFlight = false;
    }
  }

  private waitForListening(timeoutMs: number): Promise<boolean> {
    if (this.listening) return Promise.resolve(true);
    if (this.closed) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const done = (listening: boolean) => {
        clearTimeout(timer);
        this.listeningWaiters.delete(done);
        resolve(listening);
      };
      const timer = setTimeout(() => done(false), Math.max(0, timeoutMs));
      timer.unref?.();
      this.listeningWaiters.add(done);
    });
  }

  private onNotification(message: ListenerNotification): void {
    if (message.channel === this.selfTestChannel) {
      this.selfTestNonces.get(message.payload ?? "")?.();
      return;
    }
    if (message.channel !== this.channel) return;
    const decoded = decodeEnvelope(message.payload ?? "");
    if (!decoded) {
      this.log.warn({ channel: message.channel }, "malformed realtime notification dropped");
      return;
    }
    if (decoded.originId === this.originId) return;
    this.stats.received++;
    this.local.publish(decoded.event);
  }
}
