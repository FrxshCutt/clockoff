import { createEmployeeSchema, employeeQuerySchema } from "@clockoff/validation/employees";
import { createEmployee, listEmployees } from "@/server/employees";
import { createHandler, json } from "@/server/http/apiHandler";

/** `GET /api/employees` (`employees:read`) → `listEmployeesResponseSchema`. Archived employees are never listed. */
export const GET = createHandler(
  { auth: "manager", permission: "employees:read", query: employeeQuerySchema },
  async ({ ctx, query }) => listEmployees(ctx, query),
);

/**
 * `POST /api/employees` (`employees:write`) → 201 `{ employee }`. `CONFLICT` for a duplicate external id
 * or when the plan's active-employee limit is reached (`details.reason = "PLAN_LIMIT"`).
 */
export const POST = createHandler(
  { auth: "manager", permission: "employees:write", body: createEmployeeSchema },
  async ({ ctx, body }) => json({ employee: await createEmployee(ctx, body) }, 201),
);
