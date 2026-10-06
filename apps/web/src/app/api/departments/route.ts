import { createDepartmentSchema } from "@workmode/validation/locationsTeams";
import { createDepartment, listDepartments } from "@/server/departments";
import { createHandler, json } from "@/server/http/apiHandler";

/** `GET /api/departments` (employees:read) → `listDepartmentsResponseSchema`. */
export const GET = createHandler({ auth: "manager", permission: "employees:read" }, async ({ ctx }) =>
  listDepartments(ctx),
);

/** `POST /api/departments` (employees:write) → 201 `{ department }`. CONFLICT on a duplicate name. */
export const POST = createHandler(
  { auth: "manager", permission: "employees:write", body: createDepartmentSchema },
  async ({ ctx, body }) => json({ department: await createDepartment(ctx, body) }, 201),
);
