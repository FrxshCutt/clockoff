import { DATE_FORMATS, PLANS, BILLING_STATUSES, ROLES, type Role } from "@clockoff/shared/enums";
import {
  MANAGER_NOTIFICATION_TYPES,
  mergeNotificationPreferences,
  type NotificationPreferences,
} from "@clockoff/validation/notifications";
import {
  MANAGER_INVITE_STATES,
  ORGANISATION_SETTINGS_DEFAULTS,
  TIME_FORMATS,
  WEEK_STARTS,
  type OrganisationSettings,
} from "@clockoff/validation/organisation";
import { z } from "zod";
import { ROUTES, isInternalPath } from "@/config/navigation";
import { ApiClientError } from "@/lib/api-client";

/**
 * Tolerant readers for API responses the dashboard shell consumes. The task contract and the
 * `@clockoff/validation` schemas differ in a few envelope details (e.g. `{ items }` vs `{ members, invites }`);
 * these normalisers accept either so the UI keeps working whichever one the handlers ship, and they fail
 * loudly (INVALID_RESPONSE) instead of rendering `undefined` when neither matches.
 */

const roleSchema = z.enum(ROLES);

/** PENDING | ACCEPTED | EXPIRED | REVOKED (`ManagerInvite.status`). */
export type ManagerInviteState = (typeof MANAGER_INVITE_STATES)[number];

// ── GET /api/organisations/current ─────────────────────────────────────────

/** `Organisation.settings`; each key falls back to its default so an older/partial payload still renders. */
const organisationSettingsReader = z
  .object({
    weekStartsOn: z.enum(WEEK_STARTS).catch(ORGANISATION_SETTINGS_DEFAULTS.weekStartsOn),
    timeFormat: z.enum(TIME_FORMATS).catch(ORGANISATION_SETTINGS_DEFAULTS.timeFormat),
    requireInviteCodeToJoin: z
      .boolean()
      .catch(ORGANISATION_SETTINGS_DEFAULTS.requireInviteCodeToJoin),
  })
  .catch(ORGANISATION_SETTINGS_DEFAULTS);

const organisationSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string().optional().default(""),
  timezone: z.string(),
  dateFormat: z.enum(DATE_FORMATS).catch("DMY"),
  plan: z.enum(PLANS).catch("STARTER"),
  billingStatus: z.enum(BILLING_STATUSES).catch("TRIAL"),
  settings: organisationSettingsReader
    .optional()
    .transform((v): OrganisationSettings => v ?? ORGANISATION_SETTINGS_DEFAULTS),
});
export type OrganisationSummary = z.output<typeof organisationSummarySchema>;

const currentOrganisationSchema = z.object({
  organisation: organisationSummarySchema,
  membership: z.object({ id: z.string().optional(), role: roleSchema }).nullable().optional(),
  joinCode: z.object({ code: z.string() }).nullable().optional(),
});

export interface CurrentOrganisation {
  organisation: OrganisationSummary;
  /** Null when the endpoint omits it; callers fall back to the role from `/api/auth/me`. */
  role: Role | null;
  /** The caller's membership id (used to leave the organisation); null when the endpoint omits it. */
  membershipId: string | null;
  joinCode: string | null;
}

/** Parses `value` or throws `ApiClientError(INVALID_RESPONSE)` naming the endpoint and the mismatch. */
export function parseResponse<S extends z.ZodType>(
  schema: S,
  value: unknown,
  endpoint: string,
): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiClientError({
      code: "INVALID_RESPONSE",
      status: 200,
      message: `Unexpected response from ${endpoint}`,
      details: { endpoint, issues: z.prettifyError(result.error) },
    });
  }
  return result.data;
}

export function normalizeCurrentOrganisation(raw: unknown): CurrentOrganisation {
  const data = parseResponse(currentOrganisationSchema, raw, "GET /api/organisations/current");
  return {
    organisation: data.organisation,
    role: data.membership?.role ?? null,
    membershipId: data.membership?.id ?? null,
    joinCode: data.joinCode?.code ?? null,
  };
}

// ── Join code ───────────────────────────────────────────────────────────────

const joinCodeShapes = z.union([
  z.object({ current: z.object({ code: z.string() }).nullable() }),
  z.object({ joinCode: z.object({ code: z.string() }).nullable() }),
  z.object({ code: z.string() }),
]);

