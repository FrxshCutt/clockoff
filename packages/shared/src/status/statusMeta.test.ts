import { describe, expect, it } from "vitest";
import type { DeviceStatusBadge } from "../enums";
import { DEVICE_STATUS_BADGES, INVITE_STATUSES, WORK_MODE_STATES } from "../enums";
import { DEVICE_STATUS_THRESHOLDS, type StatusSeverity } from "./deriveDeviceStatus";
import {
  INVITE_STATUS_META,
  STATUS_BADGE_META,
  STATUS_TONES,
  WORK_MODE_STATE_META,
  type StatusMeta,
  type StatusTone,
} from "./statusMeta";

function checkTable(table: Record<string, StatusMeta>, keys: readonly string[]): void {
  expect(Object.keys(table).sort()).toEqual([...keys].sort());
  const labels = new Set<string>();
  for (const key of keys) {
    const meta = table[key];
    expect(meta, key).toBeDefined();
    if (!meta) continue;
    expect(meta.label.trim(), key).toBe(meta.label);
    expect(meta.label.length, key).toBeGreaterThan(0);
    expect(meta.label.length, key).toBeLessThanOrEqual(24);
    expect(STATUS_TONES, key).toContain(meta.tone);
    expect(meta.description.length, key).toBeGreaterThan(20);
    expect(meta.description.endsWith("."), key).toBe(true);
    labels.add(meta.label);
  }
  expect(labels.size).toBe(keys.length);
}

describe("status meta tables", () => {
  it("STATUS_BADGE_META has an entry for every DeviceStatusBadge", () => {
    checkTable(STATUS_BADGE_META, DEVICE_STATUS_BADGES);
  });

  it("INVITE_STATUS_META has an entry for every InviteStatus", () => {
    checkTable(INVITE_STATUS_META, INVITE_STATUSES);
  });

  it("WORK_MODE_STATE_META has an entry for every WorkModeState", () => {
    checkTable(WORK_MODE_STATE_META, WORK_MODE_STATES);
  });

  it("tones match severity intent", () => {
    expect(STATUS_BADGE_META.WORK_MODE_ACTIVE.tone).toBe("success");
    expect(STATUS_BADGE_META.PERMISSIONS_MISSING.tone).toBe("warning");
    expect(STATUS_BADGE_META.SYNC_DELAYED.tone).toBe("warning");
    expect(STATUS_BADGE_META.OFFLINE.tone).toBe("danger");
    expect(STATUS_BADGE_META.NEEDS_ATTENTION.tone).toBe("danger");
    expect(INVITE_STATUS_META.CONNECTED.tone).toBe("success");
    expect(INVITE_STATUS_META.SETUP_INCOMPLETE.tone).toBe("warning");
    expect(WORK_MODE_STATE_META.PERMISSION_ERROR.tone).toBe("danger");
    expect(WORK_MODE_STATE_META.SYNC_ERROR.tone).toBe("danger");
  });

  it("badge descriptions state the §9 thresholds, derived from DEVICE_STATUS_THRESHOLDS", () => {
    const HOUR_MS = 60 * 60 * 1000;
    const t = DEVICE_STATUS_THRESHOLDS;
    expect(STATUS_BADGE_META.SYNC_DELAYED.description).toContain(
      `${t.syncDelayedOnShiftMs / HOUR_MS} hours during a shift`,
    );
    expect(STATUS_BADGE_META.SYNC_DELAYED.description).toContain(
      `${t.syncDelayedOffShiftMs / HOUR_MS} hours otherwise`,
    );
    expect(STATUS_BADGE_META.OFFLINE.description).toContain(`${t.offlineMs / HOUR_MS} hours`);
    expect(STATUS_BADGE_META.NEEDS_ATTENTION.description).toContain(
      `more than ${t.clockSkewSeconds / 60} minutes out`,
    );
    expect(STATUS_BADGE_META.NEEDS_ATTENTION.description).toContain(
      `over ${t.divergenceMs / 60_000} minutes`,
    );
  });

  it("every badge the deriver can emit has copy, and severities map onto compatible tones", () => {
    // severity → tones a badge with that severity may use (NEEDS_ATTENTION is warning or error: danger tone).
    const compatible: Record<StatusSeverity, readonly StatusTone[]> = {
      ok: ["success", "neutral"],
      info: ["info"],
      warning: ["warning", "danger"],
      error: ["danger"],
    };
    const severityOf: Record<DeviceStatusBadge, readonly StatusSeverity[]> = {
      READY: ["ok"],
      OFF_SHIFT: ["ok"],
      WORKING: ["info"],
      WORK_MODE_ACTIVE: ["ok"],
      ON_BREAK: ["info"],
      PERMISSIONS_MISSING: ["warning"],
      SYNC_DELAYED: ["warning"],
      OFFLINE: ["error"],
      NEEDS_ATTENTION: ["warning", "error"],
    };
    for (const badge of DEVICE_STATUS_BADGES) {
      for (const severity of severityOf[badge])
        expect(compatible[severity], `${badge}/${severity}`).toContain(
          STATUS_BADGE_META[badge].tone,
        );
    }
  });
});
