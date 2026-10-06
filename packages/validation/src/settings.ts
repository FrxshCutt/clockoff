import { z } from "zod";
import { billingStatusSchema, planSchema, roleSchema } from "./enumSchemas";
import {
  notificationPreferencesSchema,
  updateNotificationPreferencesSchema,
} from "./notifications";
import { organisationSchema, updateOrganisationSchema } from "./organisation";
import { nullableInstantSchema } from "./primitives";

/**
 * Settings page (§5 settings): organisation settings (OWNER/ADMIN, `org:manage`) and the caller's own
 * notification preferences (any member) in one resource.
 */

/** `GET /api/settings` */
export const settingsResponseSchema = z
  .object({
    organisation: organisationSchema,
    /** The caller's role in the current organisation (the UI disables what it cannot change). */
    role: roleSchema,
    notificationPreferences: notificationPreferencesSchema,
  })
  .meta({ id: "SettingsResponse" });
export type SettingsResponse = z.infer<typeof settingsResponseSchema>;

/**
 * `PATCH /api/settings` — `organisation` requires `org:manage` (FORBIDDEN otherwise);
 * `notificationPreferences` only ever touches the caller's own membership.
 */
export const updateSettingsSchema = z
  .object({
    organisation: updateOrganisationSchema.optional(),
    notificationPreferences: updateNotificationPreferencesSchema.optional(),
  })
  .strict()
  .refine((v) => v.organisation !== undefined || v.notificationPreferences !== undefined, {
    message: "Nothing to update",
  });
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

const limitValueSchema = z
  .union([z.int().min(0), z.literal("UNLIMITED")])
  .meta({ id: "PlanLimitValue", description: "A count, or UNLIMITED." });

/** `GET /api/settings/billing` — read-only plan information; there is no in-app checkout in the MVP. */
export const billingResponseSchema = z
  .object({
    plan: planSchema,
    planName: z.string(),
    billingStatus: billingStatusSchema,
    limits: z.object({
      employees: limitValueSchema,
      locations: limitValueSchema,
      integrations: limitValueSchema,
    }),
    usage: z.object({
      employees: z.int().min(0),
      locations: z.int().min(0),
      integrations: z.int().min(0),
    }),
    /** End of the trial while billingStatus is TRIAL. */
    trialEndsAt: nullableInstantSchema,
    /** Where an OWNER manages the subscription; null until billing is wired up. */
    manageUrl: z.url().nullable(),
  })
  .meta({ id: "BillingResponse" });
export type BillingResponse = z.infer<typeof billingResponseSchema>;