/** Accepts `{ current: { code } }`, `{ joinCode: { code } }` or `{ code }`; returns the active code or null. */
export function normalizeJoinCode(raw: unknown): string | null {
  const data = parseResponse(joinCodeShapes, raw, "join code");
  if ("current" in data) return data.current?.code ?? null;
  if ("joinCode" in data) return data.joinCode?.code ?? null;
  return data.code;
}

// ── Members ─────────────────────────────────────────────────────────────────

const memberRowSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    name: z.string(),
    email: z.string(),
    role: roleSchema,
    joinedAt: z.string().optional(),
    createdAt: z.string().optional(),
    lastLoginAt: z.string().nullable().optional(),
    isCurrentUser: z.boolean().optional(),
  })
  .transform((m) => ({
    id: m.id,
    userId: m.userId,
    name: m.name,
    email: m.email,
    role: m.role,
    joinedAt: m.joinedAt ?? m.createdAt ?? null,
    lastLoginAt: m.lastLoginAt ?? null,
    isCurrentUser: m.isCurrentUser ?? null,
  }));
export type MemberRow = z.output<typeof memberRowSchema>;

const managerInviteRowSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: roleSchema,
  // Any string, so one invite in a state this UI doesn't know yet can't fail the whole members list.
  status: z.string(),
  expiresAt: z.string(),
  createdAt: z.string().optional(),
});

/** Invite states that can still be acted on (re-sent or revoked). */
const OPEN_INVITE_STATUSES = [
  "PENDING",
  "EXPIRED",
] as const satisfies readonly ManagerInviteState[];
type OpenInviteStatus = (typeof OPEN_INVITE_STATUSES)[number];

export type PendingManagerInvite = Omit<z.infer<typeof managerInviteRowSchema>, "status"> & {
  status: OpenInviteStatus;
};

function isOpenInvite(
  invite: z.infer<typeof managerInviteRowSchema>,
): invite is PendingManagerInvite {
  return (OPEN_INVITE_STATUSES as readonly string[]).includes(invite.status);
}

const membersShapes = z.union([
  z.object({
    members: z.array(memberRowSchema),
    invites: z.array(managerInviteRowSchema).optional(),
  }),
  z.object({
    items: z.array(memberRowSchema),
    invites: z.array(managerInviteRowSchema).optional(),
  }),
]);

export interface MembersList {
  members: MemberRow[];
  /**
   * Invites not yet accepted: PENDING ones, plus EXPIRED ones (which can be re-sent with a fresh link).
   * Accepted and revoked invites are history and left out.
   */
  pendingInvites: PendingManagerInvite[];
}

export function normalizeMembers(raw: unknown): MembersList {
  const data = parseResponse(membersShapes, raw, "GET /api/organisations/current/members");
  const members = "members" in data ? data.members : data.items;
  const pendingInvites = (data.invites ?? []).filter(isOpenInvite);
  return { members, pendingInvites };
}

// ── Manager invite preview / accept ─────────────────────────────────────────

/**
 * A state this UI version doesn't know reads as "not reported" (null): the accept form is shown and the API,
 * which is the authority on whether the invite can be used, answers the accept request.
 */
const invitePreviewStatus = z.enum(MANAGER_INVITE_STATES).optional().catch(undefined);

const invitePreviewShapes = z.union([
  z.object({
    organisation: z.object({ name: z.string() }),
    email: z.string(),
    role: roleSchema,
    invitedByName: z.string().nullable().optional(),
    expiresAt: z.string(),
    status: invitePreviewStatus,
    requiresAccount: z.boolean(),
  }),
  z.object({
    organisationName: z.string(),
    email: z.string(),
    role: roleSchema,
    invitedByName: z.string().nullable().optional(),
    expiresAt: z.string(),
    status: invitePreviewStatus,
    requiresAccount: z.boolean(),
  }),
]);

export interface InvitePreview {
  organisationName: string;
  email: string;
  role: Role;
  invitedByName: string | null;
  expiresAt: string;
  /** The invite's state when the API reports one this UI knows; null otherwise (treated as usable). */
  status: ManagerInviteState | null;
  requiresAccount: boolean;
}

export function normalizeInvitePreview(raw: unknown): InvitePreview {
  const data = parseResponse(invitePreviewShapes, raw, "GET /api/invites/manager/:token");
  return {
    organisationName: "organisation" in data ? data.organisation.name : data.organisationName,
    email: data.email,
    role: data.role,
    invitedByName: data.invitedByName ?? null,
    expiresAt: data.expiresAt,
    status: data.status ?? null,
    requiresAccount: data.requiresAccount,
  };
}

