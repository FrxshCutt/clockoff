import { bulkEmployeeActionSchema } from "@workmode/validation/employees";
import { bulkEmployeeAction } from "@/server/employees";
import { createHandler } from "@/server/http/apiHandler";

/** `POST /api/employees/bulk` (`employees:write`) → `bulkEmployeeActionResponseSchema` (partial success). */
export const POST = createHandler(
  { auth: "manager", permission: "employees:write", body: bulkEmployeeActionSchema },
  async ({ ctx, body }) => bulkEmployeeAction(ctx, body),
);
