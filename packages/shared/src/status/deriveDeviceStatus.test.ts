import { describe, expect, it } from "vitest";
import type { DeviceStatusBadge, EmploymentStatus, InviteStatus, WorkModeState } from "../enums";
import {
  DEVICE_STATUS_BADGES,
  EMPLOYMENT_STATUSES,
  INVITE_STATUSES,
  PERMISSION_STATES,
  SELECTION_STATES,
  WORK_MODE_STATES,
} from "../enums";
import { computeExpectedState } from "../workMode/workModeMachine";
import {
  DEVICE_STATUS_THRESHOLDS,
  STATUS_BADGE_META,
  STATUS_SEVERITIES,
  deriveDeviceStatus,
  isShiftActive,
  restrictionLevelOf,
  toExpectedWorkState,
  type DeriveDeviceStatusInput,
  type DeviceStatusDeviceInput,
  type DeviceStatusResult,
  type ExpectedWorkState,
  type StatusSeverity,
} from "./deriveDeviceStatus";

const NOW = new Date("2026-10-05T10:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const HEALTHY_DEVICE: DeviceStatusDeviceInput = {
  isActive: true,
  permissionState: "APPROVED",
  selectionState: "CONFIGURED",
  restrictionEngineState: "OFF_SHIFT",
  lastDeviceSyncAt: ago(5 * MIN),
  lastClockSkewSeconds: 0,
};

const CONNECTED = { inviteStatus: "CONNECTED", employmentStatus: "ACTIVE" } as const;
const employee = (inviteStatus: InviteStatus, employmentStatus: EmploymentStatus = "ACTIVE") => ({
  inviteStatus,
  employmentStatus,
});

/** Shift started 09:00 (60 min ago); expected state began at shift start unless stated. */
const SHIFT_START = ago(60 * MIN);
const OFF: ExpectedWorkState = {
  state: "OFF_SHIFT",
  restrictionsShouldBeActive: false,
  activeShiftId: null,
};
const SOON: ExpectedWorkState = {
  state: "SHIFT_STARTING_SOON",
  restrictionsShouldBeActive: false,
  activeShiftId: null,
};
const WORKING: ExpectedWorkState = {
  state: "WORKING",
  restrictionsShouldBeActive: true,
  activeShiftId: "shift-1",
  since: SHIFT_START,
  shiftStartedAt: SHIFT_START,
};
const ENDING: ExpectedWorkState = { ...WORKING, state: "SHIFT_ENDING", since: ago(2 * MIN) };
/** Break began 20 min ago (RELAX_ALL → restrictionsShouldBeActive false). */
const BREAK: ExpectedWorkState = {
  ...WORKING,
  state: "ON_BREAK",
  restrictionsShouldBeActive: false,
  since: ago(20 * MIN),
};
const OVERRIDE: ExpectedWorkState = {
  ...WORKING,
  state: "MANAGER_OVERRIDE",
  restrictionsShouldBeActive: false,
  since: ago(30 * MIN),
};
const OVERRIDE_IMMINENT: ExpectedWorkState = {
  state: "MANAGER_OVERRIDE",
  restrictionsShouldBeActive: false,
  activeShiftId: null,
};

interface Case {
  readonly name: string;
  readonly device?: Partial<DeviceStatusDeviceInput> | null;
  readonly input?: Partial<Omit<DeriveDeviceStatusInput, "device">>;
  readonly expect: {
    badge: DeviceStatusBadge;
    severity: StatusSeverity;
    reason?: RegExp | null;
  } | null;
}

function build(c: Case): DeriveDeviceStatusInput {
  return {
    now: NOW,
    employee: CONNECTED,
    expected: OFF,
    ...c.input,
    device: c.device === null ? null : { ...HEALTHY_DEVICE, ...c.device },
  };
}

/**
 * Decision table: one row per rule and per boundary. `reason: null` asserts there is no reason; a RegExp
 * asserts the reason matches; omitted means "any".
 */
