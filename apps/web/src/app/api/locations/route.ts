import { createLocationSchema } from "@clockoff/validation/locationsTeams";
import { createHandler, json } from "@/server/http/apiHandler";
import { createLocation, listLocations } from "@/server/locations";

/** `GET /api/locations` (employees:read) → `listLocationsResponseSchema` with counts and active assignments. */
export const GET = createHandler(
  { auth: "manager", permission: "employees:read" },
  async ({ ctx }) => listLocations(ctx),
);

/** `POST /api/locations` (org:manage) → 201 `{ location }`. CONFLICT on a duplicate name or the plan limit. */
export const POST = createHandler(
  { auth: "manager", permission: "org:manage", body: createLocationSchema },
  async ({ ctx, body }) => json({ location: await createLocation(ctx, body) }, 201),
);
