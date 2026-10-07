import { addTeamMembersSchema } from "@clockoff/validation/locationsTeams";
import { idParamsSchema } from "@clockoff/validation/primitives";
import { createHandler } from "@/server/http/apiHandler";
import { addTeamMembers } from "@/server/teams";

/**
 * `POST /api/teams/:id/members` (employees:write) `{ employeeIds, replace? }` → `{ team }`. Adds the
 * employees (idempotent) or, with `replace: true`, makes them the whole membership. EMPLOYEE_NOT_FOUND
 * (404) for ids that are not live employees of this organisation.
 */
export const POST = createHandler(
  {
    auth: "manager",
    permission: "employees:write",
    params: idParamsSchema,
    body: addTeamMembersSchema,
  },
  async ({ ctx, params, body }) => ({ team: await addTeamMembers(ctx, params.id, body) }),
);
