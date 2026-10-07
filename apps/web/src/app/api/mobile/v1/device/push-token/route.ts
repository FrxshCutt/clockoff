import { pushTokenSchema } from "@clockoff/validation/mobile";
import { createHandler } from "@/server/http/apiHandler";
import { registerPushToken } from "@/server/sync/sync.service";

export const dynamic = "force-dynamic";

/** `POST /api/mobile/v1/device/push-token` (mobile) → `{ ok: true }`. Token encrypted at rest, never logged. */
export const POST = createHandler(
  { auth: "mobile", body: pushTokenSchema },
  async ({ ctx, body }) => registerPushToken(ctx, body),
);
