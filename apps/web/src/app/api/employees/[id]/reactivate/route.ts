import { reactivateEmployeeSchema } from "@workmode/validation/employees";
import { idParamsSchema } from "@workmode/validation/primitives";
import { reactivateEmployee } from "@/server/employees";
import { createHandler } from "@/server/http/apiHandler";

/** `POST /api/employees/:id/reactivate` (`employees:write`) → `{ employee }`. Subject to the plan limit. */
export const POST = createHandler(
  {
    auth: "manager",
    permission: "employees:write",
    params: idParamsSchema,
    body: reactivateEmployeeSchema,
  },
  async ({ ctx, params }) => ({ employee: await reactivateEmployee(ctx, params.id) }),
);
