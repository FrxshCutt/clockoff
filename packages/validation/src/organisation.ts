import { z } from "zod";
import { emailSchema, nonEmptyString, timezoneSchema, uuidSchema } from "./common";
import {
  billingStatusSchema,
  dateFormatSchema,
  joinCodeStatusSchema,
  permissionSchema,
  planSchema,
  roleSchema,
} from "./enumSchemas";
import { instantSchema, nullableInstantSchema, okResponseSchema } from "./primitives";
import { namedRefSchema } from "./refs";

// ── Organisation ────────────────────────────────────────────────────────────

export const WEEK_STARTS = ["MONDAY", "SUNDAY"] as const;
export const TIME_FORMATS = ["H24", "H12"] as const;

const organisationSettingsBase = z
  .object({
    weekStartsOn: z.enum(WEEK_STARTS),
    timeFormat: z.enum(TIME_FORMATS),
    /** Require the per-employee invite code on join even when the name match is unambiguous. */
    requireInviteCodeToJoin: z.boolean(),
  })
  .strict();

/** `Organisation.settings` (JSON column). Responses always contain every key (defaults applied). */
export const organisationSettingsSchema = organisationSettingsBase.meta({
  id: "OrganisationSettings",
});
export type OrganisationSettings = z.infer<typeof organisationSettingsSchema>;

export const ORGANISATION_SETTINGS_DEFAULTS: OrganisationSettings = {
  weekStartsOn: "MONDAY",
  timeFormat: "H24",
  requireInviteCodeToJoin: false,
};

export const organisationSchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
    slug: z.string(),
    timezone: z.string(),
    dateFormat: dateFormatSchema,
    defaultPolicyId: uuidSchema.nullable(),
    defaultBreakPolicyId: uuidSchema.nullable(),
    billingStatus: billingStatusSchema,
    plan: planSchema,
    settings: organisationSettingsSchema,
    onboardingDismissedAt: nullableInstantSchema,
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .meta({ id: "Organisation" });
export type Organisation = z.infer<typeof organisationSchema>;

export const organisationResponseSchema = z
  .object({ organisation: organisationSchema })
  .meta({ id: "OrganisationResponse" });
export type OrganisationResponse = z.infer<typeof organisationResponseSchema>;

/** The ACTIVE company join code as embedded in organisation responses (full history: `joinCodeResponseSchema`). */
export const joinCodeRefSchema = z
  .object({ id: uuidSchema, code: z.string(), status: joinCodeStatusSchema })
  .meta({ id: "JoinCodeRef" });
export type JoinCodeRef = z.infer<typeof joinCodeRefSchema>;

/** The caller's membership of the current organisation, so the UI can hide actions it cannot take. */
export const organisationMembershipSchema = z
  .object({
    /** Membership id. */
    id: uuidSchema,
    role: roleSchema,
    /** Effective permissions of `role` (ROLE_PERMISSIONS), sorted. */
    permissions: z.array(permissionSchema),
  })
  .meta({ id: "OrganisationMembership" });
export type OrganisationMembership = z.infer<typeof organisationMembershipSchema>;

/** `GET /api/organisations/current` */
export const currentOrganisationResponseSchema = z
  .object({
    organisation: organisationSchema,
    membership: organisationMembershipSchema,
    /** Null when the join code was revoked and not regenerated. */
    joinCode: joinCodeRefSchema.nullable(),
  })
  .meta({ id: "CurrentOrganisationResponse" });
export type CurrentOrganisationResponse = z.infer<typeof currentOrganisationResponseSchema>;

/** `POST /api/organisations` (201) — the new organisation, its ACTIVE join code and the optional first location. */
export const createOrganisationResponseSchema = z
  .object({
    organisation: organisationSchema,
    joinCode: joinCodeRefSchema,
    location: namedRefSchema.nullable(),
  })
  .meta({ id: "CreateOrganisationResponse" });
export type CreateOrganisationResponse = z.infer<typeof createOrganisationResponseSchema>;

export const organisationWithRoleSchema = organisationSchema
  .extend({ role: roleSchema })
  .meta({ id: "OrganisationWithRole" });
export type OrganisationWithRole = z.infer<typeof organisationWithRoleSchema>;

/** `GET /api/organisations` — every organisation the signed-in manager belongs to, oldest membership first. */
export const listOrganisationsResponseSchema = z
  .object({ organisations: z.array(organisationWithRoleSchema) })
  .meta({ id: "ListOrganisationsResponse" });
export type ListOrganisationsResponse = z.infer<typeof listOrganisationsResponseSchema>;

