import { idParamsSchema } from "@workmode/validation/primitives";
import { updateShiftSchema } from "@workmode/validation/shifts";
import { createHandler } from "@/server/http/apiHandler";
import { deleteShift, getShift, updateShift } from "@/server/shifts";

/** `GET /api/shifts/:id` (`schedule:read`) → `{ shift }`. */
export const GET = createHandler(
  { auth: "manager", permission: "schedule:read", params: idParamsSchema },
  async ({ ctx, params }) => getShift(ctx, params.id),
);

/**
 * `PATCH /api/shifts/:id` (`schedule:write`) → `{ shift, warnings? }`. Bumps `version`; `expectedVersion`
 * gives optimistic concurrency (CONFLICT). `applyTo: "THIS_AND_FUTURE"` edits the rest of a recurring
 * series as well.
 */
export const PATCH = createHandler(
  {
    auth: "manager",
    permission: "schedule:write",
    params: idParamsSchema,
    body: updateShiftSchema,
  },
  async ({ ctx, params, body }) => updateShift(ctx, params.id, body),
);

/** `DELETE /api/shifts/:id` (`schedule:write`) → 204. Soft delete. */
export const DELETE = createHandler(
  { auth: "manager", permission: "schedule:write", params: idParamsSchema },
  async ({ ctx, params }) => {
    await deleteShift(ctx, params.id);
    return undefined;
  },
);
