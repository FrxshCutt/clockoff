import { deactivateDeviceSchema } from "@workmode/validation/devices";
import { idParamsSchema } from "@workmode/validation/primitives";
import { deactivateDevice } from "@/server/devices";
import { createHandler } from "@/server/http/apiHandler";

/**
 * `POST /api/devices/:id/deactivate` (employees:write) `{ reason? }` → `deviceResponseSchema`. Revokes the
 * device's refresh tokens and push token; the phone must join again. Idempotent.
 */
export const POST = createHandler(
  {
    auth: "manager",
    permission: "employees:write",
    params: idParamsSchema,
    body: deactivateDeviceSchema,
  },
  async ({ ctx, params, body }) => deactivateDevice(ctx, params.id, body),
);
