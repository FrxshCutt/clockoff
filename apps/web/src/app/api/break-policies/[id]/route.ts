import { idParamsSchema } from "@clockoff/validation/primitives";
import { updateBreakPolicySchema } from "@clockoff/validation/breakPolicies";
import {
  deleteBreakPolicy,
  getBreakPolicy,
  updateBreakPolicy,
} from "@/server/breakPolicies/breakPolicies.service";
import { createHandler } from "@/server/http/apiHandler";

/** `GET /api/break-policies/:id` (policies:read) → `{ breakPolicy }`. */
export const GET = createHandler(
  { auth: "manager", permission: "policies:read", params: idParamsSchema },
  async ({ ctx, params }) => ({ breakPolicy: await getBreakPolicy(ctx, params.id) }),
);

/** `PATCH /api/break-policies/:id` (policies:write) partial → `{ breakPolicy }` (merged rules re-validated). */
export const PATCH = createHandler(
  {
    auth: "manager",
    permission: "policies:write",
    params: idParamsSchema,
    body: updateBreakPolicySchema,
  },
  async ({ ctx, params, body }) => ({ breakPolicy: await updateBreakPolicy(ctx, params.id, body) }),
);

/** `DELETE /api/break-policies/:id` (policies:write) → 204; `POLICY_ASSIGNED` while in use. */
export const DELETE = createHandler(
  { auth: "manager", permission: "policies:write", params: idParamsSchema },
  async ({ ctx, params }) => {
    await deleteBreakPolicy(ctx, params.id);
  },
);
