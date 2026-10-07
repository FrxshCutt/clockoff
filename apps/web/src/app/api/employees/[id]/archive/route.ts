import { archiveEmployeeSchema } from "@clockoff/validation/employees";
import { idParamsSchema } from "@clockoff/validation/primitives";
import { archiveEmployee } from "@/server/employees";
import { createHandler } from "@/server/http/apiHandler";

/** `POST /api/employees/:id/archive` (`employees:write`) → `{ employee }`. Soft delete. */
export const POST = createHandler(
  {
    auth: "manager",
    permission: "employees:write",
    params: idParamsSchema,
    body: archiveEmployeeSchema,
  },
  async ({ ctx, params }) => ({ employee: await archiveEmployee(ctx, params.id) }),
);
