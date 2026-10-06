import {
  prisma,
  type BreakSession,
  type Device,
  type EmployeeWorkState,
  type ManagerOverride,
  type Prisma,
} from "@workmode/db";
import type { PermissionState, WorkModeState, WorkStateSource } from "@workmode/shared/enums";
import {
  deriveDeviceStatus,
  isShiftActive,
  toExpectedWorkState,
  type DeviceStatusResult,
  type ExpectedWorkState,
} from "@workmode/shared/status/deriveDeviceStatus";
import {
  computeExpectedState,
  type ExpectedState,
  type WorkModeMachineOptions,
} from "@workmode/shared/workMode/workModeMachine";
import { publishEvent } from "@/server/events";
import { resolveForEmployees, type EmployeePolicyResolution } from "./externalServices";
import {
  loadWorkStateInputs,
  upsertWorkState,
  type ShiftWindow,
  type WorkStateEmployee,
  type WorkStateInputs,
  type WorkStateShift,
  type WorkStateWrite,
} from "./workState.repository";

/**
 * EmployeeWorkState derivation (§9 / §10). One evaluation = the state machine (`computeExpectedState`) over
 * the employee's rows + the device's last report + the derived badge (`deriveDeviceStatus`), reduced to the
 * columns of `EmployeeWorkState`.
 *
 * Displayed `state` rule (documented in docs/WORK_MODE_SERVER_JOB.md):
 *   - no device report yet                      → `state` = expected, `source` = SERVER_COMPUTED;
 *   - the expected state changed at instant T and the device's last report predates T (it has not caught up
 *     with the transition)                      → `state` = expected, `source` = SERVER_COMPUTED, `stateSince` = T;
 *   - otherwise (the report was made at/after the current expectation began) → `state` = reported state,
 *     `source` = DEVICE_REPORT. The device paths (`/device/state`, `/events`) switch back to DEVICE_REPORT
 *     when a fresh report arrives.
 * `stateSince` only moves when the displayed value changes.
 */

type Db = Prisma.TransactionClient | typeof prisma;

/** Prefix of the stored `attentionReason` while a sync-delayed / offline episode is running. */
export const SYNC_DELAYED_MARKER = "Device sync delayed";

export interface EvaluateEmployeeInput {
  now: Date;
  organisation: { id: string; timezone: string };
  employee: WorkStateEmployee;
  shifts: readonly WorkStateShift[];
  sessionsByShift: ReadonlyMap<string, readonly BreakSession[]>;
  overrides: readonly ManagerOverride[];
  device: Device | null;
  previous: EmployeeWorkState | null;
  policy?: EmployeePolicyResolution | null;
}

export interface EmployeeEvaluation {
  organisationId: string;
  employee: WorkStateEmployee;
  device: Device | null;
  previous: EmployeeWorkState | null;
  expected: ExpectedState;
  expectedWork: ExpectedWorkState;
  /** Best estimate of when the current expectation began (null when unknown). */
  expectedSince: Date | null;
  badge: DeviceStatusResult | null;
  write: WorkStateWrite;
  /** Expected state / restriction / active shift / active break differ from the stored expectation. */
  expectedChanged: boolean;
  /** Anything managers see changed (state, source, expectation, attention reason). */
  changed: boolean;
  /** The badge is SYNC_DELAYED/OFFLINE now and the stored row does not carry the episode marker yet. */
  syncDelayedEpisodeStarting: boolean;
  policy: EmployeePolicyResolution | null;
  timezone: string;
}

const MS_PER_MINUTE = 60_000;

function ceilMinutes(ms: number): number {
  return ms <= 0 ? 0 : Math.ceil(ms / MS_PER_MINUTE);
}

/** Effective end of a session: `min(endedAt ?? plannedEndsAt, plannedEndsAt, shift.endsAt)`, never before start. */
export function effectiveBreakEnd(
  session: Pick<BreakSession, "startedAt" | "plannedEndsAt" | "endedAt" | "status">,
  shiftEndsAt: Date,
  now: Date,
): Date {
  const startMs = session.startedAt.getTime();
  const capMs = Math.max(startMs, Math.min(session.plannedEndsAt.getTime(), shiftEndsAt.getTime()));
  if (session.endedAt) return new Date(Math.max(startMs, Math.min(session.endedAt.getTime(), capMs)));
  if (session.status === "ENDED") return new Date(capMs);
  return new Date(Math.max(startMs, Math.min(capMs, now.getTime())));
}

