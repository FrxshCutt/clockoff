import { loginSchema } from "@clockoff/validation/auth";
import { SESSION_COOKIE } from "@/lib/cookies";
import { getCookie } from "@/lib/request";
import { loginManager } from "@/server/auth/service";
import { createHandler, json } from "@/server/http/apiHandler";
import { RATE_LIMITS } from "@/server/rateLimit";
import { getRequestMeta } from "@/server/tenancy/context";

/**
 * `POST /api/auth/login` `{ email, password }` → `{ ok: true, requiresEmailVerification, csrfToken }`
 * plus rotated session/CSRF cookies; `INVALID_CREDENTIALS` (401) otherwise. Rate limited per IP+email
 * (10 / 15 min) and per IP overall (100 / 15 min). The per-IP rule runs first so a blocked caller
 * cannot keep allocating per-email buckets.
 */
export const POST = createHandler(
  { auth: "public", body: loginSchema, rateLimit: [RATE_LIMITS.loginPerIp, RATE_LIMITS.login] },
  async ({ req, body }) => {
    const signedIn = await loginManager(body, getRequestMeta(req), getCookie(req, SESSION_COOKIE));
    return json(
      {
        ok: true,
        requiresEmailVerification: signedIn.requiresEmailVerification,
        csrfToken: signedIn.csrfToken,
      },
      { cookies: signedIn.cookies },
    );
  },
);
