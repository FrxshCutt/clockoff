import { idParamsSchema } from "@clockoff/validation/primitives";
import { getDevice } from "@/server/devices";
import { createHandler } from "@/server/http/apiHandler";

/** `GET /api/devices/:id` (employees:read) → `deviceResponseSchema` `{ device, employee, status }`. */
export const GET = createHandler(
  { auth: "manager", permission: "employees:read", params: idParamsSchema },
  async ({ ctx, params }) => getDevice(ctx, params.id),
);
