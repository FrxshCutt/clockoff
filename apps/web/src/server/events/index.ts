import { after } from "next/server";
import { env } from "@/lib/env";
import { childLogger, errorSummary } from "@/lib/logger";
import type { EventBus, RealtimeEvent } from "./EventBus";
import { InProcessEventBus } from "./InProcessEventBus";
import { PostgresEventBus, type EventBusDiagnostics } from "./PostgresEventBus";

export { InProcessEventBus } from "./InProcessEventBus";
export {
  PostgresEventBus,
  REALTIME_NOTIFY_CHANNEL,
  DEFAULT_NOTIFY_BATCH_SIZE,
  DEFAULT_NOTIFY_MAX_PENDING,
} from "./PostgresEventBus";
export type {
  EventBusDiagnostics,
  ListenerClient,
  ListenerNotification,
  PostgresEventBusOptions,
} from "./PostgresEventBus";
export { NOTIFY_MAX_BYTES, decodeEnvelope, encodeEnvelope } from "./envelope";
export { PUSH_BRIDGE_EVENT_TYPES, REALTIME_EVENT_TYPES, isPushBridgeEventType } from "./EventBus";
export type {
  EventBus,
  KnownRealtimeEventType,
  PushBridgeEventType,
  RealtimeEvent,
  RealtimeEventHandler,
  Unsubscribe,
} from "./EventBus";

/**
 * The process-wide realtime bus.
 *
 * - With `DIRECT_URL` (web and worker on Railway, local dev with the Postgres container): a
 *   `PostgresEventBus`, so an event published in any process reaches the subscribers of every process.
 * - Under tests (`NODE_ENV=test`) or without `DIRECT_URL`: an `InProcessEventBus` (logged once). Events
 *   then stay in the publishing process; dashboards still catch up through their 30 s refresh.
 *
 * The bus is cached on `globalThis`: Next's instrumentation layer (which starts the listener at boot) and
 * its route layers are separate module graphs, and dev HMR reloads modules — all of them must share one
 * bus and one LISTEN connection. For the same reason the helpers below duck-type the cached bus instead of
 * using `instanceof` (each layer has its own copy of the class).
 */

declare global {
  var __clockoffEventBus: EventBus | undefined;
}

const log = childLogger({ module: "realtimeBus" });

/** What {@link getEventBus} builds for an environment (exported for tests). */
export function createDefaultEventBus(config: {
  nodeEnv: string | undefined;
  directUrl: string | undefined;
  serviceName?: string | undefined;
}): EventBus {
  if (config.nodeEnv === "test" || !config.directUrl) {
    const reason = config.nodeEnv === "test" ? "test" : "no_direct_url";
    if (config.nodeEnv === "production") {
      log.warn({ reason }, "realtime event bus is in-process only: events stay in this process");
    } else {
      log.info({ reason }, "realtime event bus is in-process only");
    }
    return new InProcessEventBus();
  }
  return new PostgresEventBus({
    connectionString: config.directUrl,
    applicationName: `clockoff-${config.serviceName || "app"}-events`,
  });
}

function eventBusFromEnvironment(): EventBus {
  const nodeEnv = process.env.NODE_ENV;
  let directUrl: string | undefined;
  if (nodeEnv !== "test") {
    try {
      directUrl = env().DIRECT_URL;
    } catch (err) {
      // Publishing must never throw (it runs after committed writes); the env error surfaces elsewhere.
      log.error(
        { error: errorSummary(err) },
        "environment invalid; realtime event bus stays in-process",
      );
    }
  }
  return createDefaultEventBus({
    nodeEnv,
    directUrl,
    serviceName: process.env.RAILWAY_SERVICE_NAME,
  });
}

/** Process-wide bus (see the module comment). */
export function getEventBus(): EventBus {
  if (!globalThis.__clockoffEventBus) globalThis.__clockoffEventBus = eventBusFromEnvironment();
  return globalThis.__clockoffEventBus;
}

