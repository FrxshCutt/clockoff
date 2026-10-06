import { createHandler, json } from "@/server/http/apiHandler";
import { changeMemberRole, removeMember } from "@/server/organisations";
import { membershipIdParamsSchema, updateMemberRoleSchema } from "@/server/organisations/schemas";
import { ORG_COOKIE, clearCookie } from "@/lib/cookies";

/**
 * `PATCH /api/organisations/current/members/:membershipId` (`members:invite`) `{ role }` → `{ member }`.
 * Only owners grant/change OWNER; nobody grants above their own role; the last owner is protected
 * (`LAST_OWNER`, 409).
 */
export const PATCH = createHandler(
  {
    auth: "manager",
    permission: "members:invite",
    params: membershipIdParamsSchema,
    body: updateMemberRoleSchema,
  },
  async ({ ctx, params, body }) => ({
    member: await changeMemberRole(ctx, params.membershipId, body.role),
  }),
);

/**
 * `DELETE /api/organisations/current/members/:membershipId` → `{ ok: true, removedSelf }`. Removing
 * yourself (leaving) needs no permission; removing others needs `members:invite` (checked in the
 * service). The last owner cannot be removed.
 */
export const DELETE = createHandler(
  { auth: "manager", params: membershipIdParamsSchema },
  async ({ ctx, params }) => {
    const result = await removeMember(ctx, params.membershipId);
    return json(
      { ok: true, removedSelf: result.removedSelf },
      { cookies: result.removedSelf ? [clearCookie(ORG_COOKIE)] : [] },
    );
  },
);
