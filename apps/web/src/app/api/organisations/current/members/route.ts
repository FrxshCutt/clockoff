import { createHandler, json } from "@/server/http/apiHandler";
import { inviteMember, listMembers } from "@/server/organisations";
import { inviteMemberSchema } from "@/server/organisations/schemas";
import { RATE_LIMITS } from "@/server/rateLimit";

/** `GET /api/organisations/current/members` → `listMembersResponseSchema` `{ members, invites }`. */
export const GET = createHandler({ auth: "manager" }, async ({ ctx }) => listMembers(ctx));

/**
 * `POST /api/organisations/current/members` (`members:invite`) `{ email, role }` → 201 `{ invite }`.
 * The invite link is emailed only; it is never part of the response.
 */
export const POST = createHandler(
  {
    auth: "manager",
    permission: "members:invite",
    body: inviteMemberSchema,
    rateLimit: RATE_LIMITS.inviteManager,
  },
  async ({ ctx, body }) => json({ invite: await inviteMember(ctx, body) }, 201),
);
