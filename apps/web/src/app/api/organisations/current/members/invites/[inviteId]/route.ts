import { createHandler } from "@/server/http/apiHandler";
import { revokeManagerInvite } from "@/server/organisations";
import { inviteIdParamsSchema } from "@/server/organisations/schemas";

/** `DELETE /api/organisations/current/members/invites/:inviteId` (`members:invite`) → `{ invite }` (REVOKED). */
export const DELETE = createHandler(
  { auth: "manager", permission: "members:invite", params: inviteIdParamsSchema },
  async ({ ctx, params }) => ({ invite: await revokeManagerInvite(ctx, params.inviteId) }),
);