/** Breaks taken / minutes used on one shift so far (same reading of a session as the break rules). */
export function summariseShiftBreaks(
  shift: Pick<WorkStateShift, "endsAt">,
  sessions: readonly BreakSession[],
  now: Date,
): { count: number; minutes: number } {
  let minutes = 0;
  for (const session of sessions) {
    minutes += ceilMinutes(effectiveBreakEnd(session, shift.endsAt, now).getTime() - session.startedAt.getTime());
  }
  return { count: sessions.length, minutes };
}

/**
 * When the current expectation began, from the rows themselves: the latest boundary ≤ now among the working
 * interval start, the SHIFT_ENDING threshold, the active break's start, the ends of earlier breaks in the
 * interval and the active override's start. Feeds `deriveDeviceStatus` so a device report made before the
 * expectation changed is "not caught up yet" rather than a divergence.
 */
export function estimateExpectedSince(
  expected: ExpectedState,
  shifts: readonly WorkStateShift[],
  sessionsByShift: ReadonlyMap<string, readonly BreakSession[]>,
  now: Date,
  options: Required<WorkModeMachineOptions>,
): Date | null {
  const nowMs = now.getTime();
  const candidates: number[] = [];
  const interval = expected.workingInterval;
  if (interval && expected.activeShift) {
    candidates.push(interval.startsAt.getTime());
    candidates.push(interval.endsAt.getTime() - options.shiftEndingWarningMinutes * MS_PER_MINUTE);
    for (const ref of interval.shifts) {
      const shift = shifts.find((s) => s.id === ref.id);
      for (const session of sessionsByShift.get(ref.id) ?? []) {
        if (expected.activeBreak?.id === session.id) continue;
        candidates.push(effectiveBreakEnd(session, shift?.endsAt ?? ref.endsAt, now).getTime());
      }
    }
  } else if (interval) {
    candidates.push(interval.startsAt.getTime() - options.preShiftWarningMinutes * MS_PER_MINUTE);
  }
  if (expected.activeBreak) candidates.push(expected.activeBreak.startedAt.getTime());
  if (expected.activeOverride) candidates.push(expected.activeOverride.startsAt.getTime());
  const past = candidates.filter((ms) => Number.isFinite(ms) && ms <= nowMs);
  if (past.length === 0) return null;
  return new Date(Math.max(...past));
}

export function machineOptionsFor(policy: EmployeePolicyResolution | null | undefined): Required<WorkModeMachineOptions> {
  const pre = policy?.policy?.currentVersion?.restrictionConfig.preShiftWarningMinutes;
  return {
    preShiftWarningMinutes: typeof pre === "number" && pre >= 0 ? pre : 15,
    shiftEndingWarningMinutes: 5,
  };
}

interface DisplayedState {
  state: WorkModeState;
  stateSince: Date;
  source: WorkStateSource;
}

function deriveDisplayedState(
  previous: EmployeeWorkState | null,
  expected: ExpectedState,
  expectedChanged: boolean,
  now: Date,
): DisplayedState {
  const reportedState = previous?.reportedState ?? null;
  const reportedAt = previous?.reportedAt ?? null;
  const keepSince = (state: WorkModeState): Date =>
    previous && previous.state === state ? previous.stateSince : now;

  if (reportedState === null || reportedAt === null) {
    return { state: expected.state, stateSince: keepSince(expected.state), source: "SERVER_COMPUTED" };
  }
  if (expectedChanged && reportedAt.getTime() < now.getTime()) {
    return { state: expected.state, stateSince: keepSince(expected.state), source: "SERVER_COMPUTED" };
  }
  if (previous && previous.source === "SERVER_COMPUTED") {
    // Still waiting for the device to catch up with the last transition: follow the expectation.
    return { state: expected.state, stateSince: keepSince(expected.state), source: "SERVER_COMPUTED" };
  }
  return { state: reportedState, stateSince: keepSince(reportedState), source: "DEVICE_REPORT" };
}

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
      throw new Error(`Unhandled badge ${String(exhaustive)}`);
    }
  }
}

