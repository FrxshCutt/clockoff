import { orgCookie } from "@/lib/cookies";
import { createHandler, json } from "@/server/http/apiHandler";
import {
  createOrganisation,
  listOrganisationsForUser,
  toOrganisationDto,
} from "@/server/organisations";
import { createOrganisationSchema } from "@/server/organisations/schemas";

/** `GET /api/organisations` → `{ organisations: Array<Organisation & { role }> }` for the signed-in manager. */
export const GET = createHandler({ auth: "user" }, async ({ ctx }) => ({
  organisations: await listOrganisationsForUser(ctx.user.id),
}));

/**
 * `POST /api/organisations` `{ name, timezone, firstLocationName? }` → 201 `{ organisation, joinCode }`.
 * Creates the OWNER membership, optional first location and the ACTIVE company join code, and selects
 * the new organisation (`wm_org` cookie). Requires a verified email when `REQUIRE_EMAIL_VERIFICATION`.
 */
export const POST = createHandler(
  { auth: "user", emailVerification: "env", body: createOrganisationSchema },
  async ({ ctx, body }) => {
    const created = await createOrganisation(ctx, body);
    return json(
      {
        organisation: toOrganisationDto(created.organisation),
        joinCode: {
          id: created.joinCode.id,
          code: created.joinCode.code,
          status: created.joinCode.status,
        },
        location: created.location
          ? { id: created.location.id, name: created.location.name }
          : null,
      },
      { status: 201, cookies: [orgCookie(created.organisation.id)] },
    );
  },
);
