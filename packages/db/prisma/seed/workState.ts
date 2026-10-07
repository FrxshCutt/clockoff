import type { Prisma } from "@prisma/client";
import type {
  BreakRestrictionBehaviour,
  BreakSessionStatus,
  EmploymentStatus,
  InviteStatus,
  OverrideType,
  PermissionState,
  SelectionState,
  ShiftStatus,
  WorkModeState,
  WorkStateSource,
} from "@clockoff/shared/enums";
import {
  deriveDeviceStatus,
  isShiftActive,
  toExpectedWorkState,
  type DeviceStatusResult,
} from "@clockoff/shared/status/deriveDeviceStatus";
import {
  computeExpectedState,
  type ExpectedState,
  type WorkModeMachineOptions,
} from "@clockoff/shared/workMode/workModeMachine";
import { MINUTE_MS, ceilMinutes } from "./util";

/**
 * Consistent `EmployeeWorkState` rows for seeded employees. The server job (`apps/web/src/server/workState`)
 * evaluates each employee with the Work Mode state machine and `deriveDeviceStatus`, then stores what the
 * dashboard shows; this module runs the same shared functions over the seeded rows so a fresh seed looks
 * exactly like a database the job has just processed. The few private helpers of that service (effective
 * break end, "expectation began at", attention reason wording) are mirrored here with the same semantics.
 */

export interface SeedShift {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: ShiftStatus;
  version: number;
  deletedAt: null;
}

export interface SeedBreakSession {
  id: string;
  shiftId: string;
  startedAt: Date;
  plannedEndsAt: Date;
  endedAt: Date | null;
  status: BreakSessionStatus;
  restrictionBehaviour: BreakRestrictionBehaviour;
  relaxedCategories: string[];
}

export interface SeedOverride {
  id: string;
  type: OverrideType;
  startsAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  employeeId: string | null;
  payload: Record<string, unknown>;
}

export interface SeedDeviceState {
  isActive: boolean;
  permissionState: PermissionState;
  selectionState: SelectionState;
  lastDeviceSyncAt: Date | null;
  lastClockSkewSeconds: number | null;
}

export interface WorkStateEvaluationInput {
  now: Date;
  timezone: string;
  employeeId: string;
  employee: { inviteStatus: InviteStatus; employmentStatus: EmploymentStatus; linkedAt: Date };
  device: SeedDeviceState;
  shifts: readonly SeedShift[];
  sessions: readonly SeedBreakSession[];
  overrides: readonly SeedOverride[];
  /** From the employee's resolved Work Policy (`restrictionConfig.preShiftWarningMinutes`). */
  preShiftWarningMinutes: number;
  /** The last engine state the device reported and when; null when it never reported. */
  reported: { state: WorkModeState; at: Date } | null;
}

export interface WorkStateEvaluation {
  expected: ExpectedState;
  badge: DeviceStatusResult | null;
  row: Prisma.EmployeeWorkStateCreateManyInput;
}

/** Prefix the work-state service stores while a sync-delayed / offline episode is running. */
export const SYNC_DELAYED_MARKER = "Device sync delayed";
const SHIFT_ENDING_WARNING_MINUTES = 5;

export function machineOptions(preShiftWarningMinutes: number): Required<WorkModeMachineOptions> {
  return {
    preShiftWarningMinutes: preShiftWarningMinutes >= 0 ? preShiftWarningMinutes : 15,
    shiftEndingWarningMinutes: SHIFT_ENDING_WARNING_MINUTES,
  };
}

/** Shift rows as they stood at `at`: a shift whose end has passed is COMPLETED, otherwise SCHEDULED. */
export function shiftsAsOf(shifts: readonly SeedShift[], at: Date): SeedShift[] {
  return shifts.map((s) => ({
    ...s,
    status: s.endsAt.getTime() <= at.getTime() ? "COMPLETED" : "SCHEDULED",
  }));
}

