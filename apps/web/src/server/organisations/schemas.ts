import { z } from "zod";
import { uuidSchema } from "@workmode/validation/common";

/**
 * Request schemas for the organisation / member routes.
 *
 * The body and response contracts live in `@workmode/validation` (`auth.ts`: createOrganisationSchema,
 * switchOrganisationSchema, acceptManagerInviteSchema; `organisation.ts`: updateOrganisationSchema,
 * inviteMemberSchema, updateMemberRoleSchema, resendManagerInviteSchema, managerInviteTokenParamsSchema
 * and every response shape) and are re-exported here so route files have one import site. Only the
 * dynamic-segment param schemas below are local; move them into `@workmode/validation/organisation`
 * when that module is next consolidated.
 */
export {
  acceptManagerInviteSchema,
  createOrganisationSchema,
  switchOrganisationSchema,
} from "@workmode/validation/auth";
export {
  inviteMemberSchema,
  managerInviteTokenParamsSchema,
  resendManagerInviteSchema,
  updateMemberRoleSchema,
  updateOrganisationSchema,
} from "@workmode/validation/organisation";

/** `/api/organisations/current/members/[membershipId]` */
export const membershipIdParamsSchema = z.object({ membershipId: uuidSchema }).strict();
export type MembershipIdParams = z.infer<typeof membershipIdParamsSchema>;

/** `/api/organisations/current/members/invites/[inviteId]` */
export const inviteIdParamsSchema = z.object({ inviteId: uuidSchema }).strict();
export type InviteIdParams = z.infer<typeof inviteIdParamsSchema>;
