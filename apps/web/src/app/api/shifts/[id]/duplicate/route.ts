import { idParamsSchema } from "@workmode/validation/primitives";
import { duplicateShiftSchema } from "@workmode/validation/shifts";
import { createHandler, json } from "@/server/http/apiHandler";
import { duplicateShift } from "@/server/shifts";

/** `POST /api/shifts/:id/duplicate` `{ date }` (`schedule:write`) → 201 `{ shift }`. Same local times on another date. */
export const POST = createHandler(
  { auth: "manager", permission: "schedule:write", params: idParamsSchema, body: duplicateShiftSchema },
  async ({ ctx, params, body }) => json(await duplicateShift(ctx, params.id, body), 201),
);
