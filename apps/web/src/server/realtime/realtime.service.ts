import type { RealtimeStreamQuery } from "@clockoff/validation/realtime";
import { env } from "@/lib/env";
import type { ManagerContext } from "@/server/tenancy/context";
import { createOrganisationEventStream } from "./sse";

/**
 * `GET /api/realtime/stream` (§5): one Server-Sent Events stream per dashboard tab, fed by the
 * organisation's bus (which carries events from every process: web and worker). Frames carry ids / types /
 * states / badges only (§12); a `: ping` comment every 15 s keeps proxies from closing the connection and
 * `retry: 5000` tells the browser how fast to reconnect. Every stream ends itself after
 * {@link realtimeStreamMaxLifetimeMs} with an `event: reconnect` control frame and the dashboard reconnects
 * without showing a drop; a web shutdown ends every open stream the same way (`shutdownEventStreams`).
 */

/**
 * Default lifetime cap, measured from when the stream starts. A stream authenticates once, so the cap
 * bounds how long a revoked session keeps receiving events; it also stays well under the hosting edge's
 * request limit. Configurable through `REALTIME_STREAM_MAX_LIFETIME_MS` (10 s – 14 min).
 */
export const DEFAULT_REALTIME_STREAM_MAX_LIFETIME_MS = 300_000;

/**
 * Keep-alive comment interval: below the default lifetime, so a stream pings at least once, and below
 * common proxy idle timeouts.
 */
export const REALTIME_HEARTBEAT_MS = 15_000;

/** The configured stream lifetime cap (env `REALTIME_STREAM_MAX_LIFETIME_MS`, default 5 min). */
export function realtimeStreamMaxLifetimeMs(): number {
  return env().REALTIME_STREAM_MAX_LIFETIME_MS;
}

export function openOrganisationStream(
  ctx: ManagerContext,
  query: RealtimeStreamQuery,
  signal: AbortSignal | undefined,
): Response {
  const employeeId = query.employeeId;
  return createOrganisationEventStream({
    organisationId: ctx.organisation.id,
    signal,
    heartbeatMs: REALTIME_HEARTBEAT_MS,
    maxLifetimeMs: realtimeStreamMaxLifetimeMs(),
    // Organisation-level events (no employeeId) always pass; employee events only for the chosen employee.
    filter: employeeId
      ? (event) => event.employeeId === undefined || event.employeeId === employeeId
      : undefined,
    // `no-transform` also keeps Next's compression from buffering the stream.
    headers: { "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
  });
}
