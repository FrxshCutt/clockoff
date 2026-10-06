import type {
  ManagerInvite as ManagerInviteRow,
  Organisation as OrganisationRow,
  OrganisationMembership,
  Prisma,
  User,
} from "@workmode/db";
import {
  ORGANISATION_SETTINGS_DEFAULTS,
  organisationSettingsSchema,
  type ManagerInvite,
  type Member,
  type Organisation,
  type OrganisationSettings,
} from "@workmode/validation/organisation";

/**
 * Row → API DTO mappers for organisations, members and manager invites. Instants are emitted as UTC
 * ISO-8601 strings; JSON columns are normalised so responses always carry every documented key.
 */

/** Shape of `organisations.onboarding_state`. Unknown keys are preserved on write. */
export interface OnboardingState {
  createCompany?: boolean;
  dismissedAt?: string | null;
  [key: string]: unknown;
}

function asRecord(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function readOnboardingState(value: Prisma.JsonValue): OnboardingState {
  return asRecord(value) as OnboardingState;
}

export function onboardingDismissedAt(value: Prisma.JsonValue): string | null {
  const dismissedAt = readOnboardingState(value).dismissedAt;
  return typeof dismissedAt === "string" && !Number.isNaN(Date.parse(dismissedAt))
    ? new Date(dismissedAt).toISOString()
    : null;
}

/**
 * Stored settings merged over the defaults, key by key: a stored value that no longer validates (e.g.
 * written by an older version) falls back to the default instead of failing the whole response.
 */
export function readOrganisationSettings(value: Prisma.JsonValue): OrganisationSettings {
  const stored = asRecord(value);
  const merged: Record<string, unknown> = { ...ORGANISATION_SETTINGS_DEFAULTS };
  for (const key of Object.keys(ORGANISATION_SETTINGS_DEFAULTS) as Array<
    keyof OrganisationSettings
  >) {
    if (!(key in stored)) continue;
    const candidate = { ...ORGANISATION_SETTINGS_DEFAULTS, [key]: stored[key] };
    if (organisationSettingsSchema.safeParse(candidate).success) merged[key] = stored[key];
  }
  return merged as OrganisationSettings;
}

export function toOrganisationDto(org: OrganisationRow): Organisation {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    timezone: org.timezone,
    dateFormat: org.dateFormat,
    defaultPolicyId: org.defaultPolicyId,
    defaultBreakPolicyId: org.defaultBreakPolicyId,
    billingStatus: org.billingStatus,
    plan: org.plan,
    settings: readOrganisationSettings(org.settings),
    onboardingDismissedAt: onboardingDismissedAt(org.onboardingState),
    createdAt: org.createdAt.toISOString(),
    updatedAt: org.updatedAt.toISOString(),
  };
}

export function toMemberDto(
  membership: OrganisationMembership & {
    user: Pick<User, "id" | "name" | "email" | "emailVerifiedAt" | "lastLoginAt">;
  },
  currentUserId: string,
): Member {
  return {
    id: membership.id,
    userId: membership.userId,
    name: membership.user.name,
    email: membership.user.email,
    role: membership.role,
    emailVerified: Boolean(membership.user.emailVerifiedAt),
    lastLoginAt: membership.user.lastLoginAt?.toISOString() ?? null,
    joinedAt: membership.createdAt.toISOString(),
    isCurrentUser: membership.userId === currentUserId,
  };
}

export type ManagerInviteState = ManagerInvite["status"];

export function managerInviteState(
  invite: Pick<ManagerInviteRow, "acceptedAt" | "revokedAt" | "expiresAt">,
  now: Date = new Date(),
): ManagerInviteState {
  if (invite.acceptedAt) return "ACCEPTED";
  if (invite.revokedAt) return "REVOKED";
  if (invite.expiresAt.getTime() <= now.getTime()) return "EXPIRED";
  return "PENDING";
}

export function toManagerInviteDto(
  invite: ManagerInviteRow & { invitedBy: Pick<User, "id" | "name"> | null },
  now: Date = new Date(),
): ManagerInvite {
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    status: managerInviteState(invite, now),
    invitedBy: invite.invitedBy ? { id: invite.invitedBy.id, name: invite.invitedBy.name } : null,
    expiresAt: invite.expiresAt.toISOString(),
    acceptedAt: invite.acceptedAt?.toISOString() ?? null,
    revokedAt: invite.revokedAt?.toISOString() ?? null,
    createdAt: invite.createdAt.toISOString(),
  };
}
