import { prisma, type Prisma } from "@clockoff/db";
import { PLANS } from "@clockoff/shared/enums";
import { AppError } from "@clockoff/shared/errors";
import { PLAN_CONFIG, planLimitsFor } from "@clockoff/shared/plans";
import {
  mergeNotificationPreferences,
  type NotificationPreferences,
  type UpdateNotificationPreferencesInput,
} from "@clockoff/validation/notifications";
import type { Organisation } from "@clockoff/validation/organisation";
import type {
  BillingResponse,
  PlanCatalogEntry,
  SettingsResponse,
  UpdateSettingsInput,
} from "@clockoff/validation/settings";
import { audit, toJsonValue } from "@/server/audit/audit";
import { toOrganisationDto, updateCurrentOrganisation } from "@/server/organisations";
import { requirePermission, type ManagerContext } from "@/server/tenancy/context";
import { countBillingUsage, findMembershipInOrganisation } from "./settings.repository";

/**
 * Settings (§5 settings): the organisation's own fields (name, timezone, date format, settings JSON —
 * `org:manage`, delegated to the organisations service so there is one audited code path) plus the
 * caller's notification preferences, which only ever touch the caller's own membership. Billing is
 * read-only plan information (no payment processing in the MVP).
 */

/** `GET /api/settings` */
export function getSettings(ctx: ManagerContext): SettingsResponse {
  return {
    organisation: toOrganisationDto(ctx.organisation),
    role: ctx.membership.role,
    notificationPreferences: mergeNotificationPreferences(ctx.membership.notificationPreferences),
  };
}

/**
 * `PATCH /api/settings`: `organisation` needs `org:manage` (checked before anything is written);
 * `notificationPreferences` are merged key by key over the caller's stored preferences.
 */
export async function updateSettings(
  ctx: ManagerContext,
  input: UpdateSettingsInput,
): Promise<SettingsResponse> {
  if (input.organisation !== undefined) requirePermission(ctx, "org:manage");

  let organisation: Organisation = toOrganisationDto(ctx.organisation);
  if (input.organisation !== undefined) {
    organisation = await updateCurrentOrganisation(ctx, input.organisation);
  }

  let notificationPreferences = mergeNotificationPreferences(
    ctx.membership.notificationPreferences,
  );
  if (input.notificationPreferences !== undefined) {
    notificationPreferences = await updateOwnNotificationPreferences(
      ctx,
      input.notificationPreferences,
    );
  }
  return { organisation, role: ctx.membership.role, notificationPreferences };
}

/** Patch the caller's own `OrganisationMembership.notificationPreferences`. Audited. */
export async function updateOwnNotificationPreferences(
  ctx: ManagerContext,
  patch: UpdateNotificationPreferencesInput,
): Promise<NotificationPreferences> {
  return prisma.$transaction(async (tx) => {
    const membership = await findMembershipInOrganisation(
      ctx.organisation.id,
      ctx.membership.id,
      tx,
    );
    if (!membership) throw new AppError("NOT_FOUND", "Membership not found");
    const before = mergeNotificationPreferences(membership.notificationPreferences);
    const after = mergeNotificationPreferences(membership.notificationPreferences, patch);
    await tx.organisationMembership.update({
      where: { id: membership.id },
      data: { notificationPreferences: toJsonValue(after) as Prisma.InputJsonValue },
    });
    await audit(
      ctx,
      {
        action: "membership.notification_preferences_updated",
        entityType: "OrganisationMembership",
        entityId: membership.id,
        before,
        after,
      },
      tx,
    );
    return after;
  });
}

/** The plan catalogue as the billing page renders it; the organisation's plan is flagged `isCurrent`. */
export function planCatalog(currentPlan: Organisation["plan"]): PlanCatalogEntry[] {
  return PLANS.map((plan) => {
    const definition = PLAN_CONFIG[plan];
    return {
      id: plan,
      name: definition.name,
      priceLabel: definition.priceLabel,
      limits: { ...definition.limits },
      features: [...definition.features],
      isCurrent: plan === currentPlan,
    };
  });
}

/**
 * `GET /api/settings/billing`: plan, limits (`planLimitsFor`), live usage and the catalogue. `trialEndsAt`
 * and `manageUrl` are null until billing is wired up (no trial-end column or payment provider exist yet).
 */
export async function getBilling(ctx: ManagerContext): Promise<BillingResponse> {
  const plan = ctx.organisation.plan;
  const limits = planLimitsFor(plan);
  const usage = await countBillingUsage(ctx.organisation.id);
  return {
    plan,
    planName: PLAN_CONFIG[plan].name,
    billingStatus: ctx.organisation.billingStatus,
    limits: {
      employees: limits.employees,
      locations: limits.locations,
      integrations: limits.integrations,
    },
    usage,
    trialEndsAt: null,
    manageUrl: null,
    plans: planCatalog(plan),
  };
}
