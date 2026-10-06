import { assignEmployeeLocationSchema } from "@workmode/validation/employees";
import { idParamsSchema } from "@workmode/validation/primitives";
import { assignEmployeeLocation } from "@/server/employees";
import { createHandler } from "@/server/http/apiHandler";

/** `POST /api/employees/:id/assign-location` (`employees:write`) `{ primaryLocationId?, locationIds? }` → `{ employee }`. */
export const POST = createHandler(
  {
    auth: "manager",
    permission: "employees:write",
    params: idParamsSchema,
    body: assignEmployeeLocationSchema,
  },
  async ({ ctx, params, body }) => ({ employee: await assignEmployeeLocation(ctx, params.id, body) }),
);