/** `PATCH /api/organisations/current` */
export const updateOrganisationSchema = z
  .object({
    name: nonEmptyString(120).optional(),
    timezone: timezoneSchema.optional(),
    dateFormat: dateFormatSchema.optional(),
    settings: organisationSettingsBase.partial().optional(),
  })
  .strict();
export type UpdateOrganisationInput = z.infer<typeof updateOrganisationSchema>;

// ── Onboarding checklist ────────────────────────────────────────────────────

export const ONBOARDING_STEP_KEYS = [
  "createCompany",
  "createPolicy",
  "configureBreakRules",
  "addEmployees",
  "addSchedules",
  "inviteEmployees",
  "employeesConnect",
  "goLive",
] as const;
export type OnboardingStepKey = (typeof ONBOARDING_STEP_KEYS)[number];
export const onboardingStepKeySchema = z
  .enum(ONBOARDING_STEP_KEYS)
  .meta({ id: "OnboardingStepKey" });

export const ONBOARDING_STEP_LABELS: Record<OnboardingStepKey, string> = {
  createCompany: "Create your company",
  createPolicy: "Create a Work Policy",
  configureBreakRules: "Configure break rules",
  addEmployees: "Add employees",
  addSchedules: "Add schedules",
  inviteEmployees: "Invite employees",
  employeesConnect: "Employees connect their phones",
  goLive: "Go live",
};

export const onboardingItemSchema = z
  .object({
    key: onboardingStepKeySchema,
    label: z.string(),
    done: z.boolean(),
    /** Dashboard route that completes the step, e.g. `/policies/new`. */
    href: z.string(),
  })
  .meta({ id: "OnboardingItem" });
export type OnboardingItem = z.infer<typeof onboardingItemSchema>;

/** `GET /api/organisations/current/onboarding` */
export const onboardingResponseSchema = z
  .object({
    items: z.array(onboardingItemSchema),
    completedCount: z.int().min(0),
    totalCount: z.int().min(0),
    allDone: z.boolean(),
    dismissedAt: nullableInstantSchema,
  })
  .meta({ id: "OnboardingResponse" });
export type OnboardingResponse = z.infer<typeof onboardingResponseSchema>;

// ── Members (managers) & manager invites ────────────────────────────────────

export const memberSchema = z
  .object({
    /** Membership id (not the user id). */
    id: uuidSchema,
    userId: uuidSchema,
    name: z.string(),
    email: z.string(),
    role: roleSchema,
    emailVerified: z.boolean(),
    lastLoginAt: nullableInstantSchema,
    joinedAt: instantSchema,
    /** True for the membership of the caller. */
    isCurrentUser: z.boolean(),
  })
  .meta({ id: "Member" });
export type Member = z.infer<typeof memberSchema>;

export const MANAGER_INVITE_STATES = ["PENDING", "ACCEPTED", "EXPIRED", "REVOKED"] as const;
export const managerInviteStateSchema = z
  .enum(MANAGER_INVITE_STATES)
  .meta({ id: "ManagerInviteState" });

export const managerInviteSchema = z
  .object({
    id: uuidSchema,
    email: z.string(),
    role: roleSchema,
    status: managerInviteStateSchema,
    invitedBy: namedRefSchema.nullable(),
    expiresAt: instantSchema,
    acceptedAt: nullableInstantSchema,
    revokedAt: nullableInstantSchema,
    createdAt: instantSchema,
  })
  .meta({ id: "ManagerInvite" });
export type ManagerInvite = z.infer<typeof managerInviteSchema>;

/** `GET /api/organisations/current/members` */
export const listMembersResponseSchema = z
  .object({ members: z.array(memberSchema), invites: z.array(managerInviteSchema) })
  .meta({ id: "ListMembersResponse" });
export type ListMembersResponse = z.infer<typeof listMembersResponseSchema>;

/** `POST /api/organisations/current/members` — invite a manager. */
export const inviteMemberSchema = z.object({ email: emailSchema, role: roleSchema }).strict();
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const managerInviteResponseSchema = z
  .object({ invite: managerInviteSchema })
  .meta({ id: "ManagerInviteResponse" });
export type ManagerInviteResponse = z.infer<typeof managerInviteResponseSchema>;

/** `:membershipId` of `/api/organisations/current/members/:membershipId` (a membership id, not a user id). */
export const membershipIdParamsSchema = z.object({ membershipId: uuidSchema }).strict();
export type MembershipIdParams = z.infer<typeof membershipIdParamsSchema>;

