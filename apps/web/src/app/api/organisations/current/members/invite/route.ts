import { createHandler } from "@/server/http/apiHandler";
import { resendManagerInvite } from "@/server/organisations";
import { resendManagerInviteSchema } from "@/server/organisations/schemas";
import { RATE_LIMITS } from "@/server/rateLimit";

/**
 * `POST /api/organisations/current/members/invite` (`members:invite`) `{ inviteId }` → `{ invite }`.
 * Re-sends a pending or expired invite with a fresh link and expiry (the old link stops working).
 */
export const POST = createHandler(
  {
    auth: "manager",
    permission: "members:invite",
    body: resendManagerInviteSchema,
    rateLimit: RATE_LIMITS.inviteManager,
  },
  async ({ ctx, body }) => ({ invite: await resendManagerInvite(ctx, body.inviteId) }),
);