export function setEventBusForTesting(bus: EventBus | undefined): void {
  globalThis.__clockoffEventBus = bus;
}

/** Upper bound of the per-request NOTIFY flush registered by {@link publishEvent}. */
export const NOTIFY_FLUSH_AFTER_RESPONSE_MS = 2_000;

/**
 * Convenience for publishing with `at` defaulted to now.
 *
 * The NOTIFY leaves on a microtask, unawaited by the caller. Inside a Next.js request (web) the publish
 * therefore also registers an `after()` task that waits for the bus to flush (≤ 2 s, after the response
 * is sent): Next's graceful shutdown awaits pending `after()` tasks before `process.exit(0)`, so the
 * NOTIFY of an event published by one of the last requests before a deploy still reaches the worker
 * (its push bridge) instead of dying with the process. Outside a request (the worker, whose bundle shims
 * `after()` to throw; tests; scripts) nothing is registered: the worker flushes the bus at shutdown.
 */
export function publishEvent(event: Omit<RealtimeEvent, "at"> & { at?: string }): void {
  const bus = getEventBus();
  bus.publish({ ...event, at: event.at ?? new Date().toISOString() });
  const lifecycle = managed(bus);
  if (!lifecycle) return;
  try {
    after(() => lifecycle.flush(NOTIFY_FLUSH_AFTER_RESPONSE_MS));
  } catch {
    // Not inside a request scope.
  }
}

/** The lifecycle half of `PostgresEventBus`, recognised by shape (never `instanceof`, see above). */
interface ManagedEventBus {
  start(): void;
  flush(timeoutMs?: number): Promise<void>;
  close(timeoutMs?: number): Promise<void>;
  selfTest(timeoutMs?: number): Promise<boolean>;
  diagnostics(): EventBusDiagnostics;
}

function managed(bus: EventBus | undefined): ManagedEventBus | null {
  const candidate = bus as Partial<ManagedEventBus> | undefined;
  return candidate &&
    typeof candidate.diagnostics === "function" &&
    typeof candidate.start === "function" &&
    typeof candidate.flush === "function" &&
    typeof candidate.close === "function" &&
    typeof candidate.selfTest === "function"
    ? (candidate as ManagedEventBus)
    : null;
}

/** Opens the bus's LISTEN connection now instead of at the first subscription (process startup). */
export function startEventBusListener(): void {
  managed(getEventBus())?.start();
}

/** Resolves once every queued NOTIFY has been sent (or after `timeoutMs`); immediate in-process. */
export async function flushEventBus(timeoutMs = 5_000): Promise<void> {
  await managed(globalThis.__clockoffEventBus)?.flush(timeoutMs);
}

/**
 * Shutdown: flushes queued NOTIFYs, UNLISTENs and ends the LISTEN connection (bounded by `timeoutMs`).
 * Publishes after this are delivered in this process only.
 */
export async function closeEventBus(timeoutMs = 3_000): Promise<void> {
  await managed(globalThis.__clockoffEventBus)?.close(timeoutMs);
}

/**
 * Worker startup self-test: true when a NOTIFY sent through the pooled connection comes back on this
 * process's LISTEN connection within `timeoutMs`. Always true for an in-process bus (nothing to verify).
 */
export async function verifyEventBusDelivery(timeoutMs = 5_000): Promise<boolean> {
  const bus = managed(getEventBus());
  return bus ? bus.selfTest(timeoutMs) : true;
}

/** Counters and connection state for health checks and logs. */
export function eventBusDiagnostics(): EventBusDiagnostics {
  const bus = managed(getEventBus());
  if (bus) return bus.diagnostics();
  return {
    mode: "in_process",
    listening: false,
    reconnects: 0,
    notifySent: 0,
    notifyBatches: 0,
    notifyTruncated: 0,
    notifyCoalesced: 0,
    notifyDropped: 0,
    received: 0,
  };
}
