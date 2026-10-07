import { resetPasswordSchema } from "@clockoff/validation/auth";
import { resetPassword } from "@/server/auth/service";
import { createHandler, json } from "@/server/http/apiHandler";
import { RATE_LIMITS } from "@/server/rateLimit";
import { getRequestMeta } from "@/server/tenancy/context";

/**
 * `POST /api/auth/reset-password` `{ token, password }` → `{ ok: true, csrfToken }`. Consumes the
 * token, revokes every existing session and signs in with a fresh one. `INVALID_TOKEN` /
 * `TOKEN_EXPIRED` (400) otherwise.
 */
export const POST = createHandler(
  { auth: "public", body: resetPasswordSchema, rateLimit: RATE_LIMITS.resetPassword },
  async ({ req, body }) => {
    const signedIn = await resetPassword(body, getRequestMeta(req));
    return json({ ok: true, csrfToken: signedIn.csrfToken }, { cookies: signedIn.cookies });
  },
);
