import { assignEmployeeBreakPolicySchema } from "@workmode/validation/employees";
import { idParamsSchema } from "@workmode/validation/primitives";
import { assignEmployeeBreakPolicy } from "@/server/employees";
import { createHandler } from "@/server/http/apiHandler";

/** `POST /api/employees/:id/assign-break-policy` (`employees:write`) `{ breakPolicyId | null }` → `{ employee }`. */
export const POST = createHandler(
  {
    auth: "manager",
    permission: "employees:write",
    params: idParamsSchema,
    body: assignEmployeeBreakPolicySchema,
  },
  async ({ ctx, params, body }) => ({ employee: await assignEmployeeBreakPolicy(ctx, params.id, body) }),
);
