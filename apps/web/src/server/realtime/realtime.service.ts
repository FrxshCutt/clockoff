import type { RealtimeStreamQuery } from "@clockoff/validation/realtime";
import type { ManagerContext } from "@/server/tenancy/context";
import { ensureOrganisationBridged } from "./pushBridge";
import { createOrganisationEventStream } from "./sse";

/**
 * `GET /api/realtime/stream` (§5): one Server-Sent Events stream per dashboard tab, fed by the
 * organisation's bus. Frames carry ids / types / states / badges only (§12); a `: ping` comment every 15 s
 * keeps proxies from closing the connection and `retry: 5000` tells the browser how fast to reconnect.
 * Every stream ends itself after 20 s with an `event: reconnect` control frame; the dashboard reconnects
 * without showing a drop. Opening the stream also bridges the organisation to the push provider, so a
 * manager edit made from this process reaches the employees' phones.
 */

/**
 * Lifetime cap, measured from when the stream starts. Netlify cuts streamed function responses at 30 s on
 * this site (its docs say 60 s; Next's `maxDuration` is ignored there), and the request's abort signal never
 * fires while the stream is open, so without a cap every stream runs into the cut — a timed-out invocation
 * that resets the function environment and logs `socket hang up` / `Invoke Error`. 20 s leaves room inside
 * the 30 s budget for the auth database round trips to London and 5–6 s cold starts. Applied on every host
 * (dev parity); on long-lived servers it only adds a silent reconnect every 20 s. Never add `after()` /
 * `waitUntil` work to this route: Netlify waits for it before ending the invocation.
 */
export const REALTIME_STREAM_MAX_LIFETIME_MS = 20_000;

/**
 * Keep-alive comment interval. Must stay below `REALTIME_STREAM_MAX_LIFETIME_MS` so every stream sends at
 * least one ping (proxies with idle timeouts on long-lived hosts see traffic before the close).
 */
export const REALTIME_HEARTBEAT_MS = 15_000;

export function openOrganisationStream(
  ctx: ManagerContext,
  query: RealtimeStreamQuery,
  signal: AbortSignal | undefined,
): Response {
  const organisationId = ctx.organisation.id;
  ensureOrganisationBridged(organisationId);
  const employeeId = query.employeeId;
  return createOrganisationEventStream({
    organisationId,
    signal,
    heartbeatMs: REALTIME_HEARTBEAT_MS,
    maxLifetimeMs: REALTIME_STREAM_MAX_LIFETIME_MS,
    // Organisation-level events (no employeeId) always pass; employee events only for the chosen employee.
    filter: employeeId
      ? (event) => event.employeeId === undefined || event.employeeId === employeeId
      : undefined,
    headers: { "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
  });
}
