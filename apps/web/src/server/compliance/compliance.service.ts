import type { DeviceStatusBadge, InviteStatus } from "@workmode/shared/enums";
import { isShiftActive } from "@workmode/shared/status/deriveDeviceStatus";
import type {
  ComplianceEmployeeRow,
  ComplianceEmployeesQuery,
  ComplianceEmployeesResponse,
  ComplianceFilter,
  ComplianceMetrics,
  ComplianceSummaryResponse,
  UpcomingShift,
} from "@workmode/validation/compliance";
import type { DeviceStatus, ShiftSummary } from "@workmode/validation/refs";
import { toEmployeeSummary } from "@/server/employees/employees.mappers";
import type { ManagerContext } from "@/server/tenancy/context";
import { evaluateOrganisation, type EmployeeEvaluation } from "@/server/workState/workState.service";
import { DAY_MS, type WorkStateShift } from "@/server/workState/workState.repository";
import {
  findActiveEmployeeIds,
  findIntegrationStatuses,
  findUpcomingShifts,
  type UpcomingShiftRow,
} from "./compliance.repository";

/**
 * Compliance dashboard (§5). Every number is derived live from the same evaluation the Work Mode job
 * persists (`evaluateOrganisation`: state machine + `deriveDeviceStatus` per employee, batched), so the
 * cards, the employee list and the stored `EmployeeWorkState` rows never disagree. Read-only.
 */

export const UPCOMING_SHIFTS_WINDOW_MS = DAY_MS;
export const UPCOMING_SHIFTS_LIMIT = 20;

const AWAITING_SETUP: ReadonlySet<InviteStatus> = new Set<InviteStatus>([
  "NOT_INVITED",
  "INVITED",
  "JOINED",
  "SETUP_INCOMPLETE",
]);
const ATTENTION_BADGES: ReadonlySet<DeviceStatusBadge> = new Set<DeviceStatusBadge>([
  "NEEDS_ATTENTION",
  "SYNC_DELAYED",
  "OFFLINE",
]);

/** The flags one evaluation contributes to the metrics / filters. */
export interface ComplianceFlags {
  connected: boolean;
  awaitingSetup: boolean;
  missingPermissions: boolean;
  workingNow: boolean;
  workModeActive: boolean;
  onBreak: boolean;
  needsAttention: boolean;
}

export function complianceFlags(evaluation: EmployeeEvaluation): ComplianceFlags {
  const badge = evaluation.badge?.badge ?? null;
  const shiftActive = isShiftActive(evaluation.expectedWork);
  return {
    connected: evaluation.employee.inviteStatus === "CONNECTED",
    awaitingSetup: AWAITING_SETUP.has(evaluation.employee.inviteStatus),
    missingPermissions: badge === "PERMISSIONS_MISSING",
    workingNow: shiftActive,
    workModeActive: badge === "WORK_MODE_ACTIVE",
    onBreak: badge === "ON_BREAK",
    needsAttention:
      (badge !== null && ATTENTION_BADGES.has(badge)) || (badge === "PERMISSIONS_MISSING" && shiftActive),
  };
}

export function matchesComplianceFilter(flags: ComplianceFlags, filter: ComplianceFilter): boolean {
  switch (filter) {
    case "ALL":
      return true;
    case "CONNECTED":
      return flags.connected;
    case "AWAITING_SETUP":
      return flags.awaitingSetup;
    case "MISSING_PERMISSIONS":
      return flags.missingPermissions;
    case "WORKING_NOW":
      return flags.workingNow;
    case "WORK_MODE_ACTIVE":
      return flags.workModeActive;
    case "ON_BREAK":
      return flags.onBreak;
    case "NEEDS_ATTENTION":
      return flags.needsAttention;
    default: {
      const exhaustive: never = filter;
      throw new Error(`Unhandled compliance filter ${String(exhaustive)}`);
    }
  }
}

export function aggregateMetrics(evaluations: readonly EmployeeEvaluation[]): ComplianceMetrics {
  const metrics: ComplianceMetrics = {
    totalEmployees: evaluations.length,
    connected: 0,
    awaitingSetup: 0,
    missingPermissions: 0,
    workingNow: 0,
    workModeActive: 0,
    onBreak: 0,
    needsAttention: 0,
  };
  for (const evaluation of evaluations) {
    const flags = complianceFlags(evaluation);
    if (flags.connected) metrics.connected += 1;
    if (flags.awaitingSetup) metrics.awaitingSetup += 1;
    if (flags.missingPermissions) metrics.missingPermissions += 1;
    if (flags.workingNow) metrics.workingNow += 1;
    if (flags.workModeActive) metrics.workModeActive += 1;
    if (flags.onBreak) metrics.onBreak += 1;
    if (flags.needsAttention) metrics.needsAttention += 1;
  }
  return metrics;
}

function toDeviceStatus(evaluation: EmployeeEvaluation): DeviceStatus | null {
  if (!evaluation.badge) return null;
  return {
    badge: evaluation.badge.badge,
    reason: evaluation.badge.reason ?? null,
    severity: evaluation.badge.severity,
    since: evaluation.expectedSince ? evaluation.expectedSince.toISOString() : null,
  };
}

