import { idParamsSchema } from "@clockoff/validation/primitives";
import { employeeShiftsQuerySchema } from "@clockoff/validation/shifts";
import { listEmployeeShifts } from "@/server/employees";
import { createHandler } from "@/server/http/apiHandler";

/** `GET /api/employees/:id/shifts?from&to&status&limit` (`schedule:read`) → `{ shifts }`. */
export const GET = createHandler(
  {
    auth: "manager",
    permission: "schedule:read",
    params: idParamsSchema,
    query: employeeShiftsQuerySchema,
  },
  async ({ ctx, params, query }) => listEmployeeShifts(ctx, params.id, query),
);