const TABLE: readonly Case[] = [
  // ── 0. Not applicable / no device ────────────────────────────────────────────────────────────────
  {
    name: "no device, NOT_INVITED → null",
    device: null,
    input: { employee: employee("NOT_INVITED") },
    expect: null,
  },
  {
    name: "no device, INVITED → null",
    device: null,
    input: { employee: employee("INVITED") },
    expect: null,
  },
  {
    name: "no device, JOINED → PERMISSIONS_MISSING",
    device: null,
    input: { employee: employee("JOINED") },
    expect: {
      badge: "PERMISSIONS_MISSING",
      severity: "warning",
      reason: /no device has completed Screen Time setup/,
    },
  },
  {
    name: "no device, SETUP_INCOMPLETE → PERMISSIONS_MISSING",
    device: null,
    input: { employee: employee("SETUP_INCOMPLETE") },
    expect: { badge: "PERMISSIONS_MISSING", severity: "warning" },
  },
  { name: "no device, CONNECTED (stale lifecycle) → null", device: null, expect: null },
  {
    name: "no device, DEACTIVATED → null",
    device: null,
    input: { employee: employee("DEACTIVATED") },
    expect: null,
  },
  {
    name: "no device, JOINED but employment INACTIVE → null",
    device: null,
    input: { employee: employee("JOINED", "INACTIVE") },
    expect: null,
  },
  {
    name: "employment INACTIVE with healthy device → null",
    input: { employee: employee("CONNECTED", "INACTIVE") },
    expect: null,
  },
  {
    name: "inviteStatus DEACTIVATED with device → null",
    input: { employee: employee("DEACTIVATED") },
    expect: null,
  },
  {
    name: "deactivated device, CONNECTED → null",
    device: { isActive: false },
    input: { expected: WORKING },
    expect: null,
  },
  {
    name: "deactivated device counts as no device: JOINED → PERMISSIONS_MISSING",
    device: { isActive: false },
    input: { employee: employee("JOINED") },
    expect: { badge: "PERMISSIONS_MISSING", severity: "warning" },
  },

  // ── 1. Permissions / selection ───────────────────────────────────────────────────────────────────
  {
    name: "permission NOT_DETERMINED → PERMISSIONS_MISSING",
    device: { permissionState: "NOT_DETERMINED" },
    expect: {
      badge: "PERMISSIONS_MISSING",
      severity: "warning",
      reason: /^Screen Time authorisation is not determined$/,
    },
  },
  {
    name: "permission DENIED → PERMISSIONS_MISSING",
    device: { permissionState: "DENIED" },
    expect: { badge: "PERMISSIONS_MISSING", severity: "warning", reason: /is denied$/ },
  },
  {
    name: "permission REVOKED → PERMISSIONS_MISSING",
    device: { permissionState: "REVOKED" },
    expect: { badge: "PERMISSIONS_MISSING", severity: "warning", reason: /is revoked$/ },
  },
  {
    name: "permission UNKNOWN → PERMISSIONS_MISSING",
    device: { permissionState: "UNKNOWN" },
    expect: { badge: "PERMISSIONS_MISSING", severity: "warning", reason: /is unknown$/ },
  },
  {
    name: "selection NONE → PERMISSIONS_MISSING",
    device: { selectionState: "NONE" },
    expect: {
      badge: "PERMISSIONS_MISSING",
      severity: "warning",
      reason: /^No apps or categories have been selected$/,
    },
  },
  {
    name: "permission + selection both missing → one combined reason",
    device: { permissionState: "DENIED", selectionState: "NONE" },
    expect: {
      badge: "PERMISSIONS_MISSING",
      severity: "warning",
      reason: /^Screen Time authorisation is denied; no apps/,
    },
  },
  {
    name: "permissions missing beats OFFLINE",
    device: { permissionState: "REVOKED", lastDeviceSyncAt: ago(100 * HOUR) },
    expect: { badge: "PERMISSIONS_MISSING", severity: "warning" },
  },
  {
    name: "permissions missing beats an active, confirmed shift",
    device: { selectionState: "NONE", restrictionEngineState: "WORKING" },
    input: { expected: WORKING },
    expect: { badge: "PERMISSIONS_MISSING", severity: "warning" },
  },
  {
    name: "permissions missing beats NEEDS_ATTENTION",
    device: { permissionState: "DENIED", lastClockSkewSeconds: 9000 },
    input: { attentionReasons: ["x"] },
    expect: { badge: "PERMISSIONS_MISSING", severity: "warning" },
  },

  // ── 2. Offline ───────────────────────────────────────────────────────────────────────────────────
  {
    name: "last sync 73 h ago, off shift → OFFLINE",
    device: { lastDeviceSyncAt: ago(73 * HOUR) },
    expect: { badge: "OFFLINE", severity: "error", reason: /^Last device sync 3 days ago$/ },
  },
  {
    name: "last sync 73 h ago, on shift → OFFLINE",
    device: { lastDeviceSyncAt: ago(73 * HOUR), restrictionEngineState: "WORKING" },
    input: { expected: WORKING },
    expect: { badge: "OFFLINE", severity: "error" },
  },
  {
    name: "last sync exactly 72 h ago → not offline (SYNC_DELAYED)",
    device: { lastDeviceSyncAt: ago(72 * HOUR) },
    expect: { badge: "SYNC_DELAYED", severity: "warning", reason: /3 days ago$/ },
  },
  {
    name: "OFFLINE beats attention reasons and skew",
    device: { lastDeviceSyncAt: ago(80 * HOUR), lastClockSkewSeconds: 5000 },
    input: { attentionReasons: ["x"] },
    expect: { badge: "OFFLINE", severity: "error" },
  },

  // ── 3. Sync delayed ──────────────────────────────────────────────────────────────────────────────
  {
    name: "off shift, last sync 25 h ago → SYNC_DELAYED",
    device: { lastDeviceSyncAt: ago(25 * HOUR) },
    expect: { badge: "SYNC_DELAYED", severity: "warning", reason: /^Last device sync 25 h ago$/ },
  },
  {
    name: "off shift, last sync 23 h ago → OFF_SHIFT",
    device: { lastDeviceSyncAt: ago(23 * HOUR) },
    expect: { badge: "OFF_SHIFT", severity: "ok", reason: null },
  },
  {
    name: "off shift, last sync exactly 24 h ago → OFF_SHIFT (strictly greater)",
    device: { lastDeviceSyncAt: ago(24 * HOUR) },
    expect: { badge: "OFF_SHIFT", severity: "ok" },
  },
  {
    name: "shift starting soon uses the 24 h threshold (3 h → READY)",
    device: { lastDeviceSyncAt: ago(3 * HOUR) },
    input: { expected: SOON },
    expect: { badge: "READY", severity: "ok", reason: /starts soon/ },
  },
  {
    name: "on shift, last sync 2 h 01 m ago → SYNC_DELAYED",
    device: { lastDeviceSyncAt: ago(2 * HOUR + MIN), restrictionEngineState: "WORKING" },
    input: { expected: { ...WORKING, since: ago(3 * HOUR), shiftStartedAt: ago(3 * HOUR) } },
    expect: {
      badge: "SYNC_DELAYED",
      severity: "warning",
      reason: /^Last device sync 2 h ago during an active shift$/,
    },
  },
  {
    name: "on shift, last sync exactly 2 h ago → not delayed",
    device: { lastDeviceSyncAt: ago(2 * HOUR), restrictionEngineState: "WORKING" },
    input: { expected: { ...WORKING, since: ago(3 * HOUR), shiftStartedAt: ago(3 * HOUR) } },
    expect: { badge: "WORK_MODE_ACTIVE", severity: "ok" },
  },
  {
    name: "on break uses the on-shift threshold",
    device: { lastDeviceSyncAt: ago(3 * HOUR), restrictionEngineState: "ON_BREAK" },
    input: { expected: BREAK },
    expect: { badge: "SYNC_DELAYED", severity: "warning", reason: /during an active shift/ },
  },
  {
    name: "override during a shift uses the on-shift threshold",
    device: { lastDeviceSyncAt: ago(3 * HOUR) },
    input: { expected: OVERRIDE },
    expect: { badge: "SYNC_DELAYED", severity: "warning" },
  },
  {
    name: "SYNC_DELAYED beats clock skew",
    device: {
      lastDeviceSyncAt: ago(3 * HOUR),
      lastClockSkewSeconds: 1000,
      restrictionEngineState: "WORKING",
    },
    input: { expected: WORKING },
    expect: { badge: "SYNC_DELAYED", severity: "warning" },
  },
  {
    name: "SYNC_DELAYED beats divergence",
    device: { lastDeviceSyncAt: ago(3 * HOUR) },
    input: { expected: WORKING, reportedState: "OFF_SHIFT", reportedAt: ago(50 * MIN) },
    expect: { badge: "SYNC_DELAYED", severity: "warning" },
  },
  {
    name: "never synced, off shift, nothing reported → READY",
    device: { lastDeviceSyncAt: null, restrictionEngineState: "UNKNOWN" },
    expect: { badge: "READY", severity: "ok", reason: /has not reported a Work Mode state/ },
  },
  {
    name: "never synced, on shift → WORKING (awaiting confirmation)",
    device: { lastDeviceSyncAt: null, restrictionEngineState: "UNKNOWN" },
    input: { expected: WORKING },
    expect: { badge: "WORKING", severity: "info", reason: /waiting for the device/ },
  },
  {
    name: "sync timestamp in the future is treated as fresh",
    device: { lastDeviceSyncAt: new Date(NOW.getTime() + 5 * MIN) },
    expect: { badge: "OFF_SHIFT", severity: "ok" },
  },

  // ── 4. Needs attention: skew, errors, caller reasons ────────────────────────────────────────────
  {
    name: "skew +301 s → NEEDS_ATTENTION (warning)",
    device: { lastClockSkewSeconds: 301 },
    expect: {
      badge: "NEEDS_ATTENTION",
      severity: "warning",
      reason: /^Device clock is 301 s ahead of server time$/,
    },
  },
  {
    name: "skew −301 s → NEEDS_ATTENTION (warning)",
    device: { lastClockSkewSeconds: -301 },
    expect: { badge: "NEEDS_ATTENTION", severity: "warning", reason: /301 s behind server time/ },
  },
  {
    name: "skew exactly 300 s → not flagged",
    device: { lastClockSkewSeconds: 300 },
    expect: { badge: "OFF_SHIFT", severity: "ok" },
  },
  {
    name: "skew −300 s → not flagged",
    device: { lastClockSkewSeconds: -300 },
    expect: { badge: "OFF_SHIFT", severity: "ok" },
  },
  {
    name: "skew null → not flagged",
    device: { lastClockSkewSeconds: null },
    expect: { badge: "OFF_SHIFT", severity: "ok" },
  },
  {
    name: "skew undefined → not flagged",
    device: { lastClockSkewSeconds: undefined },
    expect: { badge: "OFF_SHIFT", severity: "ok" },
  },
  {
    name: "skew NaN → not flagged",
    device: { lastClockSkewSeconds: Number.NaN },
    expect: { badge: "OFF_SHIFT", severity: "ok" },
  },
  {
    name: "skew during a confirmed shift still flags",
    device: { lastClockSkewSeconds: -900, restrictionEngineState: "WORKING" },
    input: { expected: WORKING },
    expect: { badge: "NEEDS_ATTENTION", severity: "warning", reason: /900 s behind/ },
  },
  {
    name: "caller attention reason → NEEDS_ATTENTION (error)",
    input: { attentionReasons: ["Break exceeded policy limit"] },
    expect: {
      badge: "NEEDS_ATTENTION",
      severity: "error",
      reason: /^Break exceeded policy limit$/,
    },
  },
  {
    name: "caller reasons are trimmed and de-duplicated, then skew is appended",
    device: { lastClockSkewSeconds: 400 },
    input: { attentionReasons: [" A ", "B", "A"] },
    expect: {
      badge: "NEEDS_ATTENTION",
      severity: "error",
      reason: /^A; B; Device clock is 400 s ahead/,
    },
  },
  {
    name: "empty attentionReasons → not attention",
    input: { attentionReasons: [] },
    expect: { badge: "OFF_SHIFT", severity: "ok" },
  },
  {
    name: "blank attentionReasons → not attention",
    input: { attentionReasons: ["", "  "] },
    expect: { badge: "OFF_SHIFT", severity: "ok" },
  },
  {
    name: "null attentionReasons → not attention",
    input: { attentionReasons: null },
    expect: { badge: "OFF_SHIFT", severity: "ok" },
  },
  {
    name: "device reported PERMISSION_ERROR despite approved permission → NEEDS_ATTENTION",
    device: { restrictionEngineState: "PERMISSION_ERROR" },
    expect: {
      badge: "NEEDS_ATTENTION",
      severity: "error",
      reason: /^Device reported permission error$/,
    },
  },
  {
    name: "device reported SYNC_ERROR on shift → NEEDS_ATTENTION",
    device: { restrictionEngineState: "SYNC_ERROR" },
    input: { expected: WORKING },
    expect: { badge: "NEEDS_ATTENTION", severity: "error", reason: /^Device reported sync error$/ },
  },
  {
    name: "explicit reportedState overrides the device engine state",
    device: { restrictionEngineState: "WORKING" },
    input: { expected: WORKING, reportedState: "SYNC_ERROR", reportedAt: ago(MIN) },
    expect: { badge: "NEEDS_ATTENTION", severity: "error", reason: /sync error/ },
  },
  {
    name: "server flagged SYNC_ERROR → NEEDS_ATTENTION",
    input: {
      expected: { state: "SYNC_ERROR", restrictionsShouldBeActive: false, activeShiftId: null },
    },
    expect: { badge: "NEEDS_ATTENTION", severity: "error", reason: /server flagged a sync error/ },
  },
  {
    name: "skew + device error → severity error, both reasons",
    device: { lastClockSkewSeconds: 600, restrictionEngineState: "SYNC_ERROR" },
    expect: {
      badge: "NEEDS_ATTENTION",
      severity: "error",
      reason: /^Device clock is 600 s ahead of server time; Device reported sync error$/,
    },
  },
  {
    name: "server expects PERMISSION_ERROR but device says APPROVED → device wins (off shift: READY)",
    input: {
      expected: {
        state: "PERMISSION_ERROR",
        restrictionsShouldBeActive: false,
        activeShiftId: null,
      },
    },
    expect: { badge: "READY", severity: "ok", reason: null },
  },
  {
    name: "server expects PERMISSION_ERROR on shift but device approved and working → WORK_MODE_ACTIVE",
    device: { restrictionEngineState: "WORKING" },
    input: { expected: { ...WORKING, state: "PERMISSION_ERROR" } },
    expect: { badge: "WORK_MODE_ACTIVE", severity: "ok" },
  },

  // ── 4. Needs attention: divergence ──────────────────────────────────────────────────────────────
  {
    name: "expected WORKING since 09:00, device said OFF_SHIFT at 09:45 → NEEDS_ATTENTION, timed from 09:00",
    input: { expected: WORKING, reportedState: "OFF_SHIFT", reportedAt: ago(15 * MIN) },
    expect: {
      badge: "NEEDS_ATTENTION",
      severity: "error",
      reason: /^Device reports off shift but working is expected \(for 1 h\)$/,
    },
  },
  {
    name: "a device that keeps checking in with the wrong state is flagged (fresh report, old expectation)",
    input: { expected: WORKING, reportedState: "OFF_SHIFT", reportedAt: ago(MIN) },
    expect: {
      badge: "NEEDS_ATTENTION",
      severity: "error",
      reason: /^Device reports off shift but working is expected \(for 1 h\)$/,
    },
  },
  {
    name: "expectation 9 min old, conflicting report after it → WORKING (awaiting confirmation)",
    input: {
      expected: { ...WORKING, since: ago(9 * MIN) },
      reportedState: "OFF_SHIFT",
      reportedAt: ago(5 * MIN),
    },
    expect: { badge: "WORKING", severity: "info", reason: /waiting for the device/ },
  },
  {
    name: "expectation exactly 10 min old → not yet (strictly greater)",
    input: {
      expected: { ...WORKING, since: ago(10 * MIN) },
      reportedState: "OFF_SHIFT",
      reportedAt: ago(5 * MIN),
    },
    expect: { badge: "WORKING", severity: "info" },
  },
  {
    name: "expectation 10 min + 1 s old → NEEDS_ATTENTION",
    input: {
      expected: { ...WORKING, since: new Date(NOW.getTime() - 10 * MIN - 1000) },
      reportedState: "OFF_SHIFT",
      reportedAt: ago(5 * MIN),
    },
    expect: { badge: "NEEDS_ATTENTION", severity: "error", reason: /\(for 10 min\)$/ },
  },
  {
    name: "pre-shift report (before expected.since) is pending, not divergent → WORKING",
    input: { expected: WORKING, reportedState: "OFF_SHIFT", reportedAt: ago(70 * MIN) },
    expect: { badge: "WORKING", severity: "info" },
  },
  {
    name: "report exactly at expected.since counts as current",
    input: { expected: WORKING, reportedState: "OFF_SHIFT", reportedAt: SHIFT_START },
    expect: { badge: "NEEDS_ATTENTION", severity: "error", reason: /\(for 1 h\)$/ },
  },
  {
    name: "no since → shiftStartedAt is the baseline (pre-shift report is pending)",
    input: {
      expected: { ...WORKING, since: null },
      reportedState: "OFF_SHIFT",
      reportedAt: ago(70 * MIN),
    },
    expect: { badge: "WORKING", severity: "info" },
  },
  {
    name: "no since → divergence is timed from shiftStartedAt",
    input: {
      expected: { ...WORKING, since: null },
      reportedState: "OFF_SHIFT",
      reportedAt: ago(2 * MIN),
    },
    expect: { badge: "NEEDS_ATTENTION", severity: "error", reason: /\(for 1 h\)$/ },
  },
  {
    name: "override began before the shift: a pre-shift report is pending, not divergent",
    input: {
      expected: { ...OVERRIDE, since: ago(70 * MIN) },
      reportedState: "WORKING",
      reportedAt: ago(65 * MIN),
    },
    expect: { badge: "WORKING", severity: "info", reason: /Manager override/ },
  },
  {
    name: "override began before the shift: divergence is timed from the later shift start",
    input: {
      expected: { ...OVERRIDE, since: ago(70 * MIN) },
      reportedState: "WORKING",
      reportedAt: ago(50 * MIN),
    },
    expect: {
      badge: "NEEDS_ATTENTION",
      severity: "error",
      reason: /working but manager override is expected \(for 1 h\)$/,
    },
  },
  {
    name: "no baseline at all → timed from the report (9 min) → not yet",
    input: {
      expected: { ...WORKING, since: null, shiftStartedAt: null },
      reportedState: "OFF_SHIFT",
      reportedAt: ago(9 * MIN),
    },
    expect: { badge: "WORKING", severity: "info" },
  },
  {
    name: "no since and no shiftStartedAt → any old conflicting report diverges",
    input: {
      expected: { ...WORKING, since: null, shiftStartedAt: null },
      reportedState: "OFF_SHIFT",
      reportedAt: ago(70 * MIN),
    },
    expect: { badge: "NEEDS_ATTENTION", severity: "error" },
  },
  {
    name: "fallback: device engine state + lastDeviceSyncAt as the report",
    device: { restrictionEngineState: "OFF_SHIFT", lastDeviceSyncAt: ago(30 * MIN) },
    input: { expected: WORKING },
    expect: {
      badge: "NEEDS_ATTENTION",
      severity: "error",
      reason: /off shift but working is expected \(for 1 h\)/,
    },
  },
  {
    name: "explicit reportedState without reportedAt falls back to lastDeviceSyncAt for timing",
    device: { restrictionEngineState: "WORKING", lastDeviceSyncAt: ago(30 * MIN) },
    input: { expected: WORKING, reportedState: "MANAGER_OVERRIDE" },
    expect: {
      badge: "NEEDS_ATTENTION",
      severity: "error",
      reason: /manager override but working is expected/,
    },
  },
  {
    name: "device stuck ON_BREAK after the break ended (BREAK vs WORK) → NEEDS_ATTENTION",
    input: {
      expected: { ...WORKING, since: ago(40 * MIN) },
      reportedState: "ON_BREAK",
      reportedAt: ago(25 * MIN),
    },
    expect: {
      badge: "NEEDS_ATTENTION",
      severity: "error",
      reason: /on break but working is expected/,
    },
  },
  {
    name: "device still WORKING 15 min into a break it started after → NEEDS_ATTENTION",
    input: { expected: BREAK, reportedState: "WORKING", reportedAt: ago(15 * MIN) },
    expect: {
      badge: "NEEDS_ATTENTION",
      severity: "error",
      reason: /working but on break is expected/,
    },
  },
  {
    name: "device still applying shields during an override (WORK vs NONE) → NEEDS_ATTENTION",
    input: { expected: OVERRIDE, reportedState: "WORKING", reportedAt: ago(15 * MIN) },
    expect: {
      badge: "NEEDS_ATTENTION",
      severity: "error",
      reason: /working but manager override is expected/,
    },
  },
  {
    name: "WORKING vs SHIFT_ENDING is not material → WORK_MODE_ACTIVE",
    input: { expected: ENDING, reportedState: "WORKING", reportedAt: ago(30 * MIN) },
    expect: { badge: "WORK_MODE_ACTIVE", severity: "ok", reason: null },
  },
  {
    name: "OFF_SHIFT vs MANAGER_OVERRIDE is not material (both NONE) → WORKING with override reason",
    input: { expected: OVERRIDE, reportedState: "OFF_SHIFT", reportedAt: ago(15 * MIN) },
    expect: { badge: "WORKING", severity: "info", reason: /Manager override in effect/ },
  },
  {
    name: "UNKNOWN report never diverges",
    input: { expected: WORKING, reportedState: "UNKNOWN", reportedAt: ago(30 * MIN) },
    expect: { badge: "WORKING", severity: "info" },
  },
  {
    name: "divergence is only checked on shift: device WORKING while off shift → OFF_SHIFT",
    input: {
      expected: { ...OFF, since: ago(60 * MIN) },
      reportedState: "WORKING",
      reportedAt: ago(30 * MIN),
    },
    expect: { badge: "OFF_SHIFT", severity: "ok" },
  },
  {
    name: "divergence + skew → error with both reasons",
    device: { lastClockSkewSeconds: 400 },
    input: { expected: WORKING, reportedState: "OFF_SHIFT", reportedAt: ago(20 * MIN) },
    expect: {
      badge: "NEEDS_ATTENTION",
      severity: "error",
      reason: /ahead of server time; Device reports off shift/,
    },
  },

  // ── 5. Shift active ──────────────────────────────────────────────────────────────────────────────
  {
    name: "device confirmed WORKING → WORK_MODE_ACTIVE",
    input: { expected: WORKING, reportedState: "WORKING", reportedAt: ago(55 * MIN) },
    expect: { badge: "WORK_MODE_ACTIVE", severity: "ok", reason: null },
  },
  {
    name: "device confirmed SHIFT_ENDING → WORK_MODE_ACTIVE",
    input: { expected: ENDING, reportedState: "SHIFT_ENDING", reportedAt: ago(MIN) },
    expect: { badge: "WORK_MODE_ACTIVE", severity: "ok", reason: null },
  },
  {
    name: "expected ON_BREAK, device ON_BREAK → ON_BREAK",
    input: { expected: BREAK, reportedState: "ON_BREAK", reportedAt: ago(19 * MIN) },
    expect: { badge: "ON_BREAK", severity: "info", reason: null },
  },
  {
    name: "expected ON_BREAK, device ON_BREAK exactly at break start → ON_BREAK",
    input: { expected: BREAK, reportedState: "ON_BREAK", reportedAt: ago(20 * MIN) },
    expect: { badge: "ON_BREAK", severity: "info", reason: null },
  },
  {
    name: "ON_BREAK left over from an earlier break this shift does not confirm the current one",
    input: { expected: BREAK, reportedState: "ON_BREAK", reportedAt: ago(30 * MIN) },
    expect: { badge: "WORK_MODE_ACTIVE", severity: "ok", reason: /Break not yet confirmed/ },
  },
  {
    name: "expected ON_BREAK without since: any ON_BREAK report this shift confirms",
    input: {
      expected: { ...BREAK, since: null },
      reportedState: "ON_BREAK",
      reportedAt: ago(30 * MIN),
    },
    expect: { badge: "ON_BREAK", severity: "info", reason: null },
  },
  {
    name: "expected ON_BREAK, device last said WORKING before the break → WORK_MODE_ACTIVE (break pending)",
    input: { expected: BREAK, reportedState: "WORKING", reportedAt: ago(40 * MIN) },
    expect: { badge: "WORK_MODE_ACTIVE", severity: "ok", reason: /Break not yet confirmed/ },
  },
  {
    name: "expected WORKING, device ON_BREAK under 10 min → WORK_MODE_ACTIVE with reason",
    input: {
      expected: { ...WORKING, since: ago(5 * MIN) },
      reportedState: "ON_BREAK",
      reportedAt: ago(4 * MIN),
    },
    expect: { badge: "WORK_MODE_ACTIVE", severity: "ok", reason: /still reports a break/ },
  },
  {
    name: "expected WORKING, device ON_BREAK reported before the break ended → WORK_MODE_ACTIVE",
    input: {
      expected: { ...WORKING, since: ago(5 * MIN) },
      reportedState: "ON_BREAK",
      reportedAt: ago(25 * MIN),
    },
    expect: { badge: "WORK_MODE_ACTIVE", severity: "ok", reason: /still reports a break/ },
  },
  {
    name: "device report from before the shift started does not confirm → WORKING",
    input: { expected: WORKING, reportedState: "WORKING", reportedAt: ago(90 * MIN) },
    expect: { badge: "WORKING", severity: "info", reason: /waiting for the device/ },
  },
  {
    name: "without shiftStartedAt any running report confirms",
    input: {
      expected: { ...WORKING, since: null, shiftStartedAt: null },
      reportedState: "WORKING",
      reportedAt: ago(90 * MIN),
    },
    expect: { badge: "WORK_MODE_ACTIVE", severity: "ok" },
  },
  {
    name: "running report with unknown timing cannot confirm this shift → WORKING",
    device: { restrictionEngineState: "WORKING", lastDeviceSyncAt: null },
    input: { expected: WORKING },
    expect: { badge: "WORKING", severity: "info", reason: /waiting for the device/ },
  },
  {
    name: "running report with unknown timing and unknown shift start confirms",
    device: { restrictionEngineState: "WORKING", lastDeviceSyncAt: null },
    input: { expected: { ...WORKING, since: null, shiftStartedAt: null } },
    expect: { badge: "WORK_MODE_ACTIVE", severity: "ok" },
  },
  {
    name: "running report exactly at shift start confirms",
    input: { expected: WORKING, reportedState: "WORKING", reportedAt: SHIFT_START },
    expect: { badge: "WORK_MODE_ACTIVE", severity: "ok", reason: null },
  },
  {
    name: "device OFF_SHIFT 5 min ago, 6 min into the shift (under divergence window) → WORKING",
    device: { restrictionEngineState: "OFF_SHIFT", lastDeviceSyncAt: ago(5 * MIN) },
    input: { expected: { ...WORKING, since: ago(6 * MIN), shiftStartedAt: ago(6 * MIN) } },
    expect: { badge: "WORKING", severity: "info" },
  },
  {
    name: "device checked in OFF_SHIFT 5 min ago, an hour into the shift → NEEDS_ATTENTION",
    device: { restrictionEngineState: "OFF_SHIFT", lastDeviceSyncAt: ago(5 * MIN) },
    input: { expected: WORKING },
    expect: { badge: "NEEDS_ATTENTION", severity: "error", reason: /\(for 1 h\)$/ },
  },
  {
    name: "device SHIFT_STARTING_SOON from before the shift → WORKING",
    device: { restrictionEngineState: "SHIFT_STARTING_SOON", lastDeviceSyncAt: ago(65 * MIN) },
    input: { expected: WORKING },
    expect: { badge: "WORKING", severity: "info" },
  },
  {
    name: "manager override during shift → WORKING with reason",
    input: { expected: OVERRIDE, reportedState: "MANAGER_OVERRIDE", reportedAt: ago(29 * MIN) },
    expect: {
      badge: "WORKING",
      severity: "info",
      reason: /^Manager override in effect; restrictions are lifted$/,
    },
  },
  {
    name: "activeShiftId alone marks the shift active (PERMISSION_ERROR intent with RELAX_ALL break)",
    device: { restrictionEngineState: "UNKNOWN" },
    input: {
      expected: {
        state: "PERMISSION_ERROR",
        restrictionsShouldBeActive: false,
        activeShiftId: "s",
      },
    },
    expect: { badge: "WORKING", severity: "info" },
  },
  {
    name: "restrictionsShouldBeActive alone marks the shift active",
    device: { restrictionEngineState: "WORKING" },
    input: { expected: { state: "WORKING", restrictionsShouldBeActive: true } },
    expect: { badge: "WORK_MODE_ACTIVE", severity: "ok" },
  },

  // ── 6. No shift active ───────────────────────────────────────────────────────────────────────────
  {
    name: "off shift, device reported OFF_SHIFT → OFF_SHIFT",
    expect: { badge: "OFF_SHIFT", severity: "ok", reason: null },
  },
  {
    name: "off shift, device reported SHIFT_ENDING earlier → OFF_SHIFT",
    device: { restrictionEngineState: "SHIFT_ENDING" },
    expect: { badge: "OFF_SHIFT", severity: "ok" },
  },
  {
    name: "off shift, device never reported a state → READY",
    device: { restrictionEngineState: "UNKNOWN" },
    expect: { badge: "READY", severity: "ok", reason: /Setup complete/ },
  },
  {
    name: "shift starting soon → READY",
    input: { expected: SOON },
    expect: { badge: "READY", severity: "ok", reason: /^Shift starts soon$/ },
  },
  {
    name: "override for an imminent shift (activeShiftId null) → READY",
    input: { expected: OVERRIDE_IMMINENT },
    expect: { badge: "READY", severity: "ok", reason: /upcoming shift/ },
  },
  {
    name: "override without activeShiftId info is assumed to be on shift → WORKING",
    input: { expected: { state: "MANAGER_OVERRIDE", restrictionsShouldBeActive: false } },
    expect: { badge: "WORKING", severity: "info", reason: /Manager override/ },
  },
  {
    name: "expected UNKNOWN (not computed yet) → READY",
    input: { expected: { state: "UNKNOWN", restrictionsShouldBeActive: false } },
    expect: { badge: "READY", severity: "ok", reason: null },
  },
  {
    name: "lifecycle INVITED but a device exists → device rules apply",
    input: { employee: employee("INVITED") },
    expect: { badge: "OFF_SHIFT", severity: "ok" },
  },
];

