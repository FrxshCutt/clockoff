import { SESSION_COOKIE } from "@/lib/cookies";
import { getCookie } from "@/lib/request";
import { createHandler, json } from "@/server/http/apiHandler";
import { acceptManagerInvite } from "@/server/organisations";
import { acceptManagerInviteSchema } from "@/server/organisations/schemas";
import { RATE_LIMITS } from "@/server/rateLimit";
import { getRequestMeta } from "@/server/tenancy/context";

/**
 * `POST /api/organisations/current/members/accept` (public) `{ token, name?, password? }` →
 * `{ organisation: { id, name }, role, createdAccount, csrfToken }` and sign-in cookies with the
 * organisation selected.
 * - No account for the invited email: `name` + `password` required (`VALIDATION_ERROR` otherwise).
 * - Existing account: be signed in as it, or send its `password` (`UNAUTHENTICATED` with
 *   `details.requiresLogin` / `INVALID_CREDENTIALS` otherwise).
 * - `INVITE_INVALID` / `INVITE_EXPIRED` (400) for unusable links.
 */
export const POST = createHandler(
  { auth: "public", body: acceptManagerInviteSchema, rateLimit: RATE_LIMITS.acceptManagerInvite },
  async ({ req, body }) => {
    const result = await acceptManagerInvite(
      body,
      getRequestMeta(req),
      getCookie(req, SESSION_COOKIE),
    );
    return json(result.body, { cookies: result.cookies });
  },
);
