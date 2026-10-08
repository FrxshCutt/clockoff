import {
  INTEGRATION_SYNC_NOTIFICATION_TYPES,
  MANAGER_NOTIFICATION_TYPES,
} from "@clockoff/validation/notifications";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS_TAB,
  NOTIFICATION_TYPE_COPY,
  SETTINGS_TABS,
  SETTINGS_TAB_EDIT_PERMISSION,
  SETTINGS_TAB_META,
  isSettingsTab,
  parseSettingsTab,
  visibleNotificationTypes,
} from "./settings";

describe("settings tabs", () => {
  it("has the five tabs from the spec, organisation first", () => {
    expect(SETTINGS_TABS).toEqual([
      "organisation",
      "join-code",
      "members",
      "notifications",
      "danger-zone",
    ]);
    expect(DEFAULT_SETTINGS_TAB).toBe("organisation");
  });

  it("has a label, description and edit permission entry for every tab", () => {
    for (const tab of SETTINGS_TABS) {
      expect(SETTINGS_TAB_META[tab].label, tab).toBeTruthy();
      expect(SETTINGS_TAB_META[tab].description, tab).toBeTruthy();
      expect(tab in SETTINGS_TAB_EDIT_PERMISSION, tab).toBe(true);
    }
  });

  it("parses ?tab= values, falling back to the default", () => {
    expect(parseSettingsTab("members")).toBe("members");
    expect(parseSettingsTab("danger-zone")).toBe("danger-zone");
    expect(parseSettingsTab("billing")).toBe("organisation");
    expect(parseSettingsTab(null)).toBe("organisation");
    expect(parseSettingsTab(undefined)).toBe("organisation");
    expect(isSettingsTab("join-code")).toBe(true);
    expect(isSettingsTab("toString")).toBe(false);
    expect(isSettingsTab(3)).toBe(false);
  });

  it("has copy for every manager notification type", () => {
    expect(Object.keys(NOTIFICATION_TYPE_COPY).sort()).toEqual(
      [...MANAGER_NOTIFICATION_TYPES].sort(),
    );
    for (const type of MANAGER_NOTIFICATION_TYPES) {
      expect(NOTIFICATION_TYPE_COPY[type].label, type).toBeTruthy();
      expect(NOTIFICATION_TYPE_COPY[type].description, type).toMatch(/\.$/);
    }
  });

  it("shows the integration sync rows only while Planday is switched on", () => {
    expect(visibleNotificationTypes(true)).toEqual(MANAGER_NOTIFICATION_TYPES);
    expect(visibleNotificationTypes(false)).toEqual([
      "EMPLOYEE_JOINED",
      "PERMISSION_NEEDS_ATTENTION",
      "DEVICE_SYNC_DELAYED",
      "OVERRIDE_EXPIRED",
      "IMPORT_COMPLETED",
      "INTEGRATION_ERROR",
    ]);
    for (const type of INTEGRATION_SYNC_NOTIFICATION_TYPES) {
      expect(MANAGER_NOTIFICATION_TYPES).toContain(type);
      expect(visibleNotificationTypes(false)).not.toContain(type);
    }
  });
});
