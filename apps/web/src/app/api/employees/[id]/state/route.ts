import { employeeStateQuerySchema } from "@clockoff/validation/employees";
import { idParamsSchema } from "@clockoff/validation/primitives";
import { getEmployeeState } from "@/server/employees";
import { createHandler } from "@/server/http/apiHandler";

/** `GET /api/employees/:id/state?from&to` (`employees:read`) → `employeeStateResponseSchema`. */
export const GET = createHandler(
  {
    auth: "manager",
    permission: "employees:read",
    params: idParamsSchema,
    query: employeeStateQuerySchema,
  },
  async ({ ctx, params, query }) => getEmployeeState(ctx, params.id, query),
);