/** Pure evaluation of the state machine at `at` over the employee's rows as they stood then. */
export function expectedStateAt(
  input: Pick<
    WorkStateEvaluationInput,
    | "timezone"
    | "employeeId"
    | "device"
    | "shifts"
    | "sessions"
    | "overrides"
    | "preShiftWarningMinutes"
  >,
  at: Date,
): ExpectedState {
  return computeExpectedState({
    now: at,
    shifts: shiftsAsOf(input.shifts, at),
    breakSessions: input.sessions.filter((s) => s.startedAt.getTime() <= at.getTime()),
    overrides: input.overrides,
    permissionState: input.device.permissionState,
    timezone: input.timezone,
    employeeId: input.employeeId,
    options: machineOptions(input.preShiftWarningMinutes),
  });
}

/** Effective end of a session: `min(endedAt ?? plannedEndsAt, plannedEndsAt, shift.endsAt)`, never before start. */
function effectiveBreakEnd(session: SeedBreakSession, shiftEndsAt: Date, now: Date): Date {
  const startMs = session.startedAt.getTime();
  const capMs = Math.max(startMs, Math.min(session.plannedEndsAt.getTime(), shiftEndsAt.getTime()));
  if (session.endedAt)
    return new Date(Math.max(startMs, Math.min(session.endedAt.getTime(), capMs)));
  if (session.status === "ENDED") return new Date(capMs);
  return new Date(Math.max(startMs, Math.min(capMs, now.getTime())));
}

/**
 * When the current expectation began: the latest boundary ≤ now among the working interval start, the
 * SHIFT_ENDING threshold, the active break's start, the ends of earlier breaks in the interval and the active
 * override's start (null when nothing applies — e.g. plain OFF_SHIFT).
 */
function estimateExpectedSince(
  expected: ExpectedState,
  shifts: readonly SeedShift[],
  sessions: readonly SeedBreakSession[],
  now: Date,
  options: Required<WorkModeMachineOptions>,
): Date | null {
  const nowMs = now.getTime();
  const candidates: number[] = [];
  const interval = expected.workingInterval;
  if (interval && expected.activeShift) {
    candidates.push(interval.startsAt.getTime());
    candidates.push(interval.endsAt.getTime() - options.shiftEndingWarningMinutes * MINUTE_MS);
    for (const ref of interval.shifts) {
      const shift = shifts.find((s) => s.id === ref.id);
      for (const session of sessions.filter((s) => s.shiftId === ref.id)) {
        if (expected.activeBreak?.id === session.id) continue;
        candidates.push(effectiveBreakEnd(session, shift?.endsAt ?? ref.endsAt, now).getTime());
      }
    }
  } else if (interval) {
    candidates.push(interval.startsAt.getTime() - options.preShiftWarningMinutes * MINUTE_MS);
  }
  if (expected.activeBreak) candidates.push(expected.activeBreak.startedAt.getTime());
  if (expected.activeOverride) candidates.push(expected.activeOverride.startsAt.getTime());
  const past = candidates.filter((ms) => Number.isFinite(ms) && ms <= nowMs);
  if (past.length === 0) return null;
  return new Date(Math.max(...past));
}

/** The reason the dashboard stores next to the state, worded like the work-state service does. */
function attentionReasonFor(badge: DeviceStatusResult | null, shiftActive: boolean): string | null {
  if (!badge) return null;
  switch (badge.badge) {
    case "NEEDS_ATTENTION":
      return badge.reason ?? "Needs attention";
    case "SYNC_DELAYED":
    case "OFFLINE":
      return `${SYNC_DELAYED_MARKER}: ${badge.reason ?? "no recent device sync"}`;
    case "PERMISSIONS_MISSING":
      return shiftActive
        ? `Work Mode cannot be enforced during the current shift: ${badge.reason ?? "permissions missing"}`
        : null;
    case "READY":
    case "OFF_SHIFT":
    case "WORKING":
    case "WORK_MODE_ACTIVE":
    case "ON_BREAK":
      return null;
    default: {
      const exhaustive: never = badge.badge;
      throw new Error(`seed: unhandled badge ${String(exhaustive)}`);
    }
  }
}