describe("deriveDeviceStatus decision table", () => {
  it.each(TABLE.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const result = deriveDeviceStatus(build(c));
    if (c.expect === null) {
      expect(result).toBeNull();
      return;
    }
    expect(result).not.toBeNull();
    const r = result as DeviceStatusResult;
    expect(r.badge).toBe(c.expect.badge);
    expect(r.severity).toBe(c.expect.severity);
    if (c.expect.reason === null) expect(r.reason).toBeUndefined();
    else if (c.expect.reason) expect(r.reason ?? "").toMatch(c.expect.reason);
  });

  it("covers every badge at least once", () => {
    const seen = new Set<DeviceStatusBadge>();
    for (const c of TABLE) if (c.expect) seen.add(c.expect.badge);
    expect([...seen].sort()).toEqual([...DEVICE_STATUS_BADGES].sort());
  });

  it("uses the documented thresholds", () => {
    expect(DEVICE_STATUS_THRESHOLDS).toEqual({
      syncDelayedOnShiftMs: 2 * HOUR,
      syncDelayedOffShiftMs: 24 * HOUR,
      offlineMs: 72 * HOUR,
      clockSkewSeconds: 300,
      divergenceMs: 10 * MIN,
    });
  });

  it("does not mutate its input", () => {
    const input = build({
      name: "x",
      input: { expected: WORKING, attentionReasons: ["a"] },
      expect: null,
    });
    const snapshot = JSON.stringify(input);
    deriveDeviceStatus(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

/** Expected severity for each badge (NEEDS_ATTENTION is warning only when clock skew is the sole reason). */
const SEVERITY_BY_BADGE: Record<DeviceStatusBadge, readonly StatusSeverity[]> = {
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

/** Badges that must always explain themselves. */
const BADGES_WITH_REASON: ReadonlySet<DeviceStatusBadge> = new Set([
  "PERMISSIONS_MISSING",
  "OFFLINE",
  "SYNC_DELAYED",
  "NEEDS_ATTENTION",
  "WORKING",
]);

/** Restriction level per state, restated independently of `restrictionLevelOf`. */
const SPEC_LEVEL: Record<WorkModeState, "WORK" | "BREAK" | "NONE" | null> = {
  OFF_SHIFT: "NONE",
  SHIFT_STARTING_SOON: "NONE",
  WORKING: "WORK",
  ON_BREAK: "BREAK",
  SHIFT_ENDING: "WORK",
  MANAGER_OVERRIDE: "NONE",
  PERMISSION_ERROR: null,
  SYNC_ERROR: null,
  UNKNOWN: null,
};
const SPEC_RUNNING: readonly WorkModeState[] = ["WORKING", "ON_BREAK", "SHIFT_ENDING"];

interface SpecOutcome {
  readonly badge: DeviceStatusBadge;
  readonly severity: StatusSeverity;
  /** Which NEEDS_ATTENTION causes apply (for reason checks). */
  readonly causes: { attention: boolean; skew: boolean; divergence: boolean };
}

/**
 * §9 restated as an ordered rule list — first matching rule wins — written independently of the
 * implementation's control flow. The sweeps below check `deriveDeviceStatus` against it for every
 * combination of inputs, which makes the decision table exhaustive rather than example-based.
 */
function specOutcome(input: DeriveDeviceStatusInput): SpecOutcome | null {
  const { now, employee, expected } = input;
  const t = now.getTime();
  const device = input.device?.isActive ? input.device : null;
  const reported = input.reportedState ?? device?.restrictionEngineState ?? "UNKNOWN";
  const reportedAt = input.reportedAt ?? device?.lastDeviceSyncAt ?? null;
  const reportedMs = reportedAt?.getTime() ?? null;

  const onShift =
    typeof expected.activeShiftId === "string" ||
    expected.restrictionsShouldBeActive ||
    SPEC_RUNNING.includes(expected.state) ||
    (expected.activeShiftId === undefined && expected.state === "MANAGER_OVERRIDE");
  const syncAge = device?.lastDeviceSyncAt != null ? t - device.lastDeviceSyncAt.getTime() : null;

  const sinceMs = expected.since?.getTime() ?? null;
  const shiftStartMs = expected.shiftStartedAt?.getTime() ?? null;
  const known = [sinceMs, shiftStartMs].filter((v): v is number => v !== null);
  const baselineMs = known.length > 0 ? Math.max(...known) : null;
  const madeSince = (ms: number | null) => ms === null || (reportedMs !== null && reportedMs >= ms);

  const levelsDiffer =
    SPEC_LEVEL[reported] !== null &&
    SPEC_LEVEL[expected.state] !== null &&
    SPEC_LEVEL[reported] !== SPEC_LEVEL[expected.state];
  const divergence =
    onShift &&
    reportedMs !== null &&
    levelsDiffer &&
    madeSince(baselineMs) &&
    t - (baselineMs ?? reportedMs) > 10 * MIN;
  const skewSeconds = device?.lastClockSkewSeconds ?? null;
  const skew = skewSeconds !== null && Number.isFinite(skewSeconds) && Math.abs(skewSeconds) > 300;
  const attention = (input.attentionReasons ?? []).some((r) => r.trim().length > 0);
  const deviceError = reported === "PERMISSION_ERROR" || reported === "SYNC_ERROR";
  const serverError = expected.state === "SYNC_ERROR";
  const confirmed = SPEC_RUNNING.includes(reported) && madeSince(shiftStartMs);
  const breakConfirmed = reported === "ON_BREAK" && madeSince(sinceMs);

  const rules: ReadonlyArray<
    readonly [badge: DeviceStatusBadge | null, severity: StatusSeverity, when: () => boolean]
  > = [
    [null, "ok", () => employee.employmentStatus === "INACTIVE"],
    [null, "ok", () => employee.inviteStatus === "DEACTIVATED"],
    [
      "PERMISSIONS_MISSING",
      "warning",
      () =>
        device === null &&
        (employee.inviteStatus === "JOINED" || employee.inviteStatus === "SETUP_INCOMPLETE"),
    ],
    [null, "ok", () => device === null],
    ["PERMISSIONS_MISSING", "warning", () => device?.permissionState !== "APPROVED"],
    ["PERMISSIONS_MISSING", "warning", () => device?.selectionState !== "CONFIGURED"],
    ["OFFLINE", "error", () => syncAge !== null && syncAge > 72 * HOUR],
    ["SYNC_DELAYED", "warning", () => syncAge !== null && onShift && syncAge > 2 * HOUR],
    ["SYNC_DELAYED", "warning", () => syncAge !== null && !onShift && syncAge > 24 * HOUR],
    ["NEEDS_ATTENTION", "error", () => attention || deviceError || serverError || divergence],
    ["NEEDS_ATTENTION", "warning", () => skew],
    ["WORKING", "info", () => onShift && expected.state === "MANAGER_OVERRIDE"],
    ["WORKING", "info", () => onShift && !confirmed],
    ["ON_BREAK", "info", () => onShift && expected.state === "ON_BREAK" && breakConfirmed],
    ["WORK_MODE_ACTIVE", "ok", () => onShift],
    ["OFF_SHIFT", "ok", () => expected.state === "OFF_SHIFT" && reported !== "UNKNOWN"],
    ["READY", "ok", () => true],
  ];
  const [badge, severity] = rules.find(([, , when]) => when()) ?? [null, "ok"];
  return badge === null ? null : { badge, severity, causes: { attention, skew, divergence } };
}

/** Compares one input against the spec model; returns a failure description or null. */
function checkAgainstSpec(input: DeriveDeviceStatusInput): string | null {
  const label = () => JSON.stringify(input);
  let result: DeviceStatusResult | null;
  try {
    result = deriveDeviceStatus(input);
  } catch (err) {
    return `threw ${String(err)} for ${label()}`;
  }
  const spec = specOutcome(input);
  if (spec === null || result === null) {
    return spec === result ? null : `got ${String(result?.badge)}, spec null for ${label()}`;
  }
  if (result.badge !== spec.badge) return `got ${result.badge}, spec ${spec.badge} for ${label()}`;
  if (result.severity !== spec.severity)
    return `${result.badge}: severity ${result.severity}, spec ${spec.severity} for ${label()}`;
  if (!DEVICE_STATUS_BADGES.includes(result.badge) || !STATUS_SEVERITIES.includes(result.severity))
    return `unknown badge/severity ${result.badge}/${result.severity} for ${label()}`;
  if (!SEVERITY_BY_BADGE[result.badge].includes(result.severity))
    return `severity ${result.severity} not allowed for ${result.badge}: ${label()}`;
  if (result.reason !== undefined && result.reason.trim().length === 0)
    return `blank reason for ${label()}`;
  if (BADGES_WITH_REASON.has(result.badge) && result.reason === undefined)
    return `${result.badge} without a reason for ${label()}`;
  if (result.badge === "NEEDS_ATTENTION") {
    const reason = result.reason ?? "";
    if (spec.causes.skew !== /Device clock is \d+ s (ahead of|behind) server time/.test(reason))
      return `skew reason mismatch (${reason}) for ${label()}`;
    if (spec.causes.divergence !== / is expected \(for /.test(reason))
      return `divergence reason mismatch (${reason}) for ${label()}`;
    const callerReasons = (input.attentionReasons ?? []).map((r) => r.trim()).filter(Boolean);
    if (!callerReasons.every((r) => reason.includes(r)))
      return `caller reason missing (${reason}) for ${label()}`;
  }
  return null;
}

const ATTENTION_REASON = "Manager-flagged issue";

describe("deriveDeviceStatus matches the §9 rule list for every combination (exhaustive sweep)", () => {
  it("lifecycle and permissions: every invite × employment × device presence × permission × selection", () => {
    const failures: string[] = [];
    let count = 0;
    const presences = ["none", "inactive", "active"] as const;
    const syncAges: readonly (number | null)[] = [null, 5 * MIN, 25 * HOUR, 73 * HOUR];
    for (const inviteStatus of INVITE_STATUSES)
      for (const employmentStatus of EMPLOYMENT_STATUSES)
        for (const presence of presences)
          for (const permissionState of PERMISSION_STATES)
            for (const selectionState of SELECTION_STATES)
              for (const engine of WORK_MODE_STATES)
                for (const age of syncAges)
                  for (const expected of [OFF, WORKING, BREAK]) {
                    count++;
                    const failure = checkAgainstSpec({
                      now: NOW,
                      employee: { inviteStatus, employmentStatus },
                      device:
                        presence === "none"
                          ? null
                          : {
                              isActive: presence === "active",
                              permissionState,
                              selectionState,
                              restrictionEngineState: engine,
                              lastDeviceSyncAt: age === null ? null : ago(age),
                              lastClockSkewSeconds: 0,
                            },
                      expected,
                    });
                    if (failure !== null) failures.push(failure);
                  }
    expect(count).toBe(6 * 2 * 3 * 5 * 2 * 9 * 4 * 3);
    expect(failures.slice(0, 5)).toEqual([]);
  });

  it("operational rules: engine × sync age × skew × expectation × timing × attention", () => {
    // Boundaries at and just past every threshold.
    const syncAges: readonly (number | null)[] = [
      null,
      5 * MIN,
      2 * HOUR,
      2 * HOUR + MIN,
      24 * HOUR,
      24 * HOUR + MIN,
      72 * HOUR,
      72 * HOUR + MIN,
    ];
    const skews: readonly (number | null)[] = [null, 300, 301, -301];
    const shiftIds: readonly (string | null | undefined)[] = [undefined, null, "shift-1"];
    const sinces: readonly (Date | null)[] = [null, ago(5 * MIN), ago(30 * MIN)];
    const shiftStarts: readonly (Date | null)[] = [null, SHIFT_START];
    const reportTimes: readonly (Date | undefined)[] = [
      undefined, // falls back to lastDeviceSyncAt
      ago(3 * MIN),
      ago(20 * MIN),
      ago(90 * MIN),
    ];
    const attentionSets: readonly (readonly string[])[] = [[], [ATTENTION_REASON]];
    const failures: string[] = [];
    let count = 0;
    for (const engine of WORK_MODE_STATES)
      for (const age of syncAges)
        for (const skew of skews)
          for (const state of WORK_MODE_STATES)
            for (const activeShiftId of shiftIds)
              for (const restrictionsShouldBeActive of [false, true])
                for (const since of sinces)
                  for (const shiftStartedAt of shiftStarts)
                    for (const reportedAt of reportTimes)
                      for (const attentionReasons of attentionSets) {
                        count++;
                        const expected: ExpectedWorkState =
                          activeShiftId === undefined
                            ? { state, restrictionsShouldBeActive, since, shiftStartedAt }
                            : {
                                state,
                                restrictionsShouldBeActive,
                                activeShiftId,
                                since,
                                shiftStartedAt,
                              };
                        const failure = checkAgainstSpec({
                          now: NOW,
                          employee: CONNECTED,
                          device: {
                            ...HEALTHY_DEVICE,
                            restrictionEngineState: engine,
                            lastDeviceSyncAt: age === null ? null : ago(age),
                            lastClockSkewSeconds: skew,
                          },
                          expected,
                          ...(reportedAt === undefined ? {} : { reportedAt }),
                          attentionReasons,
                        });
                        if (failure !== null && failures.length < 5) failures.push(failure);
                      }
    expect(count).toBe(9 * 8 * 4 * 9 * 3 * 2 * 3 * 2 * 4 * 2);
    expect(failures).toEqual([]);
  }, 60_000); // ~830k combinations; generous timeout for loaded CI machines

  it("the spec model itself reaches every badge (so the sweep is not vacuous)", () => {
    const seen = new Set<DeviceStatusBadge>();
    for (const c of TABLE) {
      const outcome = specOutcome(build(c));
      if (outcome) seen.add(outcome.badge);
    }
    expect([...seen].sort()).toEqual([...DEVICE_STATUS_BADGES].sort());
  });

  it("agrees with every decision-table row", () => {
    for (const c of TABLE) expect(checkAgainstSpec(build(c)), c.name).toBeNull();
  });
});

describe("helpers", () => {
  it("restrictionLevelOf covers every WorkModeState", () => {
    const levels: Record<WorkModeState, ReturnType<typeof restrictionLevelOf>> = {
      OFF_SHIFT: "NONE",
      SHIFT_STARTING_SOON: "NONE",
      WORKING: "WORK",
      ON_BREAK: "BREAK",
      SHIFT_ENDING: "WORK",
      MANAGER_OVERRIDE: "NONE",
      PERMISSION_ERROR: null,
      SYNC_ERROR: null,
      UNKNOWN: null,
    };
    for (const s of WORK_MODE_STATES) expect(restrictionLevelOf(s), s).toBe(levels[s]);
  });

  it.each([
    [{ state: "OFF_SHIFT", restrictionsShouldBeActive: false }, false],
    [{ state: "OFF_SHIFT", restrictionsShouldBeActive: false, activeShiftId: "s" }, true],
    [
      { state: "SHIFT_STARTING_SOON", restrictionsShouldBeActive: false, activeShiftId: null },
      false,
    ],
    [{ state: "WORKING", restrictionsShouldBeActive: true, activeShiftId: null }, true],
    [{ state: "ON_BREAK", restrictionsShouldBeActive: false, activeShiftId: null }, true],
    [{ state: "SHIFT_ENDING", restrictionsShouldBeActive: true }, true],
    [{ state: "MANAGER_OVERRIDE", restrictionsShouldBeActive: false }, true],
    [{ state: "MANAGER_OVERRIDE", restrictionsShouldBeActive: false, activeShiftId: null }, false],
    [{ state: "MANAGER_OVERRIDE", restrictionsShouldBeActive: false, activeShiftId: "s" }, true],
    [{ state: "PERMISSION_ERROR", restrictionsShouldBeActive: true }, true],
    [{ state: "PERMISSION_ERROR", restrictionsShouldBeActive: false }, false],
    [{ state: "UNKNOWN", restrictionsShouldBeActive: false }, false],
  ] as const)("isShiftActive(%j) → %s", (expected, active) => {
    expect(isShiftActive(expected)).toBe(active);
  });

  it("every badge has meta", () => {
    for (const b of DEVICE_STATUS_BADGES)
      expect(STATUS_BADGE_META[b].label.length).toBeGreaterThan(0);
  });
});

describe("toExpectedWorkState (integration with the state machine)", () => {
  const shift = {
    id: "shift-1",
    startsAt: "2026-10-05T09:00:00Z",
    endsAt: "2026-10-05T17:00:00Z",
    status: "SCHEDULED" as const,
  };

  it("maps an active shift and lets the badge confirm against the shift start", () => {
    const es = computeExpectedState({ now: NOW, shifts: [shift], permissionState: "APPROVED" });
    const expected = toExpectedWorkState(es);
    expect(expected).toEqual({
      state: "WORKING",
      restrictionsShouldBeActive: true,
      activeShiftId: "shift-1",
      shiftStartedAt: new Date("2026-10-05T09:00:00Z"),
      since: null,
    });
    const base = { now: NOW, employee: CONNECTED, expected };
    expect(
      deriveDeviceStatus({
        ...base,
        device: {
          ...HEALTHY_DEVICE,
          restrictionEngineState: "WORKING",
          lastDeviceSyncAt: ago(30 * MIN),
        },
      })?.badge,
    ).toBe("WORK_MODE_ACTIVE");
    expect(
      deriveDeviceStatus({
        ...base,
        device: {
          ...HEALTHY_DEVICE,
          restrictionEngineState: "WORKING",
          lastDeviceSyncAt: ago(90 * MIN),
        },
      })?.badge,
    ).toBe("WORKING");
  });

  it("does not treat an imminent interval as the shift start", () => {
    const es = computeExpectedState({
      now: new Date("2026-10-05T08:50:00Z"),
      shifts: [shift],
      permissionState: "APPROVED",
    });
    expect(es.state).toBe("SHIFT_STARTING_SOON");
    const expected = toExpectedWorkState(es, ago(15 * MIN));
    expect(expected.activeShiftId).toBeNull();
    expect(expected.shiftStartedAt).toBeNull();
    expect(expected.since).toEqual(ago(15 * MIN));
    expect(isShiftActive(expected)).toBe(false);
  });

  it("off shift maps to OFF_SHIFT with no shift", () => {
    const es = computeExpectedState({
      now: new Date("2026-10-05T20:00:00Z"),
      shifts: [shift],
      permissionState: "APPROVED",
    });
    expect(toExpectedWorkState(es)).toMatchObject({
      state: "OFF_SHIFT",
      activeShiftId: null,
      shiftStartedAt: null,
    });
  });
});