function toShiftSummary(shift: WorkStateShift): ShiftSummary {
  return {
    id: shift.id,
    startsAt: shift.startsAt.toISOString(),
    endsAt: shift.endsAt.toISOString(),
    timezone: shift.timezone,
    status: shift.status,
    location: shift.location ? { id: shift.location.id, name: shift.location.name } : null,
  };
}

function toComplianceRow(evaluation: EmployeeEvaluation, shifts: readonly WorkStateShift[]): ComplianceEmployeeRow {
  const activeShiftId = evaluation.expected.activeShift?.id ?? null;
  const activeShift = activeShiftId ? (shifts.find((s) => s.id === activeShiftId) ?? null) : null;
  return {
    employee: toEmployeeSummary(evaluation.employee),
    deviceStatus: toDeviceStatus(evaluation),
    permissionState: evaluation.device?.permissionState ?? null,
    selectionState: evaluation.device?.selectionState ?? null,
    expectedState: evaluation.expected.state,
    reportedState: evaluation.previous?.reportedState ?? null,
    activeShift: activeShift ? toShiftSummary(activeShift) : null,
    lastSyncAt: evaluation.device?.lastDeviceSyncAt?.toISOString() ?? null,
    attentionReason: evaluation.write.attentionReason,
  };
}

/** The phone can enforce Work Mode: connected, permission approved, not offline. */
export function isReadyForShift(evaluation: EmployeeEvaluation | undefined): boolean {
  if (!evaluation || evaluation.employee.inviteStatus !== "CONNECTED") return false;
  const badge = evaluation.badge?.badge ?? null;
  return badge !== null && badge !== "PERMISSIONS_MISSING" && badge !== "OFFLINE";
}

function toUpcomingShift(row: UpcomingShiftRow, evaluation: EmployeeEvaluation | undefined): UpcomingShift {
  return {
    shift: {
      id: row.id,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      timezone: row.timezone,
      status: row.status,
      location: row.location ? { id: row.location.id, name: row.location.name } : null,
    },
    employee: toEmployeeSummary(row.employee),
    deviceStatus: evaluation ? toDeviceStatus(evaluation) : null,
    ready: isReadyForShift(evaluation),
  };
}

async function evaluateAll(organisationId: string, employeeIds: readonly string[], now: Date) {
  const evaluated = await evaluateOrganisation({ organisationId, employeeIds, now });
  // Keep the caller's (name-sorted) order.
  const index = new Map(employeeIds.map((id, i) => [id, i]));
  const evaluations = [...evaluated.evaluations].sort(
    (a, b) => (index.get(a.employee.id) ?? 0) - (index.get(b.employee.id) ?? 0),
  );
  return { evaluations, inputs: evaluated.inputs };
}

export async function getComplianceSummary(
  ctx: ManagerContext,
  now: Date = new Date(),
): Promise<ComplianceSummaryResponse> {
  const organisationId = ctx.organisation.id;
  const employeeIds = await findActiveEmployeeIds(organisationId, {});
  const [{ evaluations }, upcoming, integrations] = await Promise.all([
    evaluateAll(organisationId, employeeIds, now),
    findUpcomingShifts(
      organisationId,
      now,
      new Date(now.getTime() + UPCOMING_SHIFTS_WINDOW_MS),
      UPCOMING_SHIFTS_LIMIT,
    ),
    findIntegrationStatuses(organisationId),
  ]);
  const byEmployee = new Map(evaluations.map((e) => [e.employee.id, e]));
  return {
    generatedAt: now.toISOString(),
    metrics: aggregateMetrics(evaluations),
    upcomingShifts: upcoming.map((row) => toUpcomingShift(row, byEmployee.get(row.employeeId))),
    integrationStatus: integrations.map((row) => ({
      provider: row.provider,
      status: row.status,
      lastSyncAt: row.connection?.lastSyncAt?.toISOString() ?? null,
      lastError: row.connection?.lastError ?? null,
    })),
  };
}

export async function listComplianceEmployees(
  ctx: ManagerContext,
  query: ComplianceEmployeesQuery,
  now: Date = new Date(),
): Promise<ComplianceEmployeesResponse> {
  const organisationId = ctx.organisation.id;
  const employeeIds = await findActiveEmployeeIds(organisationId, {
    locationId: query.locationId,
    teamId: query.teamId,
    search: query.search,
  });
  const { evaluations, inputs } = await evaluateAll(organisationId, employeeIds, now);
  const matching = evaluations.filter((e) => matchesComplianceFilter(complianceFlags(e), query.filter));
  const total = matching.length;
  const start = (query.page - 1) * query.pageSize;
  const page = matching.slice(start, start + query.pageSize);
  return {
    items: page.map((e) => toComplianceRow(e, inputs.shiftsByEmployee.get(e.employee.id) ?? [])),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.ceil(total / query.pageSize),
  };
}