/** The most recent shift end at or before `now`, as the start of an OFF_SHIFT period. */
function lastShiftEndBefore(shifts: readonly SeedShift[], now: Date): Date | null {
  let latest: Date | null = null;
  for (const shift of shifts) {
    if (shift.endsAt.getTime() <= now.getTime() && (latest === null || shift.endsAt > latest)) {
      latest = shift.endsAt;
    }
  }
  return latest;
}

export function evaluateWorkState(input: WorkStateEvaluationInput): WorkStateEvaluation {
  const { now } = input;
  const options = machineOptions(input.preShiftWarningMinutes);
  const shifts = shiftsAsOf(input.shifts, now);
  const expected = expectedStateAt({ ...input, shifts }, now);
  const expectedSince = estimateExpectedSince(expected, shifts, input.sessions, now, options);
  const expectedWork = toExpectedWorkState(expected, expectedSince);

  const badge = deriveDeviceStatus({
    now,
    employee: {
      inviteStatus: input.employee.inviteStatus,
      employmentStatus: input.employee.employmentStatus,
    },
    device: {
      isActive: input.device.isActive,
      permissionState: input.device.permissionState,
      selectionState: input.device.selectionState,
      restrictionEngineState: input.reported?.state ?? "UNKNOWN",
      lastDeviceSyncAt: input.device.lastDeviceSyncAt,
      lastClockSkewSeconds: input.device.lastClockSkewSeconds,
    },
    expected: expectedWork,
    reportedState: input.reported?.state ?? null,
    reportedAt: input.reported?.at ?? null,
  });
  const shiftActive = isShiftActive(expectedWork);

  // Displayed state, as the service settles it: the device's report once it was made after the current
  // expectation began (DEVICE_REPORT), otherwise the server expectation (SERVER_COMPUTED).
  let state: WorkModeState;
  let source: WorkStateSource;
  const reported = input.reported;
  if (reported && (expectedSince === null || reported.at.getTime() >= expectedSince.getTime())) {
    state = reported.state;
    source = "DEVICE_REPORT";
  } else {
    state = expected.state;
    source = "SERVER_COMPUTED";
  }
  const stateSince = expectedSince ?? lastShiftEndBefore(shifts, now) ?? input.employee.linkedAt;

  const activeShiftId = expected.activeShift?.id ?? null;
  const activeShift = activeShiftId ? (shifts.find((s) => s.id === activeShiftId) ?? null) : null;
  const sessionsOfShift = activeShift
    ? input.sessions.filter((s) => s.shiftId === activeShift.id)
    : [];
  const breakMinutesUsed = activeShift
    ? sessionsOfShift.reduce(
        (sum, s) =>
          sum +
          ceilMinutes(
            effectiveBreakEnd(s, activeShift.endsAt, now).getTime() - s.startedAt.getTime(),
          ),
        0,
      )
    : 0;

  const row: Prisma.EmployeeWorkStateCreateManyInput = {
    employeeId: input.employeeId,
    state,
    stateSince,
    activeShiftId,
    activeBreakSessionId: expected.activeBreak?.id ?? null,
    breaksTakenCount: sessionsOfShift.length,
    breakMinutesUsed,
    source,
    reportedState: reported?.state ?? null,
    reportedAt: reported?.at ?? null,
    expectedState: expected.state,
    expectedRestriction: expected.effectiveRestriction,
    expectedComputedAt: now,
    nextTransitionAt: expected.nextTransitionAt,
    attentionReason: attentionReasonFor(badge, shiftActive),
    lastUpdatedAt: now,
    createdAt: input.employee.linkedAt,
  };
  return { expected, badge, row };
}
