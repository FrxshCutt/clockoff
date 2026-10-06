import { updateTeamSchema } from "@workmode/validation/locationsTeams";
import { idParamsSchema } from "@workmode/validation/primitives";
import { createHandler } from "@/server/http/apiHandler";
import { deleteTeam, getTeam, updateTeam } from "@/server/teams";

/** `GET /api/teams/:id` (employees:read) → `{ team }`. */
export const GET = createHandler(
  { auth: "manager", permission: "employees:read", params: idParamsSchema },
  async ({ ctx, params }) => ({ team: await getTeam(ctx, params.id) }),
);

/** `PATCH /api/teams/:id` (org:manage) → `{ team }`. `locationId: null` detaches the team. */
export const PATCH = createHandler(
  { auth: "manager", permission: "org:manage", params: idParamsSchema, body: updateTeamSchema },
  async ({ ctx, params, body }) => ({ team: await updateTeam(ctx, params.id, body) }),
);

/** `DELETE /api/teams/:id` (org:manage) → 204. */
export const DELETE = createHandler(
  { auth: "manager", permission: "org:manage", params: idParamsSchema },
  async ({ ctx, params }) => {
    await deleteTeam(ctx, params.id);
  },
);
