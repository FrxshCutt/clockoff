import { verifyEmailSchema } from "@clockoff/validation/auth";
import { verifyEmail } from "@/server/auth/service";
import { createHandler, json } from "@/server/http/apiHandler";
import { RATE_LIMITS } from "@/server/rateLimit";

/**
 * `POST /api/auth/verify-email` `{ token }` → `{ ok: true }`. Public: the link may be opened in a
 * browser without a session. `INVALID_TOKEN` / `TOKEN_EXPIRED` (400) otherwise.
 */
export const POST = createHandler(
  { auth: "public", body: verifyEmailSchema, rateLimit: RATE_LIMITS.verifyEmail },
  async ({ body }) => {
    await verifyEmail(body.token);
    return json({ ok: true });
  },
);
