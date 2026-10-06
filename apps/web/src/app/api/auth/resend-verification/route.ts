import { resendVerificationSchema } from "@workmode/validation/auth";
import { resendVerification } from "@/server/auth/service";
import { createHandler, json } from "@/server/http/apiHandler";
import { RATE_LIMITS } from "@/server/rateLimit";

/** `POST /api/auth/resend-verification` (signed in) → `{ ok: true, alreadyVerified }`. */
export const POST = createHandler(
  { auth: "user", body: resendVerificationSchema, rateLimit: RATE_LIMITS.resendVerification },
  async ({ ctx }) => {
    const result = await resendVerification(ctx);
    return json({ ok: true, alreadyVerified: result.alreadyVerified });
  },
);
