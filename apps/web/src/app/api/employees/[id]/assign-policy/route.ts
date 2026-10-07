import { assignEmployeePolicySchema } from "@clockoff/validation/employees";
import { idParamsSchema } from "@clockoff/validation/primitives";
import { assignEmployeePolicy } from "@/server/employees";
import { createHandler } from "@/server/http/apiHandler";

/** `POST /api/employees/:id/assign-policy` (`employees:write`) `{ policyId | null }` → `{ employee }`. */
export const POST = createHandler(
  {
    auth: "manager",
    permission: "employees:write",
    params: idParamsSchema,
    body: assignEmployeePolicySchema,
  },
  async ({ ctx, params, body }) => ({ employee: await assignEmployeePolicy(ctx, params.id, body) }),
);
