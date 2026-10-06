import { updateDepartmentSchema } from "@workmode/validation/locationsTeams";
import { idParamsSchema } from "@workmode/validation/primitives";
import { deleteDepartment, getDepartment, updateDepartment } from "@/server/departments";
import { createHandler } from "@/server/http/apiHandler";

/** `GET /api/departments/:id` (employees:read) → `{ department }`. */
export const GET = createHandler(
  { auth: "manager", permission: "employees:read", params: idParamsSchema },
  async ({ ctx, params }) => ({ department: await getDepartment(ctx, params.id) }),
);

/** `PATCH /api/departments/:id` (employees:write) `{ name }` → `{ department }`. */
export const PATCH = createHandler(
  {
    auth: "manager",
    permission: "employees:write",
    params: idParamsSchema,
    body: updateDepartmentSchema,
  },
  async ({ ctx, params, body }) => ({ department: await updateDepartment(ctx, params.id, body) }),
);

/** `DELETE /api/departments/:id` (employees:write) → 204. Employees in it are left without a department. */
export const DELETE = createHandler(
  { auth: "manager", permission: "employees:write", params: idParamsSchema },
  async ({ ctx, params }) => {
    await deleteDepartment(ctx, params.id);
  },
);
