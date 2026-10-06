import type {
  DeviceStatusBadge,
  EmploymentStatus,
  InviteStatus,
  PermissionState,
  SelectionState,
  WorkModeState,
} from "../enums";
import { WORK_MODE_STATE_META } from "./statusMeta";

export * from "./statusMeta";
export * from "./deriveInviteStatus";

/**
 * §9 — derive the operational badge managers see for an employee's device. Pure and total over UTC
 * instants; no I/O. Rules are evaluated in this order and the first match wins:
 *
 *   0. Not applicable → null when employment is INACTIVE or inviteStatus is DEACTIVATED. With no active
 *      device: PERMISSIONS_MISSING when inviteStatus is JOINED / SETUP_INCOMPLETE (they joined but no device
 *      finished setup), otherwise null (NOT_INVITED / INVITED have no device badge; the lifecycle badge
 *      tells that story). A deactivated device (`isActive: false`) counts as no device.
 *   1. PERMISSIONS_MISSING → permission ≠ APPROVED or selection = NONE. Beats every other badge.
 *   2. OFFLINE             → last device sync more than 72 h ago.
 *   3. SYNC_DELAYED        → last device sync more than 2 h ago while a shift is active, or more than 24 h
 *                            ago otherwise. (No sync timestamp at all → rules 2–3 are skipped.)
 *   4. NEEDS_ATTENTION     → aggregates, with a reason: caller-supplied `attentionReasons`; |clock skew|
 *                            > 300 s; the device reporting PERMISSION_ERROR / SYNC_ERROR; the server
 *                            expecting SYNC_ERROR; divergence — while a shift is active, the device's latest
 *                            report has a materially different restriction level (WORK / BREAK / NONE, see
 *                            `restrictionLevelOf`) than expected, that report was made after the current
 *                            expectation began, and the expectation has been in force for more than 10 min
 *                            (so a device that keeps checking in with the wrong state IS flagged).
 *                            Severity is "warning" when clock skew is the only reason, else "error".
 *   5. Shift active        → WORKING with a reason while a MANAGER_OVERRIDE lifts restrictions.
 *                            Otherwise the device must confirm: its latest report is WORKING / ON_BREAK /
 *                            SHIFT_ENDING and was made during this shift (at or after `shiftStartedAt`, when
 *                            known). Unconfirmed → WORKING. Confirmed → ON_BREAK when the server expects a
 *                            break and the device reported ON_BREAK since that break began (`since`, when
 *                            known); WORK_MODE_ACTIVE otherwise (with a reason when the break states differ).
 *   6. No shift active     → OFF_SHIFT when expected OFF_SHIFT and the device has reported a Work Mode state;
 *                            READY when it has not (reported UNKNOWN: setup complete, nothing run yet), and
 *                            for every other no-shift expectation (SHIFT_STARTING_SOON, an override for an
 *                            imminent shift, UNKNOWN): connected, permissions OK, no shift active.
 *
 * Timing: "the current expectation began" is the later of `expected.since` and `expected.shiftStartedAt`
 * (whichever are known); without either, a conflicting report is assumed to have diverged since it was made
 * (a lower bound). Without `shiftStartedAt`, any running report counts as confirmation.
 * `toExpectedWorkState(computeExpectedState(...), stateSince)` supplies both, so production callers get the
 * precise behaviour.
 *
 * Why this order: permissions first because nothing else matters until Screen Time is authorised; sync
 * badges above NEEDS_ATTENTION because a device that has not checked in cannot have fresh skew or state
 * data, and "sync delayed" is the actionable explanation. Divergence is only judged during a shift: off
 * shift the device checks in rarely, so a report raced at the shift boundary would otherwise stay flagged for
 * hours. Whether a shift exists later today is not knowable from these inputs, so OFF_SHIFT is used whenever
 * expected.state is OFF_SHIFT (bar the never-reported case).
 */

export const DEVICE_STATUS_THRESHOLDS = {
  /** Shift active: a device that has not synced for longer than this is SYNC_DELAYED. */
  syncDelayedOnShiftMs: 2 * 60 * 60 * 1000,
  /** No shift active: a device that has not synced for longer than this is SYNC_DELAYED. */
  syncDelayedOffShiftMs: 24 * 60 * 60 * 1000,
  /** A device that has not synced for longer than this is OFFLINE regardless of shift. */
  offlineMs: 72 * 60 * 60 * 1000,
  /** |device clock − server clock| above this many seconds is flagged. */
  clockSkewSeconds: 300,
  /** A materially different device report (while on shift) older than this is a divergence. */
  divergenceMs: 10 * 60 * 1000,
} as const;

