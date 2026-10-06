import { prisma, type Prisma, type ShiftStatus } from "@workmode/db";
import { breakPolicyFromRecord, type BreakPolicyLike } from "@workmode/shared/breaks/breakRules";
import {
  fromBreakPolicyAssignment,
  indexPoliciesById,
  resolvePolicy,
} from "@workmode/shared/policy/resolvePolicy";
import { shiftInclude, type ShiftRow } from "./shifts.mappers";
import type { IntervalLike } from "./shifts.rules";

/**
 * Shift queries. Every function takes the `organisationId` explicitly — it always comes from the caller's
 * verified membership (or the device row), never from request input. Soft-deleted rows are never returned
 * unless a function says so.
 */

export type Db = Prisma.TransactionClient | typeof prisma;

export const employeeForShiftSelect = {
  id: true,
  firstName: true,
  lastName: true,
  employmentStatus: true,
  deletedAt: true,
  primaryLocationId: true,
  teams: { select: { teamId: true } },
} satisfies Prisma.EmployeeSelect;
export type EmployeeForShift = Prisma.EmployeeGetPayload<{ select: typeof employeeForShiftSelect }>;

export async function findEmployee(
  organisationId: string,
  employeeId: string,
  db: Db = prisma,
): Promise<EmployeeForShift | null> {
  return db.employee.findFirst({
    where: { id: employeeId, organisationId, deletedAt: null },
    select: employeeForShiftSelect,
  });
}

export async function findLocation(organisationId: string, locationId: string, db: Db = prisma) {
  return db.location.findFirst({
    where: { id: locationId, organisationId, deletedAt: null },
    select: { id: true, name: true, timezone: true },
  });
}

export async function findShift(
  organisationId: string,
  shiftId: string,
  db: Db = prisma,
): Promise<ShiftRow | null> {
  return db.shift.findFirst({
    where: { id: shiftId, organisationId, deletedAt: null },
    include: shiftInclude,
  });
}

export async function findShifts(
  organisationId: string,
  shiftIds: readonly string[],
  db: Db = prisma,
): Promise<ShiftRow[]> {
  if (shiftIds.length === 0) return [];
  return db.shift.findMany({
    where: { id: { in: [...shiftIds] }, organisationId, deletedAt: null },
    include: shiftInclude,
    orderBy: { startsAt: "asc" },
  });
}

export interface ListShiftsFilter {
  /** Half-open window: shifts overlapping `[from, to)`. */
  from: Date;
  to: Date;
  employeeId?: string | undefined;
  locationId?: string | undefined;
  teamId?: string | undefined;
  statuses?: readonly ShiftStatus[] | undefined;
}

export async function listShifts(
  organisationId: string,
  filter: ListShiftsFilter,
  db: Db = prisma,
): Promise<ShiftRow[]> {
  return db.shift.findMany({
    where: {
      organisationId,
      deletedAt: null,
      startsAt: { lt: filter.to },
      endsAt: { gt: filter.from },
      ...(filter.employeeId ? { employeeId: filter.employeeId } : {}),
      ...(filter.locationId ? { locationId: filter.locationId } : {}),
      ...(filter.teamId ? { employee: { teams: { some: { teamId: filter.teamId } } } } : {}),
      ...(filter.statuses && filter.statuses.length > 0
        ? { status: { in: [...filter.statuses] } }
        : {}),
    },
    include: shiftInclude,
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
  });
}

/**
 * SCHEDULED, non-deleted shifts of `employeeIds` overlapping `[from, to)` — the set a new or moved shift
 * must not collide with.
 */
