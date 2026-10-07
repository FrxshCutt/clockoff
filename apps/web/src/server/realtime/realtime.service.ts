import type { RealtimeStreamQuery } from "@clockoff/validation/realtime";
import type { ManagerContext } from "@/server/tenancy/context";
import { ensureOrganisationBridged } from "./pushBridge";
import { createOrganisationEventStream } from "./sse";

/**
 * `GET /api/realtime/stream` (§5): one Server-Sent Events stream per dashboard tab, fed by the
 * organisation's bus. Frames carry ids / types / states / badges only (§12); a `: ping` comment every 25 s
 * keeps proxies from closing the connection and `retry: 5000` tells the browser how fast to reconnect.
 * Opening the stream also bridges the organisation to the push provider, so a manager edit made from this
 * process reaches the employees' phones.
 */

export const REALTIME_HEARTBEAT_MS = 25_000;

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
    // Organisation-level events (no employeeId) always pass; employee events only for the chosen employee.
    filter: employeeId
      ? (event) => event.employeeId === undefined || event.employeeId === employeeId
      : undefined,
    headers: { "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
  });
}
