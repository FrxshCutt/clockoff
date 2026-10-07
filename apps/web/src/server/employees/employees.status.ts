import { prisma, type BreakSession, type EmployeeWorkState } from "@clockoff/db";
import type { InviteStatus, WorkModeState } from "@clockoff/shared/enums";
import {
  DEVICE_STATUS_THRESHOLDS,
  deriveDeviceStatus,
  isShiftActive,
  restrictionLevelOf,
  toExpectedWorkState,
  type DeviceStatusResult,
  type ExpectedWorkState,
} from "@clockoff/shared/status/deriveDeviceStatus";
import { deriveInviteStatus } from "@clockoff/shared/status/deriveInviteStatus";
import {
  computeExpectedState,
  type ExpectedState,
} from "@clockoff/shared/workMode/workModeMachine";
import {
  findBreakSessionsForShifts,
  findDevicesForEmployees,
  findEmployeesInOrganisation,
  findLiveInvitesForEmployees,
  findNextShiftsForEmployees,
  findOverridesForEmployees,
  findShiftsForEmployees,
  findWorkStatesForEmployees,
  type Db,
  type DeviceRow,
  type EmployeeRow,
  type InstantWindow,
  type NextShiftRow,
  type OverrideRow,
  type ShiftRow,
} from "./employees.repository";

/**
 * Everything `deriveDeviceStatus` (§9) and `computeExpectedState` (§6.2) need for a set of employees,
 * loaded in one query per table (`employeeId IN (...)`) so the employee list never N+1s. Exported for the
 * sync / compliance engineers (`getEmployeeStatusContext`).
 */

const HOUR_MS = 60 * 60 * 1000;
/** A shift lasts at most 24 h (SHIFT_LIMITS.maxDurationMinutes), so anything that could be active started within a day. */
const STATE_WINDOW_BACK_MS = 24 * HOUR_MS;
/** Enough to report the imminent shift (15 min warning) with margin; `nextShift` is loaded separately. */
const STATE_WINDOW_AHEAD_MS = 2 * HOUR_MS;

export interface EmployeeStatusContext {
  employee: EmployeeRow;
  /** The current device: the active one when it exists, else the most recent (for inviteStatus), else null. */
  device: DeviceRow | null;
  /** Most recently registered device regardless of activity (what `deriveInviteStatus` wants). */
  latestDevice: DeviceRow | null;
  workState: EmployeeWorkState | null;
  shifts: ShiftRow[];
  breakSessions: BreakSession[];
  overrides: OverrideRow[];
  nextShift: NextShiftRow | null;
  liveInviteCount: number;
  /** IANA zone used for presentation: primary location → organisation. */
  timezone: string;
}

export interface StatusContextOptions {
  now?: Date;
  db?: Db;
  /** Shift / override window to load for the state machine. Defaults to [now − 24 h, now + 2 h). */
  window?: InstantWindow;
  /** Pre-loaded employee rows (skips the employee query). */
  employees?: readonly EmployeeRow[];
  /** Organisation timezone fallback (looked up when omitted). */
  organisationTimezone?: string;
}

export function defaultStateWindow(now: Date): InstantWindow {
  return {
    from: new Date(now.getTime() - STATE_WINDOW_BACK_MS),
    to: new Date(now.getTime() + STATE_WINDOW_AHEAD_MS),
  };
}

function pickCurrentDevice(devices: readonly DeviceRow[]): DeviceRow | null {
  // `findDevicesForEmployees` orders active first, newest first.
  return devices[0] ?? null;
}

