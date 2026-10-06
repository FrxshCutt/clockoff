import { createTeamSchema, teamQuerySchema } from "@workmode/validation/locationsTeams";
import { createHandler, json } from "@/server/http/apiHandler";
import { createTeam, listTeams } from "@/server/teams";

/** `GET /api/teams?locationId=` (employees:read) → `listTeamsResponseSchema` with member counts and assignments. */
export const GET = createHandler(
  { auth: "manager", permission: "employees:read", query: teamQuerySchema },
  async ({ ctx, query }) => listTeams(ctx, query),
);

/** `POST /api/teams` (employees:write) → 201 `{ team }`. Unknown location / employees → 404. */
export const POST = createHandler(
  { auth: "manager", permission: "employees:write", body: createTeamSchema },
  async ({ ctx, body }) => json({ team: await createTeam(ctx, body) }, 201),
);
