import { changePasswordSchema } from "@clockoff/validation/auth";
import { changePassword } from "@/server/auth/service";
import { createHandler, json } from "@/server/http/apiHandler";
import { RATE_LIMITS } from "@/server/rateLimit";

/**
 * `POST /api/auth/change-password` `{ currentPassword, newPassword }` → `{ ok: true, revokedSessions }`.
 * Every other session of the user is revoked; the current one stays signed in.
 */
export const POST = createHandler(
  { auth: "user", body: changePasswordSchema, rateLimit: RATE_LIMITS.changePassword },
  async ({ ctx, body }) => {
    const result = await changePassword(ctx, body);
    return json({ ok: true, revokedSessions: result.revokedSessions });
  },
);