function pickLatestDevice(devices: readonly DeviceRow[]): DeviceRow | null {
  let latest: DeviceRow | null = null;
  for (const d of devices) {
    if (!latest || d.createdAt.getTime() > latest.createdAt.getTime()) latest = d;
  }
  return latest;
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    if (k === null) continue;
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

export async function getEmployeeStatusContext(
  organisationId: string,
  employeeIds: readonly string[],
  options: StatusContextOptions = {},
): Promise<Map<string, EmployeeStatusContext>> {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const window = options.window ?? defaultStateWindow(now);
  const result = new Map<string, EmployeeStatusContext>();
  if (employeeIds.length === 0) return result;

  const employees =
    options.employees ?? (await findEmployeesInOrganisation(organisationId, employeeIds, db));
  const ids = employees.map((e) => e.id);
  if (ids.length === 0) return result;

  const organisationTimezone =
    options.organisationTimezone ??
    (
      await db.organisation.findUniqueOrThrow({
        where: { id: organisationId },
        select: { timezone: true },
      })
    ).timezone;

  const [devices, workStates, shifts, overrides, nextShifts, liveInvites] = await Promise.all([
    findDevicesForEmployees(organisationId, ids, db),
    findWorkStatesForEmployees(ids, db),
    findShiftsForEmployees(organisationId, ids, window, db),
    findOverridesForEmployees(organisationId, ids, window, db),
    findNextShiftsForEmployees(organisationId, ids, now, db),
    findLiveInvitesForEmployees(organisationId, ids, now, db),
  ]);
  const breakSessions = await findBreakSessionsForShifts(
    organisationId,
    shifts.map((s) => s.id),
    db,
  );

  const devicesByEmployee = groupBy(devices, (d) => d.employeeId);
  const workStateByEmployee = new Map(workStates.map((w) => [w.employeeId, w]));
  const shiftsByEmployee = groupBy(shifts, (s) => s.employeeId);
  const breaksByEmployee = groupBy(breakSessions, (b) => b.employeeId);
  const nextShiftByEmployee = new Map(nextShifts.map((s) => [s.employeeId, s]));
  const invitesByEmployee = groupBy(liveInvites, (i) => i.employeeId);
  const orgWideOverrides = overrides.filter((o) => o.employeeId === null);
  const overridesByEmployee = groupBy(overrides, (o) => o.employeeId);

  for (const employee of employees) {
    const employeeDevices = devicesByEmployee.get(employee.id) ?? [];
    result.set(employee.id, {
      employee,
      device: pickCurrentDevice(employeeDevices),
      latestDevice: pickLatestDevice(employeeDevices),
      workState: workStateByEmployee.get(employee.id) ?? null,
      shifts: shiftsByEmployee.get(employee.id) ?? [],
      breakSessions: breaksByEmployee.get(employee.id) ?? [],
      overrides: [...orgWideOverrides, ...(overridesByEmployee.get(employee.id) ?? [])],
      nextShift: nextShiftByEmployee.get(employee.id) ?? null,
      liveInviteCount: (invitesByEmployee.get(employee.id) ?? []).length,
      timezone: employee.primaryLocation?.timezone ?? organisationTimezone,
    });
  }
  return result;
}

export interface EmployeeStatusComputation {
  expected: ExpectedState;
  expectedWorkState: ExpectedWorkState;
  /**
   * §9 lifecycle derived live from the link, the latest device, employment status and live invites —
   * the same inputs `recomputeEmployeeInviteStatus` persists. `Employee.inviteStatus` is only refreshed
   * when something happens (invite, join, leave, device change), so an invite that merely expired since
   * then still reads INVITED there; this value reads NOT_INVITED.
   */
  inviteStatus: InviteStatus;
  status: DeviceStatusResult | null;
  /** When the current (stored) state began, when the stored state agrees with the computed one. */
  since: Date | null;
  diverged: boolean;
}

/** The §9 lifecycle for a loaded context, from the shared decision table. Pure. */
export function deriveEmployeeInviteStatus(ctx: EmployeeStatusContext): InviteStatus {
  const hasLink = ctx.employee.userLink !== null && ctx.employee.userLink.unlinkedAt === null;
  return deriveInviteStatus({
    hasLink,
    // Only a device registered while the current link was made says anything about setup progress.
    device: hasLink ? ctx.latestDevice : null,
    employmentStatus: ctx.employee.employmentStatus,
    hasPendingInvite: ctx.liveInviteCount > 0,
  });
}

/** Evaluate the state machine and the §9 badge for one loaded context at `now`. Pure. */
export function computeEmployeeStatus(
  ctx: EmployeeStatusContext,
  now: Date = new Date(),
): EmployeeStatusComputation {
  const inviteStatus = deriveEmployeeInviteStatus(ctx);
  const activeDevice = ctx.device && ctx.device.isActive ? ctx.device : null;
  const expected = computeExpectedState({
    now,
    shifts: ctx.shifts,
    breakSessions: ctx.breakSessions,
    overrides: ctx.overrides,
    permissionState: activeDevice?.permissionState ?? "NOT_DETERMINED",
    timezone: ctx.timezone,
    employeeId: ctx.employee.id,
  });
  const since =
    ctx.workState && ctx.workState.state === expected.state ? ctx.workState.stateSince : null;
  const expectedWorkState = toExpectedWorkState(expected, since);
  const reportedState: WorkModeState | null = ctx.workState?.reportedState ?? null;
  const reportedAt: Date | null = ctx.workState?.reportedAt ?? null;
  const status = deriveDeviceStatus({
    now,
    employee: { inviteStatus, employmentStatus: ctx.employee.employmentStatus },
    device: activeDevice,
    expected: expectedWorkState,
    reportedState,
    reportedAt,
    attentionReasons: ctx.workState?.attentionReason ? [ctx.workState.attentionReason] : null,
  });
  return {
    expected,
    expectedWorkState,
    inviteStatus,
    status,
    since,
    diverged: isDiverged(expectedWorkState, reportedState, reportedAt, now),
  };
}

/**
 * "Reported disagrees with expected beyond the grace period": the same test `deriveDeviceStatus` applies
 * for NEEDS_ATTENTION (materially different restriction level while a shift is active, report made after
 * the expectation began, for longer than `divergenceMs`). Exposed as a boolean for `GET /employees/:id/state`.
 */
export function isDiverged(
  expected: ExpectedWorkState,
  reportedState: WorkModeState | null,
  reportedAt: Date | null,
  now: Date,
): boolean {
  if (reportedState === null || reportedAt === null) return false;
  if (!isShiftActive(expected)) return false;
  const reportedLevel = restrictionLevelOf(reportedState);
  const expectedLevel = restrictionLevelOf(expected.state);
  if (reportedLevel === null || expectedLevel === null || reportedLevel === expectedLevel)
    return false;
  const baseline = latestOf(expected.since ?? null, expected.shiftStartedAt ?? null);
  if (baseline !== null && reportedAt.getTime() < baseline.getTime()) return false;
  return now.getTime() - (baseline ?? reportedAt).getTime() > DEVICE_STATUS_THRESHOLDS.divergenceMs;
}

function latestOf(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}
