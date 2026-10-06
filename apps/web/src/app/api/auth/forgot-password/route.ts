import { forgotPasswordSchema } from "@workmode/validation/auth";
import { requestPasswordReset } from "@/server/auth/service";
import { createHandler, json } from "@/server/http/apiHandler";
import { RATE_LIMITS } from "@/server/rateLimit";
import { getRequestMeta } from "@/server/tenancy/context";

/** `POST /api/auth/forgot-password` `{ email }` → always `{ ok: true }` (no account enumeration). */
export const POST = createHandler(
  { auth: "public", body: forgotPasswordSchema, rateLimit: RATE_LIMITS.forgotPassword },
  async ({ req, body }) => {
    await requestPasswordReset(body.email, getRequestMeta(req));
    return json({ ok: true });
  },
);
