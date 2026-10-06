import type { Permission } from "@workmode/shared/permissions";
import type { ManagerNotificationType } from "@workmode/validation/notifications";

/** Settings page tabs, in display order. The `?tab=` query parameter selects one. */
export const SETTINGS_TABS = ["organisation", "join-code", "members", "notifications", "danger-zone"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export const DEFAULT_SETTINGS_TAB: SettingsTab = "organisation";

export const SETTINGS_TAB_META: Record<SettingsTab, { label: string; description: string }> = {
  organisation: {
    label: "Organisation",
    description: "Name, time zone and how dates and times are shown.",
  },
  "join-code": {
    label: "Join code",
    description: "The company code employees enter in the Work Mode app to find your organisation.",
  },
  members: {
    label: "Managers",
    description: "Owners, admins and managers who can use this dashboard.",
  },
  notifications: {
    label: "Notifications",
    description: "Which alerts you receive in the dashboard and by email.",
  },
  "danger-zone": {
    label: "Danger zone",
    description: "Leave or delete this organisation.",
  },
};

export function isSettingsTab(value: unknown): value is SettingsTab {
  return typeof value === "string" && (SETTINGS_TABS as readonly string[]).includes(value);
}

/** Tab from a `?tab=` value; unknown or missing values fall back to the organisation tab. */
export function parseSettingsTab(value: string | null | undefined): SettingsTab {
  return isSettingsTab(value) ? value : DEFAULT_SETTINGS_TAB;
}

/** Permission needed to change what a tab shows (viewing is open to every manager). */
export const SETTINGS_TAB_EDIT_PERMISSION: Record<SettingsTab, Permission | null> = {
  organisation: "org:manage",
  "join-code": "org:manage",
  members: "members:invite",
  // Preferences are personal: every manager edits their own.
  notifications: null,
  // Leaving needs no permission; deleting needs org:delete (checked separately).
  "danger-zone": null,
};

/** Human copy for each manager notification type shown on the Notifications tab. */
export const NOTIFICATION_TYPE_COPY: Record<ManagerNotificationType, { label: string; description: string }> = {
  EMPLOYEE_JOINED: {
    label: "Employee joined",
    description: "An employee joined your organisation from the Work Mode app.",
  },
  PERMISSION_NEEDS_ATTENTION: {
    label: "Permissions need attention",
    description: "A phone's Screen Time permission was revoked or setup is incomplete.",
  },
  DEVICE_SYNC_DELAYED: {
    label: "Device sync delayed",
    description: "A phone hasn't checked in for longer than expected.",
  },
  OVERRIDE_EXPIRED: {
    label: "Override expired",
    description: "A temporary manager override ended and normal rules are back on.",
  },
  IMPORT_COMPLETED: {
    label: "Schedule import finished",
    description: "A CSV schedule import completed.",
  },
  INTEGRATION_ERROR: {
    label: "Integration error",
    description: "A rota integration failed to sync.",
  },
};
