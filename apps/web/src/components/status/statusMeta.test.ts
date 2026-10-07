import {
  BILLING_STATUSES,
  BREAK_SESSION_STATUSES,
  DEVICE_STATUS_BADGES,
  EMPLOYEE_INVITE_STATUSES,
  INTEGRATION_STATUSES,
  INVITE_STATUSES,
  POLICY_STATUSES,
  ROLES,
  SHIFT_STATUSES,
  WORK_MODE_STATES,
} from "@clockoff/shared/enums";
import {
  STATUS_BADGE_META,
  INVITE_STATUS_META,
  WORK_MODE_STATE_META,
} from "@clockoff/shared/status/statusMeta";
import { describe, expect, it } from "vitest";
import {
  STATUS_ENUM_VALUES,
  STATUS_ICONS,
  STATUS_KINDS,
  STATUS_META,
  STATUS_TONES,
  TONE_CLASSES,
  TONE_DOT_CLASSES,
  getStatusMeta,
  type StatusKind,
} from "./statusMeta";

const EXPECTED_ENUMS: Record<StatusKind, readonly string[]> = {
  inviteStatus: INVITE_STATUSES,
  deviceStatus: DEVICE_STATUS_BADGES,
  workModeState: WORK_MODE_STATES,
  policyStatus: POLICY_STATUSES,
  shiftStatus: SHIFT_STATUSES,
  breakSessionStatus: BREAK_SESSION_STATUSES,
  employeeInviteStatus: EMPLOYEE_INVITE_STATUSES,
  integrationStatus: INTEGRATION_STATUSES,
  role: ROLES,
  billingStatus: BILLING_STATUSES,
};

describe("StatusBadge mapping tables", () => {
  it("covers every required enum", () => {
    expect([...STATUS_KINDS].sort()).toEqual(Object.keys(EXPECTED_ENUMS).sort());
    for (const kind of STATUS_KINDS) {
      expect(STATUS_ENUM_VALUES[kind], kind).toEqual(EXPECTED_ENUMS[kind]);
    }
  });

  it.each(STATUS_KINDS)("maps every %s value to a label, tone, icon and description", (kind) => {
    const table = STATUS_META[kind] as Record<
      string,
      { label: string; tone: string; icon: string; description: string }
    >;
    expect(Object.keys(table).sort(), kind).toEqual([...EXPECTED_ENUMS[kind]].sort());
    for (const value of EXPECTED_ENUMS[kind]) {
      const meta = table[value];
      expect(meta, `${kind}.${value}`).toBeDefined();
      expect(meta?.label.trim(), `${kind}.${value} label`).not.toBe("");
      expect(STATUS_TONES, `${kind}.${value} tone`).toContain(meta?.tone);
      expect(STATUS_ICONS, `${kind}.${value} icon`).toContain(meta?.icon);
      expect(meta?.description.trim().length, `${kind}.${value} description`).toBeGreaterThan(0);
    }
  });

  it("uses distinct labels within each enum so badges are distinguishable without colour", () => {
    for (const kind of STATUS_KINDS) {
      const labels = Object.values(STATUS_META[kind] as Record<string, { label: string }>).map(
        (m) => m.label,
      );
      expect(new Set(labels).size, kind).toBe(labels.length);
    }
  });

  it("reuses the shared copy for device, invite and Work Mode statuses", () => {
    for (const value of DEVICE_STATUS_BADGES) {
      expect(STATUS_META.deviceStatus[value].label).toBe(STATUS_BADGE_META[value].label);
      expect(STATUS_META.deviceStatus[value].tone).toBe(STATUS_BADGE_META[value].tone);
    }
    for (const value of INVITE_STATUSES) {
      expect(STATUS_META.inviteStatus[value].label).toBe(INVITE_STATUS_META[value].label);
    }
    for (const value of WORK_MODE_STATES) {
      expect(STATUS_META.workModeState[value].description).toBe(
        WORK_MODE_STATE_META[value].description,
      );
    }
  });

  it("has classes for every tone", () => {
    for (const tone of STATUS_TONES) {
      expect(TONE_CLASSES[tone]).toMatch(/text-/);
      expect(TONE_CLASSES[tone]).toMatch(/dark:/);
      expect(TONE_DOT_CLASSES[tone]).toMatch(/bg-/);
    }
  });
});

describe("getStatusMeta", () => {
  it("returns the table entry for known values", () => {
    expect(getStatusMeta("policyStatus", "ACTIVE")).toBe(STATUS_META.policyStatus.ACTIVE);
    expect(getStatusMeta("role", "OWNER").label).toBe("Owner");
  });

  it("degrades to a neutral humanised badge for values newer than the UI", () => {
    expect(getStatusMeta("integrationStatus", "RATE_LIMITED_BY_PROVIDER")).toEqual({
      label: "Rate limited by provider",
      tone: "neutral",
      icon: "help",
      description: "",
    });
  });

  it("does not treat Object.prototype keys as statuses", () => {
    expect(getStatusMeta("role", "toString").tone).toBe("neutral");
    expect(getStatusMeta("role", "constructor").label).toBe("Constructor");
  });
});
