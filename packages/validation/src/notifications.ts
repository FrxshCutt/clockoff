import { z } from "zod";
import { cursorPaginationQuerySchema, paginatedResponseSchema, uuidSchema } from "./common";
import { notificationChannelSchema } from "./enumSchemas";
import {
  instantSchema,
  jsonObjectSchema,
  nullableInstantSchema,
  queryBooleanSchema,
} from "./primitives";

/**
 * In-app notifications for managers (§5 notifications) and the per-manager notification preferences
 * stored on `OrganisationMembership.notificationPreferences`.
 */

/** Kinds of manager notification. `Notification.type` stores one of these. */
export const MANAGER_NOTIFICATION_TYPES = [
  "EMPLOYEE_JOINED",
  "PERMISSION_NEEDS_ATTENTION",
  "DEVICE_SYNC_DELAYED",
  "OVERRIDE_EXPIRED",
  "IMPORT_COMPLETED",
  "INTEGRATION_ERROR",
  /** Workforce integrations (Planday, plan §8.4): sync delayed, new or missing employees, a new department, recovered. */
  "INTEGRATION_DEGRADED",
  "INTEGRATION_NEW_EMPLOYEES",
  "INTEGRATION_DEPARTMENT_FOUND",
  "INTEGRATION_RECOVERED",
] as const;
export type ManagerNotificationType = (typeof MANAGER_NOTIFICATION_TYPES)[number];

/**
 * The types only a syncing workforce integration raises (plan §8.4). The dashboard hides their preference rows
 * while Planday is switched off (`plandayEnabled` on `GET /api/auth/me`, plan §0); stored preferences and the
 * API keep every type. `INTEGRATION_ERROR` predates them and is always shown.
 */
export const INTEGRATION_SYNC_NOTIFICATION_TYPES = [
  "INTEGRATION_DEGRADED",
  "INTEGRATION_NEW_EMPLOYEES",
  "INTEGRATION_DEPARTMENT_FOUND",
  "INTEGRATION_RECOVERED",
] as const satisfies readonly ManagerNotificationType[];

export function isIntegrationSyncNotificationType(type: string): boolean {
  return (INTEGRATION_SYNC_NOTIFICATION_TYPES as readonly string[]).includes(type);
}

export const managerNotificationTypeSchema = z
  .enum(MANAGER_NOTIFICATION_TYPES)
  .meta({ id: "ManagerNotificationType" });

const channelPreferenceSchema = z
  .object({ inApp: z.boolean(), email: z.boolean() })
  .strict()
  .meta({ id: "NotificationChannelPreference" });

/** Every notification type → channels. Responses always contain every type (defaults applied). */
export const notificationPreferencesSchema = z
  .record(managerNotificationTypeSchema, channelPreferenceSchema)
  .meta({ id: "NotificationPreferences" });
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export const NOTIFICATION_PREFERENCE_DEFAULTS: NotificationPreferences = {
  EMPLOYEE_JOINED: { inApp: true, email: false },
  PERMISSION_NEEDS_ATTENTION: { inApp: true, email: true },
  DEVICE_SYNC_DELAYED: { inApp: true, email: false },
  OVERRIDE_EXPIRED: { inApp: true, email: false },
  IMPORT_COMPLETED: { inApp: true, email: false },
  INTEGRATION_ERROR: { inApp: true, email: true },
  INTEGRATION_DEGRADED: { inApp: true, email: true },
  INTEGRATION_NEW_EMPLOYEES: { inApp: true, email: false },
  INTEGRATION_DEPARTMENT_FOUND: { inApp: true, email: false },
  INTEGRATION_RECOVERED: { inApp: true, email: false },
};

/** PATCH form: any subset of types, any subset of channels. */
export const updateNotificationPreferencesSchema = z.partialRecord(
  managerNotificationTypeSchema,
  channelPreferenceSchema.partial().strict(),
);
export type UpdateNotificationPreferencesInput = z.infer<
  typeof updateNotificationPreferencesSchema
>;

/** Merges stored (possibly partial / stale) JSON with a patch over the defaults. Unknown keys are dropped. */
export function mergeNotificationPreferences(
  stored: unknown,
  patch: UpdateNotificationPreferencesInput = {},
): NotificationPreferences {
  const result: NotificationPreferences = { ...NOTIFICATION_PREFERENCE_DEFAULTS };
  const storedRecord =
    typeof stored === "object" && stored !== null && !Array.isArray(stored) ? stored : {};
  for (const type of MANAGER_NOTIFICATION_TYPES) {
    const parsed = channelPreferenceSchema
      .partial()
      .safeParse((storedRecord as Record<string, unknown>)[type]);
    const fromStore = parsed.success ? parsed.data : {};
    result[type] = { ...result[type], ...fromStore, ...(patch[type] ?? {}) };
  }
  return result;
}

// ── Notifications ───────────────────────────────────────────────────────────

export const notificationSchema = z
  .object({
    id: uuidSchema,
    /** One of MANAGER_NOTIFICATION_TYPES (open string so older clients tolerate new kinds). */
    type: z.string(),
    title: z.string(),
    body: z.string(),
    channel: notificationChannelSchema,
    /** Dashboard route to open, e.g. `/employees/<id>`; null when there is nothing to open. */
    href: z.string().nullable(),
    metadata: jsonObjectSchema,
    readAt: nullableInstantSchema,
    createdAt: instantSchema,
  })
  .meta({ id: "Notification" });
export type Notification = z.infer<typeof notificationSchema>;

/** `GET /api/notifications` */
export const notificationQuerySchema = cursorPaginationQuerySchema.extend({
  unreadOnly: queryBooleanSchema.optional(),
});
export type NotificationQuery = z.infer<typeof notificationQuerySchema>;

export const listNotificationsResponseSchema = paginatedResponseSchema(notificationSchema)
  .extend({ unreadCount: z.int().min(0) })
  .meta({ id: "ListNotificationsResponse" });
export type ListNotificationsResponse = z.infer<typeof listNotificationsResponseSchema>;

/** `POST /api/notifications/:id/read` */
export const notificationResponseSchema = z
  .object({ notification: notificationSchema })
  .meta({ id: "NotificationResponse" });
export type NotificationResponse = z.infer<typeof notificationResponseSchema>;

/** `POST /api/notifications/read-all` */
export const markAllNotificationsReadResponseSchema = z
  .object({ updated: z.int().min(0) })
  .meta({ id: "MarkAllNotificationsReadResponse" });
export type MarkAllNotificationsReadResponse = z.infer<
  typeof markAllNotificationsReadResponseSchema
>;
