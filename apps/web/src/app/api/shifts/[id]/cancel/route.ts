import { idParamsSchema } from "@workmode/validation/primitives";
import { cancelShiftSchema } from "@workmode/validation/shifts";
import { createHandler } from "@/server/http/apiHandler";
import { cancelShift } from "@/server/shifts";

/** `POST /api/shifts/:id/cancel` `{ reason? }` (`schedule:write`) → `{ shift }`. Ends Work Mode if in progress. */
export const POST = createHandler(
  { auth: "manager", permission: "schedule:write", params: idParamsSchema, body: cancelShiftSchema },
  async ({ ctx, params, body }) => cancelShift(ctx, params.id, body),
);
