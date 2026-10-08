import { REALTIME_RECONNECT_EVENT } from "@clockoff/validation/realtime";
import { getEventBus, type RealtimeEvent } from "@/server/events";
import { sseResponse } from "@/server/http/responses";

/**
 * Bus-backed Server-Sent Events helper. The `/api/.../events` endpoint (another engineer's) does:
 *
 * ```ts
 * export const GET = createHandler({ auth: "manager" }, async ({ ctx, req }) =>
 *   createOrganisationEventStream({ organisationId: ctx.organisation.id, signal: req.signal }));
 * ```
 *
 * Frames: `event: <type>\nid: <n>\ndata: <json>\n\n`; a `: ping` comment every `heartbeatMs` keeps
 * proxies from closing idle connections. With `maxLifetimeMs` the stream ends itself: it sends the
 * `event: reconnect` control frame (`RECONNECT_FRAME`) and closes normally (200, never 204, so EventSource
 * reconnects). Every way the stream can end — that lifetime, a server shutdown
 * ({@link shutdownEventStreams}), the request's abort signal, the consumer cancelling, a failed enqueue —
 * runs the same idempotent cleanup: no heartbeat, lifetime timer, bus subscription, abort listener or
 * registry entry outlives the stream.
 *
 * Open streams are tracked in a registry on `globalThis` (shared by Next's route and instrumentation
 * layers), so the SIGTERM handler can end them all: an open SSE response would otherwise keep the HTTP
 * server from closing until the platform kills the process.
 */

export function formatSseFrame(event: RealtimeEvent, id?: number): string {
  const lines = [`event: ${event.type}`];
  if (id !== undefined) lines.push(`id: ${id}`);
  lines.push(`data: ${JSON.stringify(event)}`);
  return `${lines.join("\n")}\n\n`;
}

/**
 * Last frame of a stream the server ends on purpose. A named event, because SSE comments never reach
 * script; not a bus event (see `REALTIME_RECONNECT_EVENT`). Clients that know it reconnect silently, older
 * ones ignore the unknown event and reconnect as after any drop.
 */
export const RECONNECT_FRAME = `event: ${REALTIME_RECONNECT_EVENT}\ndata: {}\n\n`;

/** First frame of every stream: the browser's reconnect delay and a timestamped comment. */
function helloFrame(): string {
  return `retry: 5000\n: connected ${new Date().toISOString()}\n\n`;
}

export interface EventStreamOptions {
  organisationId: string;
  /** Request abort signal — closes the stream when the client disconnects. */
  signal?: AbortSignal;
  /** Only forward events accepted by this predicate (e.g. one employee). */
  filter?: (event: RealtimeEvent) => boolean;
  heartbeatMs?: number;
  /**
   * End the stream this many ms after it starts: send `RECONNECT_FRAME`, clean up, close. Bounds how long
   * one authentication keeps a stream open and keeps streams under the edge's request limit; unset = open
   * until aborted or shut down.
   */
  maxLifetimeMs?: number;
  /** Extra headers / cookies for the response. */
  headers?: Record<string, string>;
}

interface EventStreamRegistry {
  /** Each open stream's "send the reconnect frame and close" function. */
  streams: Set<() => void>;
  /** Set by {@link shutdownEventStreams}: new streams end at once. */
  draining: boolean;
}

declare global {
  var __clockoffEventStreams: EventStreamRegistry | undefined;
}

function registry(): EventStreamRegistry {
  if (!globalThis.__clockoffEventStreams) {
    globalThis.__clockoffEventStreams = { streams: new Set(), draining: false };
  }
  return globalThis.__clockoffEventStreams;
}

/**
 * Server shutdown: from now on every new stream ends at once, and every open stream receives
 * `RECONNECT_FRAME` and closes (the dashboard reconnects — to the replacement deployment). Returns how
 * many streams were open. Idempotent.
 */
export function shutdownEventStreams(): number {
  const r = registry();
  r.draining = true;
  const open = [...r.streams];
  for (const end of open) end();
  return open.length;
}

export function openEventStreamCount(): number {
  return registry().streams.size;
}

/** Closes every open stream and clears the draining flag (tests). */
export function resetEventStreamsForTesting(): void {
  const r = registry();
  for (const end of [...r.streams]) end();
  r.streams.clear();
  r.draining = false;
}

export function createOrganisationEventStream(options: EventStreamOptions): Response {
  const encoder = new TextEncoder();
  const heartbeatMs = options.heartbeatMs ?? 25_000;
  const signal = options.signal;
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let endWithReconnect: (() => void) | undefined;
  let closed = false;
  let counter = 0;

  /** Idempotent: releases everything the stream holds. Every exit path goes through here. */
  const cleanup = () => {
    closed = true;
    if (heartbeat !== undefined) clearInterval(heartbeat);
    heartbeat = undefined;
    if (lifetime !== undefined) clearTimeout(lifetime);
    lifetime = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    onAbort = undefined;
    if (endWithReconnect) registry().streams.delete(endWithReconnect);
    endWithReconnect = undefined;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const safeEnqueue = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      const close = () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // already closed or cancelled
        }
      };
      const reconnectAndClose = () => {
        safeEnqueue(RECONNECT_FRAME);
        close();
      };

      // A request can already be aborted by the time the body starts streaming; "abort" never fires again.
      if (signal?.aborted) {
        close();
        return;
      }

      safeEnqueue(helloFrame());
      // The server is shutting down: tell the client to reconnect (elsewhere) instead of subscribing.
      if (registry().draining) {
        reconnectAndClose();
        return;
      }

      endWithReconnect = reconnectAndClose;
      registry().streams.add(endWithReconnect);
      unsubscribe = getEventBus().subscribe(options.organisationId, (event) => {
        if (options.filter && !options.filter(event)) return;
        safeEnqueue(formatSseFrame(event, ++counter));
      });
      heartbeat = setInterval(() => safeEnqueue(`: ping ${Date.now()}\n\n`), heartbeatMs);
      if (options.maxLifetimeMs !== undefined) {
        lifetime = setTimeout(
          () => {
            lifetime = undefined;
            reconnectAndClose();
          },
          Math.max(0, options.maxLifetimeMs),
        );
      }
      if (signal) {
        onAbort = close;
        signal.addEventListener("abort", onAbort, { once: true });
      }
    },
    cancel() {
      cleanup();
    },
  });

  return sseResponse(stream, { headers: options.headers });
}
