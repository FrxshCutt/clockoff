import { createHandler } from "@/server/http/apiHandler";
import { previewManagerInvite } from "@/server/organisations";
import { managerInviteTokenParamsSchema } from "@/server/organisations/schemas";
import { RATE_LIMITS } from "@/server/rateLimit";

/**
 * `GET /api/invites/manager/:token` (public) → `managerInvitePreviewResponseSchema`. Unknown token →
 * `INVITE_INVALID` (404). Expired / revoked / accepted invites are returned with that `status`.
 */
export const GET = createHandler(
  {
    auth: "public",
    params: managerInviteTokenParamsSchema,
    rateLimit: RATE_LIMITS.lookupManagerInvite,
  },
  async ({ params }) => previewManagerInvite(params.token),
);
