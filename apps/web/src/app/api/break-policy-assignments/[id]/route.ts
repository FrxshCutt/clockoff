import { idParamsSchema } from "@workmode/validation/primitives";
import { endBreakPolicyAssignment } from "@/server/breakPolicies/breakPolicies.service";
import { createHandler } from "@/server/http/apiHandler";

/** `DELETE /api/break-policy-assignments/:id` (policies:write) → 204 (ends the assignment now). */
export const DELETE = createHandler(
  { auth: "manager", permission: "policies:write", params: idParamsSchema },
  async ({ ctx, params }) => {
    await endBreakPolicyAssignment(ctx, params.id);
  },
);
