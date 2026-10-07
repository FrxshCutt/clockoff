import { registerSchema } from "@clockoff/validation/auth";
import { SESSION_COOKIE } from "@/lib/cookies";
import { getCookie } from "@/lib/request";
import { registerManager } from "@/server/auth/service";
import { createHandler, json } from "@/server/http/apiHandler";
import { RATE_LIMITS } from "@/server/rateLimit";
import { getRequestMeta } from "@/server/tenancy/context";

/**
 * `POST /api/auth/register` `{ name, email, password }` → 201 `{ ok: true, requiresEmailVerification,
 * csrfToken }` (`authSessionResponseSchema`), for new AND already-registered addresses alike (no
 * account enumeration; the owner of an existing account is emailed instead).
 *
 * A session cookie is set only for a new account when `REQUIRE_EMAIL_VERIFICATION` is off. Otherwise
 * the client shows "check your email": the verification link confirms the address, then the manager
 * signs in. Clients should call `GET /api/auth/me` afterwards to learn whether a session exists.
 */
export const POST = createHandler(
  { auth: "public", body: registerSchema, rateLimit: RATE_LIMITS.register },
  async ({ req, body }) => {
    const outcome = await registerManager(
      body,
      getRequestMeta(req),
      getCookie(req, SESSION_COOKIE),
    );
    return json(
      {
        ok: true,
        requiresEmailVerification: outcome.requiresEmailVerification,
        csrfToken: outcome.csrfToken,
      },
      { status: 201, cookies: outcome.cookies },
    );
  },
);