/** Pure: evaluate one employee at `now` from already-loaded rows. */
export function evaluateEmployee(input: EvaluateEmployeeInput): EmployeeEvaluation {
  const { now, employee, device, previous } = input;
  const policy = input.policy ?? null;
  const options = machineOptionsFor(policy);
  const timezone = employee.primaryLocation?.timezone ?? input.organisation.timezone;
  const permissionState: PermissionState = device?.permissionState ?? "NOT_DETERMINED";
  const breakSessions = input.shifts.flatMap((s) => input.sessionsByShift.get(s.id) ?? []);

  const expected = computeExpectedState({
    now,
    shifts: input.shifts,
    breakSessions,
    overrides: input.overrides,
    permissionState,
    timezone,
    employeeId: employee.id,
    options,
  });

  const activeShiftId = expected.activeShift?.id ?? null;
  const activeBreakSessionId = expected.activeBreak?.id ?? null;
  const expectedChanged =
    previous === null ||
    previous.expectedState !== expected.state ||
    previous.expectedRestriction !== expected.effectiveRestriction ||
    (previous.activeShiftId ?? null) !== activeShiftId ||
    (previous.activeBreakSessionId ?? null) !== activeBreakSessionId;

  const expectedSince = estimateExpectedSince(expected, input.shifts, input.sessionsByShift, now, options);
  const expectedWork = toExpectedWorkState(expected, expectedSince);
  const badge = deriveDeviceStatus({
    now,
    employee: { inviteStatus: employee.inviteStatus, employmentStatus: employee.employmentStatus },
    device,
    expected: expectedWork,
    reportedState: previous?.reportedState ?? null,
    reportedAt: previous?.reportedAt ?? null,
  });
  const shiftActive = isShiftActive(expectedWork);
  const displayed = deriveDisplayedState(previous, expected, expectedChanged, now);

  const activeShift = activeShiftId ? input.shifts.find((s) => s.id === activeShiftId) ?? null : null;
  const breakSummary = activeShift
    ? summariseShiftBreaks(activeShift, input.sessionsByShift.get(activeShift.id) ?? [], now)
    : { count: 0, minutes: 0 };

  const attentionReason = attentionReasonFor(badge, shiftActive);
  const write: WorkStateWrite = {
    state: displayed.state,
    stateSince: displayed.stateSince,
    source: displayed.source,
    activeShiftId,
    activeBreakSessionId,
    breaksTakenCount: breakSummary.count,
    breakMinutesUsed: breakSummary.minutes,
    expectedState: expected.state,
    expectedRestriction: expected.effectiveRestriction,
    expectedComputedAt: now,
    nextTransitionAt: expected.nextTransitionAt,
    attentionReason,
    lastUpdatedAt: now,
  };

  const changed =
    previous === null ||
    previous.state !== write.state ||
    previous.source !== write.source ||
    previous.expectedState !== write.expectedState ||
    previous.expectedRestriction !== write.expectedRestriction ||
    (previous.activeShiftId ?? null) !== write.activeShiftId ||
    (previous.activeBreakSessionId ?? null) !== write.activeBreakSessionId ||
    (previous.attentionReason ?? null) !== write.attentionReason;

  const syncDelayedEpisodeStarting =
    (badge?.badge === "SYNC_DELAYED" || badge?.badge === "OFFLINE") &&
    !(previous?.attentionReason ?? "").includes(SYNC_DELAYED_MARKER);

  return {
    organisationId: input.organisation.id,
    employee,
    device,
    previous,
    expected,
    expectedWork,
    expectedSince,
    badge,
    write,
    expectedChanged,
    changed,
    syncDelayedEpisodeStarting,
    policy,
    timezone,
  };
}

