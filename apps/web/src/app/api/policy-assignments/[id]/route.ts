import { idParamsSchema } from "@workmode/validation/primitives";
import { createHandler } from "@/server/http/apiHandler";
import { endPolicyAssignment } from "@/server/policies/policies.service";

/** `DELETE /api/policy-assignments/:id` (policies:write) → 204 (ends the assignment now). */
export const DELETE = createHandler(
  { auth: "manager", permission: "policies:write", params: idParamsSchema },
  async ({ ctx, params }) => {
    await endPolicyAssignment(ctx, params.id);
  },
);
