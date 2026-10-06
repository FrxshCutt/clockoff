import { assignEmployeeTeamSchema } from "@workmode/validation/employees";
import { idParamsSchema } from "@workmode/validation/primitives";
import { assignEmployeeTeam } from "@/server/employees";
import { createHandler } from "@/server/http/apiHandler";

/** `POST /api/employees/:id/assign-team` (`employees:write`) `{ teamIds }` → `{ employee }` (replaces the set). */
export const POST = createHandler(
  {
    auth: "manager",
    permission: "employees:write",
    params: idParamsSchema,
    body: assignEmployeeTeamSchema,
  },
  async ({ ctx, params, body }) => ({ employee: await assignEmployeeTeam(ctx, params.id, body) }),
);