export interface OrganisationEvaluation {
  inputs: WorkStateInputs;
  /** Resolved policies by employee id (null when `withPolicies` was false). */
  policies: ReadonlyMap<string, EmployeePolicyResolution> | null;
  evaluations: EmployeeEvaluation[];
}

/** Load the rows for `employeeIds` of one organisation and evaluate each (no writes). */
export async function evaluateOrganisation(
  params: {
    organisationId: string;
    employeeIds: readonly string[];
    now: Date;
    shiftWindow?: ShiftWindow;
    /** Resolve policies too (pre-shift warning minutes, resolution warnings). Default true. */
    withPolicies?: boolean;
  },
  db: Db = prisma,
): Promise<OrganisationEvaluation> {
  // Policy resolution is owned by the policies service and reads through the shared client; `db` scopes
  // the work-state rows only.
  const [inputs, policies] = await Promise.all([
    loadWorkStateInputs(params, db),
    params.withPolicies === false || params.employeeIds.length === 0
      ? Promise.resolve(null)
      : resolveForEmployees(params.organisationId, [...new Set(params.employeeIds)], params.now),
  ]);
  const evaluations = inputs.employees.map((employee) =>
    evaluateEmployee({
      now: params.now,
      organisation: inputs.organisation,
      employee,
      shifts: inputs.shiftsByEmployee.get(employee.id) ?? [],
      sessionsByShift: inputs.sessionsByShift,
      overrides: inputs.overrides,
      device: inputs.devicesByEmployee.get(employee.id) ?? null,
      previous: inputs.workStatesByEmployee.get(employee.id) ?? null,
      policy: policies?.get(employee.id) ?? null,
    }),
  );
  return { inputs, policies, evaluations };
}

export interface PersistedEvaluation {
  row: EmployeeWorkState;
  /** This write started a sync-delayed episode (emit DEVICE_SYNC_DELAYED exactly once). */
  startedSyncDelayedEpisode: boolean;
}

export async function persistEvaluation(
  evaluation: EmployeeEvaluation,
  db: Db = prisma,
): Promise<PersistedEvaluation> {
  const { row, wonGuard } = await upsertWorkState(
    evaluation.employee.id,
    evaluation.write,
    evaluation.syncDelayedEpisodeStarting ? { guardMarker: SYNC_DELAYED_MARKER } : {},
    db,
  );
  return { row, startedSyncDelayedEpisode: evaluation.syncDelayedEpisodeStarting && wonGuard };
}

/** `employee.work_state.changed` — ids, states and the derived badge only (§12). */
export function publishWorkStateChanged(evaluation: EmployeeEvaluation, row: EmployeeWorkState): void {
  publishEvent({
    type: "employee.work_state.changed",
    organisationId: evaluation.organisationId,
    employeeId: evaluation.employee.id,
    payload: {
      employeeId: evaluation.employee.id,
      state: row.state,
      source: row.source,
      expectedState: row.expectedState,
      expectedRestriction: row.expectedRestriction,
      activeShiftId: row.activeShiftId,
      activeBreakSessionId: row.activeBreakSessionId,
      badge: evaluation.badge?.badge ?? null,
      nextTransitionAt: row.nextTransitionAt ? row.nextTransitionAt.toISOString() : null,
    },
  });
}

/**
 * Re-evaluate and persist one employee right away (after a break starts/ends, a device check-in, an override).
 * Publishes `employee.work_state.changed` when something managers see changed. Returns null when the employee
 * is not an active member of the organisation.
 */
export async function recomputeEmployeeWorkState(
  params: { organisationId: string; employeeId: string; now?: Date; publish?: boolean },
  db: Db = prisma,
): Promise<{ evaluation: EmployeeEvaluation; row: EmployeeWorkState } | null> {
  const now = params.now ?? new Date();
  const { evaluations } = await evaluateOrganisation(
    { organisationId: params.organisationId, employeeIds: [params.employeeId], now },
    db,
  );
  const evaluation = evaluations[0];
  if (!evaluation) return null;
  const { row } = await persistEvaluation(evaluation, db);
  if ((params.publish ?? true) && evaluation.changed) publishWorkStateChanged(evaluation, row);
  return { evaluation, row };
}