export type StatusSeverity = "ok" | "info" | "warning" | "error";
export const STATUS_SEVERITIES = [
  "ok",
  "info",
  "warning",
  "error",
] as const satisfies readonly StatusSeverity[];

/** The Device row fields the badge depends on. A Prisma `Device` row satisfies it directly. */
export interface DeviceStatusDeviceInput {
  readonly isActive: boolean;
  readonly permissionState: PermissionState;
  readonly selectionState: SelectionState;
  readonly restrictionEngineState: WorkModeState;
  readonly lastDeviceSyncAt: Date | null;
  readonly lastClockSkewSeconds?: number | null;
}

/** Server-side expectation from the Work Mode state machine (`computeExpectedState` / EmployeeWorkState). */
export interface ExpectedWorkState {
  readonly state: WorkModeState;
  readonly restrictionsShouldBeActive: boolean;
  /**
   * The shift in progress (ExpectedState.activeShift?.id / EmployeeWorkState.activeShiftId). When provided
   * (including `null`) it is authoritative for the ambiguous states MANAGER_OVERRIDE and PERMISSION_ERROR,
   * which the machine also produces while a shift is merely imminent.
   */
  readonly activeShiftId?: string | null;
  /**
   * When `state` began (EmployeeWorkState.stateSince). Optional. Divergence is timed from it, a device report
   * made before it is not a divergence (the device has not caught up yet), and an ON_BREAK report made before
   * it does not confirm the current break.
   */
  readonly since?: Date | null;
  /**
   * Start of the current working interval (ExpectedState.workingInterval.startsAt). Optional. Only a device
   * report made at or after it confirms Work Mode for this shift; divergence is never timed from earlier.
   */
  readonly shiftStartedAt?: Date | null;
}

export interface DeriveDeviceStatusInput {
  readonly now: Date;
  readonly employee: {
    readonly inviteStatus: InviteStatus;
    readonly employmentStatus: EmploymentStatus;
  };
  /** The employee's current device (pass the active one when several exist), or null when none. */
  readonly device?: DeviceStatusDeviceInput | null;
  readonly expected: ExpectedWorkState;
  /** Last engine state the device reported (EmployeeWorkState.reportedState). Defaults to device.restrictionEngineState. */
  readonly reportedState?: WorkModeState | null;
  /** When `reportedState` was reported (EmployeeWorkState.reportedAt). Defaults to device.lastDeviceSyncAt. */
  readonly reportedAt?: Date | null;
  /** Server-side reasons (e.g. EmployeeWorkState.attentionReason) that force NEEDS_ATTENTION. Blank entries are ignored. */
  readonly attentionReasons?: readonly string[] | null;
}

export interface DeviceStatusResult {
  readonly badge: DeviceStatusBadge;
  readonly reason?: string;
  readonly severity: StatusSeverity;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`);
}

/**
 * What a state means for the shields: WORK (policy applied), BREAK (relaxed per Break Rules), NONE (no
 * restrictions), or null when it says nothing reliable about the shields (errors, UNKNOWN). Two states are
 * "materially different" when both levels are known and differ.
 */
export type RestrictionLevel = "WORK" | "BREAK" | "NONE";

export function restrictionLevelOf(state: WorkModeState): RestrictionLevel | null {
  switch (state) {
    case "WORKING":
    case "SHIFT_ENDING":
      return "WORK";
    case "ON_BREAK":
      return "BREAK";
    case "OFF_SHIFT":
    case "SHIFT_STARTING_SOON":
    case "MANAGER_OVERRIDE":
      return "NONE";
    case "PERMISSION_ERROR":
    case "SYNC_ERROR":
    case "UNKNOWN":
      return null;
    default:
      return assertNever(state);
  }
}

/** WORKING / ON_BREAK / SHIFT_ENDING: Work Mode is running (shields applied or relaxed for a break). */
function isRunningState(state: WorkModeState): boolean {
  const level = restrictionLevelOf(state);
  return level === "WORK" || level === "BREAK";
}

/** Whether the state machine says a shift is in progress at `now`. */
export function isShiftActive(expected: ExpectedWorkState): boolean {
  if (expected.activeShiftId != null) return true;
  if (expected.restrictionsShouldBeActive) return true;
  // WORKING / ON_BREAK / SHIFT_ENDING are only ever produced inside a working interval.
  if (isRunningState(expected.state)) return true;
  // Ambiguous (active or imminent): trust activeShiftId when the caller provided it.
  return expected.activeShiftId === undefined && expected.state === "MANAGER_OVERRIDE";
}

function labelOf(state: WorkModeState): string {
  return WORK_MODE_STATE_META[state].label.toLowerCase();
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} days`;
}

