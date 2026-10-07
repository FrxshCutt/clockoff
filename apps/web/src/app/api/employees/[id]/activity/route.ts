import { employeeActivityQuerySchema } from "@clockoff/validation/activity";
import { idParamsSchema } from "@clockoff/validation/primitives";
import { listEmployeeActivity } from "@/server/employees";
import { createHandler } from "@/server/http/apiHandler";

/** `GET /api/employees/:id/activity?cursor&limit&type&from&to` (`employees:read`) → `{ items, nextCursor }`. */
export const GET = createHandler(
  {
    auth: "manager",
    permission: "employees:read",
    params: idParamsSchema,
    query: employeeActivityQuerySchema,
  },
  async ({ ctx, params, query }) => listEmployeeActivity(ctx, params.id, query),
);
