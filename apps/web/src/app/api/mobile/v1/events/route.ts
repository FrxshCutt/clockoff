import { deviceEventsSchema } from "@clockoff/validation/mobile";
import { ingestDeviceEvents } from "@/server/deviceEvents/deviceEvents.service";
import { createHandler } from "@/server/http/apiHandler";

export const dynamic = "force-dynamic";

/** `POST /api/mobile/v1/events` (mobile) → `{ accepted, duplicates, rejected }`; idempotent per clientEventId. */
export const POST = createHandler(
  { auth: "mobile", body: deviceEventsSchema },
  async ({ ctx, body }) => ingestDeviceEvents(ctx, body),
);
