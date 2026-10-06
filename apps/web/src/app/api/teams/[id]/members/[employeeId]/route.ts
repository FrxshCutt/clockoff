import { teamMemberParamsSchema } from "@workmode/validation/locationsTeams";
import { createHandler } from "@/server/http/apiHandler";
import { removeTeamMember } from "@/server/teams";

/** `DELETE /api/teams/:id/members/:employeeId` (employees:write) → 204. 404 when not a member. */
export const DELETE = createHandler(
  { auth: "manager", permission: "employees:write", params: teamMemberParamsSchema },
  async ({ ctx, params }) => {
    await removeTeamMember(ctx, params.id, params.employeeId);
  },
);