/** The later of two optional instants, or null when neither is known. */
function latestOf(a: Date | null | undefined, b: Date | null | undefined): Date | null {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/** True when `reportedAt` is known and not before `baseline`; vacuously true when `baseline` is unknown. */
function reportedSince(reportedAt: Date | null, baseline: Date | null): boolean {
  if (baseline === null) return true;
  return reportedAt !== null && reportedAt.getTime() >= baseline.getTime();
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function noDeviceStatus(inviteStatus: InviteStatus): DeviceStatusResult | null {
  switch (inviteStatus) {
    case "JOINED":
    case "SETUP_INCOMPLETE":
      return {
        badge: "PERMISSIONS_MISSING",
        severity: "warning",
        reason: "Joined, but no device has completed Screen Time setup yet",
      };
    case "NOT_INVITED":
    case "INVITED":
    case "CONNECTED":
    case "DEACTIVATED":
      return null;
    default:
      return assertNever(inviteStatus);
  }
}

function noShiftStatus(expectedState: WorkModeState, reported: WorkModeState): DeviceStatusResult {
  switch (expectedState) {
    case "OFF_SHIFT":
      return reported === "UNKNOWN"
        ? {
            badge: "READY",
            severity: "ok",
            reason: "Setup complete; the device has not reported a Work Mode state yet",
          }
        : { badge: "OFF_SHIFT", severity: "ok" };
    case "SHIFT_STARTING_SOON":
      return { badge: "READY", severity: "ok", reason: "Shift starts soon" };
    case "MANAGER_OVERRIDE":
      return {
        badge: "READY",
        severity: "ok",
        reason: "Manager override in effect for the upcoming shift",
      };
    case "PERMISSION_ERROR":
      // Only reachable when the device itself reports APPROVED: the device is authoritative on permission.
      return { badge: "READY", severity: "ok" };
    case "UNKNOWN":
      return { badge: "READY", severity: "ok" };
    case "WORKING":
    case "ON_BREAK":
    case "SHIFT_ENDING":
    case "SYNC_ERROR":
      // Unreachable: running states imply an active shift (rule 5) and SYNC_ERROR is flagged by rule 4.
      return { badge: "READY", severity: "ok" };
    default:
      return assertNever(expectedState);
  }
}

export function deriveDeviceStatus(input: DeriveDeviceStatusInput): DeviceStatusResult | null {
  const { now, employee, expected } = input;

  // 0. Not applicable.
  if (employee.employmentStatus === "INACTIVE" || employee.inviteStatus === "DEACTIVATED") {
    return null;
  }
  const device = input.device != null && input.device.isActive ? input.device : null;
  if (device === null) return noDeviceStatus(employee.inviteStatus);

  // 1. Permissions / selection.
  if (device.permissionState !== "APPROVED" || device.selectionState === "NONE") {
    const problems: string[] = [];
    if (device.permissionState !== "APPROVED") {
      problems.push(
        `Screen Time authorisation is ${device.permissionState.toLowerCase().replace(/_/g, " ")}`,
      );
    }
    if (device.selectionState === "NONE") problems.push("no apps or categories have been selected");
    return {
      badge: "PERMISSIONS_MISSING",
      severity: "warning",
      reason: capitalise(problems.join("; ")),
    };
  }

  const shiftActive = isShiftActive(expected);
  const sinceSyncMs =
    device.lastDeviceSyncAt === null ? null : now.getTime() - device.lastDeviceSyncAt.getTime();

  // 2. Offline.
  if (sinceSyncMs !== null && sinceSyncMs > DEVICE_STATUS_THRESHOLDS.offlineMs) {
    return {
      badge: "OFFLINE",
      severity: "error",
      reason: `Last device sync ${formatDuration(sinceSyncMs)} ago`,
    };
  }

  // 3. Sync delayed.
  const syncThresholdMs = shiftActive
    ? DEVICE_STATUS_THRESHOLDS.syncDelayedOnShiftMs
    : DEVICE_STATUS_THRESHOLDS.syncDelayedOffShiftMs;
  if (sinceSyncMs !== null && sinceSyncMs > syncThresholdMs) {
    return {
      badge: "SYNC_DELAYED",
      severity: "warning",
      reason: `Last device sync ${formatDuration(sinceSyncMs)} ago${shiftActive ? " during an active shift" : ""}`,
    };
  }

  // 4. Needs attention.
  const reported: WorkModeState = input.reportedState ?? device.restrictionEngineState;
  const reportedAt: Date | null = input.reportedAt ?? device.lastDeviceSyncAt;

  const reasons: string[] = [];
  for (const raw of input.attentionReasons ?? []) {
    const reason = raw.trim();
    if (reason.length > 0 && !reasons.includes(reason)) reasons.push(reason);
  }
  let skewOnly = reasons.length === 0;

  const skew = device.lastClockSkewSeconds ?? 0;
  if (Number.isFinite(skew) && Math.abs(skew) > DEVICE_STATUS_THRESHOLDS.clockSkewSeconds) {
    const seconds = Math.round(Math.abs(skew));
    reasons.push(`Device clock is ${seconds} s ${skew > 0 ? "ahead of" : "behind"} server time`);
  }

  if (reported === "PERMISSION_ERROR" || reported === "SYNC_ERROR") {
    reasons.push(`Device reported ${labelOf(reported)}`);
    skewOnly = false;
  }
  if (expected.state === "SYNC_ERROR") {
    reasons.push("The server flagged a sync error for this device");
    skewOnly = false;
  }

  if (shiftActive && reportedAt !== null) {
    const reportedLevel = restrictionLevelOf(reported);
    const expectedLevel = restrictionLevelOf(expected.state);
    const materiallyDifferent =
      reportedLevel !== null && expectedLevel !== null && reportedLevel !== expectedLevel;
    // When the current expectation began. A report made before then is pending confirmation, not a divergence.
    const baseline = latestOf(expected.since, expected.shiftStartedAt);
    // The device's latest report contradicts an expectation in force since `baseline`, so the disagreement
    // has lasted since then. Without a baseline, the report itself is the earliest provable start.
    const divergingMs = now.getTime() - (baseline ?? reportedAt).getTime();
    if (
      materiallyDifferent &&
      reportedSince(reportedAt, baseline) &&
      divergingMs > DEVICE_STATUS_THRESHOLDS.divergenceMs
    ) {
      reasons.push(
        `Device reports ${labelOf(reported)} but ${labelOf(expected.state)} is expected (for ${formatDuration(divergingMs)})`,
      );
      skewOnly = false;
    }
  }

  if (reasons.length > 0) {
    return {
      badge: "NEEDS_ATTENTION",
      severity: skewOnly ? "warning" : "error",
      reason: reasons.join("; "),
    };
  }

  // 5. Shift active.
  if (shiftActive) {
    if (expected.state === "MANAGER_OVERRIDE") {
      return {
        badge: "WORKING",
        severity: "info",
        reason: "Manager override in effect; restrictions are lifted",
      };
    }
    // Confirmation must come from this shift: a WORKING report left over from an earlier shift does not count.
    const confirmed =
      isRunningState(reported) && reportedSince(reportedAt, expected.shiftStartedAt ?? null);
    if (!confirmed) {
      return {
        badge: "WORKING",
        severity: "info",
        reason: "Shift active; waiting for the device to confirm Work Mode started",
      };
    }
    if (expected.state === "ON_BREAK") {
      // ON_BREAK only once the device has reported this break (not an earlier one in the same shift).
      return reported === "ON_BREAK" && reportedSince(reportedAt, expected.since ?? null)
        ? { badge: "ON_BREAK", severity: "info" }
        : {
            badge: "WORK_MODE_ACTIVE",
            severity: "ok",
            reason: "Break not yet confirmed by the device",
          };
    }
    if (reported === "ON_BREAK") {
      return {
        badge: "WORK_MODE_ACTIVE",
        severity: "ok",
        reason: "Device still reports a break in progress",
      };
    }
    return { badge: "WORK_MODE_ACTIVE", severity: "ok" };
  }

  // 6. No shift active.
  return noShiftStatus(expected.state, reported);
}

/**
 * Structural subset of the state machine's `ExpectedState` (workMode/types.ts) needed here, declared locally
 * so this module does not depend on the machine's internals.
 */
export interface ExpectedStateLike {
  readonly state: WorkModeState;
  readonly restrictionsShouldBeActive: boolean;
  readonly activeShift: { readonly id: string } | null;
  readonly workingInterval: { readonly startsAt: Date } | null;
}

/**
 * Adapts a fresh `computeExpectedState()` result for `deriveDeviceStatus`. Pass `since` (EmployeeWorkState.
 * stateSince) only when the stored state equals the freshly computed one; otherwise leave it out.
 */
export function toExpectedWorkState(
  expected: ExpectedStateLike,
  since?: Date | null,
): ExpectedWorkState {
  return {
    state: expected.state,
    restrictionsShouldBeActive: expected.restrictionsShouldBeActive,
    activeShiftId: expected.activeShift?.id ?? null,
    // workingInterval is the *imminent* interval while SHIFT_STARTING_SOON; only use it once a shift is active.
    shiftStartedAt:
      expected.activeShift !== null ? (expected.workingInterval?.startsAt ?? null) : null,
    since: since ?? null,
  };
}
