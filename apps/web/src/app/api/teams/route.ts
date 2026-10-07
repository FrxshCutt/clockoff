import { createTeamSchema, teamQuerySchema } from "@clockoff/validation/locationsTeams";
import { createHandler, json } from "@/server/http/apiHandler";
import { createTeam, listTeams } from "@/server/teams";

/** `GET /api/teams?locationId=` (employees:read) → `listTeamsResponseSchema` with member counts and assignments. */
export const GET = createHandler(
  { auth: "manager", permission: "employees:read", query: teamQuerySchema },
  async ({ ctx, query }) => listTeams(ctx, query),
);

/** `POST /api/teams` (org:manage) → 201 `{ team }`. Unknown location / employees → 404. */
export const POST = createHandler(
  { auth: "manager", permission: "org:manage", body: createTeamSchema },
  async ({ ctx, body }) => json({ team: await createTeam(ctx, body) }, 201),
);
