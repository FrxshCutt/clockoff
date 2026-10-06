import { updateLocationSchema } from "@workmode/validation/locationsTeams";
import { idParamsSchema } from "@workmode/validation/primitives";
import { createHandler } from "@/server/http/apiHandler";
import { deleteLocation, getLocation, updateLocation } from "@/server/locations";

/** `GET /api/locations/:id` (employees:read) → `{ location }`. */
export const GET = createHandler(
  { auth: "manager", permission: "employees:read", params: idParamsSchema },
  async ({ ctx, params }) => ({ location: await getLocation(ctx, params.id) }),
);

/** `PATCH /api/locations/:id` (org:manage) → `{ location }`. */
export const PATCH = createHandler(
  {
    auth: "manager",
    permission: "org:manage",
    params: idParamsSchema,
    body: updateLocationSchema,
  },
  async ({ ctx, params, body }) => ({ location: await updateLocation(ctx, params.id, body) }),
);

/** `DELETE /api/locations/:id` (org:manage) → 204. CONFLICT while shifts are still scheduled there. */
export const DELETE = createHandler(
  { auth: "manager", permission: "org:manage", params: idParamsSchema },
  async ({ ctx, params }) => {
    await deleteLocation(ctx, params.id);
  },
);
