import { updateEmployeeSchema } from "@workmode/validation/employees";
import { idParamsSchema } from "@workmode/validation/primitives";
import { deleteEmployee, getEmployee, updateEmployee } from "@/server/employees";
import { createHandler } from "@/server/http/apiHandler";

/** `GET /api/employees/:id` (`employees:read`) → `{ employee }` (detail). Another tenant's id is 404. */
export const GET = createHandler(
  { auth: "manager", permission: "employees:read", params: idParamsSchema },
  async ({ ctx, params }) => ({ employee: await getEmployee(ctx, params.id) }),
);

/** `PATCH /api/employees/:id` (`employees:write`) → `{ employee }`. Omitted = unchanged, `null` = clear. */
export const PATCH = createHandler(
  { auth: "manager", permission: "employees:write", params: idParamsSchema, body: updateEmployeeSchema },
  async ({ ctx, params, body }) => ({ employee: await updateEmployee(ctx, params.id, body) }),
);

/**
 * `DELETE /api/employees/:id` (`employees:write`) → 204. Soft delete: same effect as `POST …/archive`
 * (deactivates devices, revokes tokens, revokes invites, hides the employee from every list).
 */
export const DELETE = createHandler(
  { auth: "manager", permission: "employees:write", params: idParamsSchema },
  async ({ ctx, params }) => {
    await deleteEmployee(ctx, params.id);
  },
);
