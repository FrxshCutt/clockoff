import { idParamsSchema } from "@workmode/validation/primitives";
import { updatePolicySchema } from "@workmode/validation/policies";
import { createHandler } from "@/server/http/apiHandler";
import { deletePolicy, getPolicy, updatePolicy } from "@/server/policies/policies.service";

/** `GET /api/policies/:id` (policies:read) → `{ policy }`. */
export const GET = createHandler(
  { auth: "manager", permission: "policies:read", params: idParamsSchema },
  async ({ ctx, params }) => ({ policy: await getPolicy(ctx, params.id) }),
);

/** `PATCH /api/policies/:id` (policies:write) → `{ policy }`; config edits land in the draft version. */
export const PATCH = createHandler(
  {
    auth: "manager",
    permission: "policies:write",
    params: idParamsSchema,
    body: updatePolicySchema,
  },
  async ({ ctx, params, body }) => ({ policy: await updatePolicy(ctx, params.id, body) }),
);

/** `DELETE /api/policies/:id` (policies:write) → 204; `POLICY_ASSIGNED` while in use. */
export const DELETE = createHandler(
  { auth: "manager", permission: "policies:write", params: idParamsSchema },
  async ({ ctx, params }) => {
    await deletePolicy(ctx, params.id);
  },
);
