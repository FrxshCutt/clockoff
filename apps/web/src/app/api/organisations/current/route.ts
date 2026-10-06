import { createHandler } from "@/server/http/apiHandler";
import {
  getActiveJoinCode,
  getCurrentOrganisation,
  updateCurrentOrganisation,
} from "@/server/organisations";
import { updateOrganisationSchema } from "@/server/organisations/schemas";

/**
 * `GET /api/organisations/current` → `{ organisation, membership: { id, role, permissions }, joinCode }`
 * (`organisationResponseSchema` plus the caller's membership so the UI can hide unavailable actions,
 * and the ACTIVE company join code `{ id, code, status } | null` for the dashboard).
 */
export const GET = createHandler({ auth: "manager" }, async ({ ctx }) => ({
  organisation: getCurrentOrganisation(ctx),
  membership: {
    id: ctx.membership.id,
    role: ctx.membership.role,
    permissions: [...ctx.permissions].sort(),
  },
  joinCode: await getActiveJoinCode(ctx.organisation.id),
}));

/** `PATCH /api/organisations/current` (`org:manage`) `{ name?, timezone?, dateFormat?, settings? }` → `{ organisation }`. */
export const PATCH = createHandler(
  { auth: "manager", permission: "org:manage", body: updateOrganisationSchema },
  async ({ ctx, body }) => ({ organisation: await updateCurrentOrganisation(ctx, body) }),
);
