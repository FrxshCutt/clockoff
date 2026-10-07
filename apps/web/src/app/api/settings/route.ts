import { updateSettingsSchema } from "@clockoff/validation/settings";
import { createHandler } from "@/server/http/apiHandler";
import { getSettings, updateSettings } from "@/server/settings";

/** `GET /api/settings` → `settingsResponseSchema` `{ organisation, role, notificationPreferences }`. */
export const GET = createHandler({ auth: "manager" }, async ({ ctx }) => getSettings(ctx));

/**
 * `PATCH /api/settings` `{ organisation?, notificationPreferences? }` → `settingsResponseSchema`.
 * `organisation` requires org:manage (checked in the service → FORBIDDEN); preferences are the caller's own.
 */
export const PATCH = createHandler(
  { auth: "manager", body: updateSettingsSchema },
  async ({ ctx, body }) => updateSettings(ctx, body),
);
