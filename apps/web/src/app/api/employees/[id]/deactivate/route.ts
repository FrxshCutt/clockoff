import { deactivateEmployeeSchema } from "@clockoff/validation/employees";
import { idParamsSchema } from "@clockoff/validation/primitives";
import { deactivateEmployee } from "@/server/employees";
import { createHandler } from "@/server/http/apiHandler";

/**
 * `POST /api/employees/:id/deactivate` (`employees:write`) → `{ employee }`. Employment INACTIVE, lifecycle
 * DEACTIVATED, devices deactivated, tokens revoked, live invites revoked, running break ended. Shifts are kept.
 */
export const POST = createHandler(
  {
    auth: "manager",
    permission: "employees:write",
    params: idParamsSchema,
    body: deactivateEmployeeSchema,
  },
  async ({ ctx, params, body }) => ({ employee: await deactivateEmployee(ctx, params.id, body) }),
);
