import { realtimeStreamQuerySchema } from "@clockoff/validation/realtime";
import { createHandler } from "@/server/http/apiHandler";
import { openOrganisationStream } from "@/server/realtime/realtime.service";

export const dynamic = "force-dynamic";

/**
 * `GET /api/realtime/stream?employeeId` (manager) → `text/event-stream` of the organisation's realtime
 * events (`event: <type>` / `data: <SseEvent JSON>`, `: ping` every 15 s, `retry: 5000`). Ends itself after
 * 20 s with an `event: reconnect` control frame (see `REALTIME_STREAM_MAX_LIFETIME_MS`); closes on abort.
 */
export const GET = createHandler(
  { auth: "manager", query: realtimeStreamQuerySchema },
  async ({ ctx, query, req }) => openOrganisationStream(ctx, query, req.signal),
);