/** `:inviteId` of `DELETE /api/organisations/current/members/invites/:inviteId`. */
export const managerInviteIdParamsSchema = z.object({ inviteId: uuidSchema }).strict();
export type ManagerInviteIdParams = z.infer<typeof managerInviteIdParamsSchema>;

/** `PATCH /api/organisations/current/members/:membershipId` */
export const updateMemberRoleSchema = z.object({ role: roleSchema }).strict();
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;

export const memberResponseSchema = z
  .object({ member: memberSchema })
  .meta({ id: "MemberResponse" });
export type MemberResponse = z.infer<typeof memberResponseSchema>;

/** `DELETE /api/organisations/current/members/:membershipId` — `removedSelf` when the caller left. */
export const removeMemberResponseSchema = z
  .object({ ok: z.literal(true), removedSelf: z.boolean() })
  .meta({ id: "RemoveMemberResponse" });
export type RemoveMemberResponse = z.infer<typeof removeMemberResponseSchema>;

/** `POST /api/organisations/current/members/invite` — re-send a pending manager invite. */
export const resendManagerInviteSchema = z.object({ inviteId: uuidSchema }).strict();
export type ResendManagerInviteInput = z.infer<typeof resendManagerInviteSchema>;

export const managerInviteTokenParamsSchema = z
  .object({ token: z.string().min(20).max(500) })
  .strict();
export type ManagerInviteTokenParams = z.infer<typeof managerInviteTokenParamsSchema>;

/** `GET /api/invites/manager/:token` — public preview shown before accepting. */
export const managerInvitePreviewResponseSchema = z
  .object({
    organisation: z.object({ name: z.string() }),
    email: z.string(),
    role: roleSchema,
    invitedByName: z.string().nullable(),
    expiresAt: instantSchema,
    status: managerInviteStateSchema,
    /** True when no account exists for the invited email yet (accept must include name + password). */
    requiresAccount: z.boolean(),
  })
  .meta({ id: "ManagerInvitePreviewResponse" });
export type ManagerInvitePreviewResponse = z.infer<typeof managerInvitePreviewResponseSchema>;

/** `POST /api/organisations/current/members/accept` */
export const acceptManagerInviteResponseSchema = z
  .object({
    organisation: namedRefSchema,
    role: roleSchema,
    /** True when a new manager account was created as part of accepting. */
    createdAccount: z.boolean(),
    /** Accepting signs the invitee in (session cookies are set); echo this as `x-csrf-token`. */
    csrfToken: z.string(),
  })
  .meta({ id: "AcceptManagerInviteResponse" });
export type AcceptManagerInviteResponse = z.infer<typeof acceptManagerInviteResponseSchema>;

// ── Company join code ───────────────────────────────────────────────────────

export const joinCodeSchema = z
  .object({
    id: uuidSchema,
    code: z.string(),
    status: joinCodeStatusSchema,
    createdBy: namedRefSchema.nullable(),
    createdAt: instantSchema,
    revokedAt: nullableInstantSchema,
  })
  .meta({ id: "JoinCode" });
export type JoinCode = z.infer<typeof joinCodeSchema>;

/** `GET /api/organisations/current/join-code` (and the regenerate / revoke responses). */
export const joinCodeResponseSchema = z
  .object({
    current: joinCodeSchema.nullable(),
    /** Previous codes, newest first. */
    history: z.array(joinCodeSchema),
  })
  .meta({ id: "JoinCodeResponse" });
export type JoinCodeResponse = z.infer<typeof joinCodeResponseSchema>;

// ── Demo requests (marketing site) ──────────────────────────────────────────

/**
 * `POST /api/request-demo` (public, rate limited per IP). `website` is a honeypot: real visitors never see
 * the field, so a non-empty value marks a bot and the request is accepted but not stored.
 */
export const requestDemoSchema = z
  .object({
    name: nonEmptyString(120),
    email: emailSchema,
    company: nonEmptyString(160),
    /** Free text such as "10-25", "50+" (the form offers a fixed set of bands). */
    teamSize: z.string().trim().max(40).optional(),
    message: z.string().trim().max(2000).optional(),
    /** Where the request came from (page or campaign), e.g. `pricing`. */
    source: z.string().trim().max(100).optional(),
    /** Honeypot — must stay empty. */
    website: z.string().max(200).optional(),
  })
  .strict();
export type RequestDemoInput = z.infer<typeof requestDemoSchema>;

/** Always `{ ok: true }`: the response never reveals whether the request was stored. */
export const requestDemoResponseSchema = okResponseSchema;
export type RequestDemoResponse = z.infer<typeof requestDemoResponseSchema>;
