/**
 * Request schemas for the organisation / member routes.
 *
 * Every contract lives in `@workmode/validation` (`auth.ts`: createOrganisationSchema,
 * switchOrganisationSchema, acceptManagerInviteSchema; `organisation.ts`: updateOrganisationSchema,
 * inviteMemberSchema, updateMemberRoleSchema, resendManagerInviteSchema, managerInviteTokenParamsSchema,
 * the dynamic-segment param schemas and every response shape) and is re-exported here so route files
 * have one import site. Nothing is defined locally.
 */
export {
  acceptManagerInviteSchema,
  createOrganisationSchema,
  switchOrganisationSchema,
} from "@workmode/validation/auth";
export {
  inviteMemberSchema,
  managerInviteIdParamsSchema,
  managerInviteTokenParamsSchema,
  membershipIdParamsSchema,
  resendManagerInviteSchema,
  updateMemberRoleSchema,
  updateOrganisationSchema,
} from "@workmode/validation/organisation";
export type { ManagerInviteIdParams, MembershipIdParams } from "@workmode/validation/organisation";

/** `/api/organisations/current/members/invites/[inviteId]` — alias of `managerInviteIdParamsSchema`. */
export { managerInviteIdParamsSchema as inviteIdParamsSchema } from "@workmode/validation/organisation";
export type { ManagerInviteIdParams as InviteIdParams } from "@workmode/validation/organisation";