export async function listScheduledIntervals(
  organisationId: string,
  employeeIds: readonly string[],
  from: Date,
  to: Date,
  db: Db = prisma,
): Promise<Array<IntervalLike & { employeeId: string }>> {
  if (employeeIds.length === 0) return [];
  return db.shift.findMany({
    where: {
      organisationId,
      employeeId: { in: [...employeeIds] },
      status: "SCHEDULED",
      deletedAt: null,
      startsAt: { lt: to },
      endsAt: { gt: from },
    },
    select: { id: true, employeeId: true, startsAt: true, endsAt: true },
    orderBy: { startsAt: "asc" },
  });
}

/** Every row of a recurring series (anchor + occurrences), whatever their status or deletion state. */
export async function listSeriesRows(anchorId: string, db: Db = prisma) {
  return db.shift.findMany({
    where: { OR: [{ id: anchorId }, { parentRecurrenceId: anchorId }] },
    select: {
      id: true,
      organisationId: true,
      employeeId: true,
      startsAt: true,
      endsAt: true,
      status: true,
      deletedAt: true,
      parentRecurrenceId: true,
    },
    orderBy: { startsAt: "asc" },
  });
}

/** Scheduled, non-deleted members of a series starting at or after `from` (for THIS_AND_FUTURE edits). */
export async function listFutureSeriesMembers(
  organisationId: string,
  anchorId: string,
  from: Date,
  db: Db = prisma,
): Promise<ShiftRow[]> {
  return db.shift.findMany({
    where: {
      organisationId,
      deletedAt: null,
      status: "SCHEDULED",
      startsAt: { gte: from },
      OR: [{ id: anchorId }, { parentRecurrenceId: anchorId }],
    },
    include: shiftInclude,
    orderBy: { startsAt: "asc" },
  });
}

/** Series anchors (rows carrying a rule) — soft-deleted or cancelled anchors still define their series. */
export async function listRecurrenceAnchors(organisationId: string | undefined, db: Db = prisma) {
  return db.shift.findMany({
    where: {
      recurrenceRule: { not: null },
      parentRecurrenceId: null,
      ...(organisationId ? { organisationId } : {}),
    },
    include: {
      scheduledBreaks: { select: { offsetMinutesFromStart: true, durationMinutes: true } },
      employee: { select: { employmentStatus: true, deletedAt: true } },
    },
    orderBy: { createdAt: "asc" },
  });
}

export async function findActiveBreakSession(shiftId: string, db: Db = prisma) {
  return db.breakSession.findFirst({
    where: { shiftId, status: "ACTIVE" },
    orderBy: { startedAt: "desc" },
  });
}

/**
 * The break policy that applies to an employee today (§6.1 precedence: employee → team → location →
 * organisation assignment → organisation default). Null when the organisation has no break policy.
 */
export async function loadBreakPolicyFor(
  organisationId: string,
  employee: Pick<EmployeeForShift, "id" | "primaryLocationId" | "teams">,
  organisationDefaultBreakPolicyId: string | null,
  now: Date,
  db: Db = prisma,
): Promise<BreakPolicyLike | null> {
  const [assignments, policies] = await Promise.all([
    db.breakPolicyAssignment.findMany({ where: { organisationId } }),
    db.breakPolicy.findMany({ where: { organisationId } }),
  ]);
  const result = resolvePolicy({
    employee: {
      employeeId: employee.id,
      organisationId,
      teamIds: employee.teams.map((t) => t.teamId),
      primaryLocationId: employee.primaryLocationId,
    },
    assignments: assignments.map(fromBreakPolicyAssignment),
    policiesById: indexPoliciesById(policies),
    organisationDefaultPolicyId: organisationDefaultBreakPolicyId,
    now,
  });
  return result.policy ? breakPolicyFromRecord(result.policy) : null;
}

/** `SCHEDULED` shifts whose end has passed become `COMPLETED`. Returns the number of rows changed. */
export async function completeEndedShifts(now: Date, db: Db = prisma): Promise<number> {
  const result = await db.shift.updateMany({
    where: { status: "SCHEDULED", deletedAt: null, endsAt: { lte: now } },
    data: { status: "COMPLETED" },
  });
  return result.count;
}