const acceptInviteShapes = z.union([
  z.object({ organisationId: z.string() }),
  z.object({ organisation: z.object({ id: z.string() }) }),
  z.object({ ok: z.literal(true) }),
]);

/** Returns the organisation joined, when the response says which. */
export function normalizeAcceptInvite(raw: unknown): { organisationId: string | null } {
  const data = parseResponse(
    acceptInviteShapes,
    raw,
    "POST /api/organisations/current/members/accept",
  );
  if ("organisationId" in data) return { organisationId: data.organisationId };
  if ("organisation" in data) return { organisationId: data.organisation.id };
  return { organisationId: null };
}

// ── Onboarding ──────────────────────────────────────────────────────────────

const onboardingSchema = z.object({
  items: z.array(
    z.object({ key: z.string(), label: z.string(), done: z.boolean(), href: z.string() }),
  ),
  complete: z.boolean().optional(),
  allDone: z.boolean().optional(),
  dismissedAt: z.string().nullable().optional(),
});

export interface OnboardingChecklist {
  items: { key: string; label: string; done: boolean; href: string }[];
  completedCount: number;
  totalCount: number;
  complete: boolean;
  dismissedAt: string | null;
}

export function normalizeOnboarding(raw: unknown): OnboardingChecklist {
  const data = parseResponse(onboardingSchema, raw, "GET /api/organisations/current/onboarding");
  const completedCount = data.items.filter((item) => item.done).length;
  return {
    // Links are rendered as-is, so only same-origin paths are kept (anything else points at the overview).
    items: data.items.map((item) => ({
      ...item,
      href: isInternalPath(item.href) ? item.href : ROUTES.overview,
    })),
    completedCount,
    totalCount: data.items.length,
    complete: data.complete ?? data.allDone ?? completedCount === data.items.length,
    dismissedAt: data.dismissedAt ?? null,
  };
}

// ── Notifications ───────────────────────────────────────────────────────────

const notificationSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  body: z.string(),
  readAt: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type NotificationItem = {
  id: string;
  type: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
};

const notificationsSchema = z.object({
  items: z.array(notificationSchema),
  unreadCount: z.number().int().min(0).optional(),
});

export interface NotificationsFeed {
  items: NotificationItem[];
  unreadCount: number;
}

export function normalizeNotifications(raw: unknown): NotificationsFeed {
  const data = parseResponse(notificationsSchema, raw, "GET /api/notifications");
  const items = data.items.map((n) => ({ ...n, readAt: n.readAt ?? null }));
  return {
    items,
    unreadCount: data.unreadCount ?? items.filter((n) => n.readAt === null).length,
  };
}

export const EMPTY_NOTIFICATIONS: NotificationsFeed = { items: [], unreadCount: 0 };

// ── Settings: notification preferences (GET /api/settings) ─────────────────

const settingsNotificationShape = z.object({ notificationPreferences: z.unknown() });

/**
 * The caller's notification preferences from `GET /api/settings` (or the `PATCH` response). Every type is
 * always present: missing or invalid entries fall back to the defaults.
 */
export function normalizeNotificationPreferences(raw: unknown): NotificationPreferences {
  const data = parseResponse(settingsNotificationShape, raw, "GET /api/settings");
  return mergeNotificationPreferences(data.notificationPreferences);
}

export { MANAGER_NOTIFICATION_TYPES };

// ── Billing (GET /api/settings/billing) ────────────────────────────────────

const limitValue = z.union([z.number().int().min(0), z.literal("UNLIMITED")]);

const billingSchema = z.object({
  plan: z.enum(PLANS),
  planName: z.string(),
  billingStatus: z.enum(BILLING_STATUSES),
  limits: z.object({ employees: limitValue, locations: limitValue, integrations: limitValue }),
  usage: z.object({
    employees: z.number().int().min(0),
    locations: z.number().int().min(0),
    integrations: z.number().int().min(0),
  }),
  trialEndsAt: z.string().nullable().optional(),
  manageUrl: z.string().nullable().optional(),
});

export type BillingSummary = Omit<z.infer<typeof billingSchema>, "trialEndsAt" | "manageUrl"> & {
  trialEndsAt: string | null;
  /** Only http(s) URLs are kept, so a bad value can never become a `javascript:` link. */
  manageUrl: string | null;
};

function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function normalizeBilling(raw: unknown): BillingSummary {
  const data = parseResponse(billingSchema, raw, "GET /api/settings/billing");
  return { ...data, trialEndsAt: data.trialEndsAt ?? null, manageUrl: safeHttpUrl(data.manageUrl) };
}
