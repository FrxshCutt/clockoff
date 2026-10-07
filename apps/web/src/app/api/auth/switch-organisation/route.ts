import { switchOrganisationSchema } from "@clockoff/validation/auth";
import { switchOrganisation } from "@/server/auth/service";
import { createHandler, json } from "@/server/http/apiHandler";

/**
 * `POST /api/auth/switch-organisation` `{ organisationId }` → `{ ok: true, currentOrganisationId }` and
 * the `clockoff_org` cookie. `NOT_FOUND` when the caller is not a member of that organisation.
 */
export const POST = createHandler(
  { auth: "user", body: switchOrganisationSchema },
  async ({ ctx, body }) => {
    const result = await switchOrganisation(ctx, body.organisationId);
    return json(
      { ok: true, currentOrganisationId: result.organisationId },
      { cookies: result.cookies },
    );
  },
);
