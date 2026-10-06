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
 * proxies from closing idle connections. The subscription is released when the client disconnects.
 */

export function formatSseFrame(event: RealtimeEvent, id?: number): string {
  const lines = [`event: ${event.type}`];
  if (id !== undefined) lines.push(`id: ${id}`);
  lines.push(`data: ${JSON.stringify(event)}`);
  return `${lines.join("\n")}\n\n`;
}

export interface EventStreamOptions {
  organisationId: string;
  /** Request abort signal — closes the stream when the client disconnects. */
  signal?: AbortSignal;
  /** Only forward events accepted by this predicate (e.g. one employee). */
  filter?: (event: RealtimeEvent) => boolean;
  heartbeatMs?: number;
  /** Extra headers / cookies for the response. */
  headers?: Record<string, string>;
}

export function createOrganisationEventStream(options: EventStreamOptions): Response {
  const encoder = new TextEncoder();
  const heartbeatMs = options.heartbeatMs ?? 25_000;
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let counter = 0;

  const cleanup = () => {
    unsubscribe?.();
    unsubscribe = undefined;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const safeEnqueue = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      safeEnqueue(`retry: 5000\n: connected ${new Date().toISOString()}\n\n`);
      unsubscribe = getEventBus().subscribe(options.organisationId, (event) => {
        if (options.filter && !options.filter(event)) return;
        safeEnqueue(formatSseFrame(event, ++counter));
      });
      heartbeat = setInterval(() => safeEnqueue(`: ping ${Date.now()}\n\n`), heartbeatMs);
      const onAbort = () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      // A request can already be aborted by the time the body starts streaming; "abort" never fires again.
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener("abort", onAbort, { once: true });
    },
    cancel() {
      cleanup();
    },
  });

  return sseResponse(stream, { headers: options.headers });
}
