import { prisma, type Prisma } from "@workmode/db";
import { endAssignmentsForScope, type EndedScopeAssignments } from "./scopeAssignments";

/**
 * Location rows (soft-deleted ones are invisible everywhere). Every function takes the organisation id
 * explicitly; it always comes from the caller's verified membership.
 */

export type Db = Prisma.TransactionClient | typeof prisma;

export const locationInclude = {
  _count: { select: { teams: true } },
} satisfies Prisma.LocationInclude;
export type LocationRow = Prisma.LocationGetPayload<{ include: typeof locationInclude }>;

export async function findLocations(
  organisationId: string,
  db: Db = prisma,
): Promise<LocationRow[]> {
  return db.location.findMany({
    where: { organisationId, deletedAt: null },
    include: locationInclude,
    orderBy: [{ name: "asc" }, { createdAt: "asc" }],
  });
}

export async function findLocationInOrganisation(
  organisationId: string,
  locationId: string,
  db: Db = prisma,
): Promise<LocationRow | null> {
  return db.location.findFirst({
    where: { id: locationId, organisationId, deletedAt: null },
    include: locationInclude,
  });
}

export async function countLocations(organisationId: string, db: Db = prisma): Promise<number> {
  return db.location.count({ where: { organisationId, deletedAt: null } });
}

/** Case-insensitive name match among the organisation's live locations (optionally ignoring one row). */
export async function findLocationByName(
  organisationId: string,
  name: string,
  options: { excludeId?: string; db?: Db } = {},
): Promise<{ id: string } | null> {
  const db = options.db ?? prisma;
  return db.location.findFirst({
    where: {
      organisationId,
      deletedAt: null,
      name: { equals: name, mode: "insensitive" },
      ...(options.excludeId ? { id: { not: options.excludeId } } : {}),
    },
    select: { id: true },
  });
}

/**
 * Distinct non-archived employees per location, counting both the primary location and additional
 * `EmployeeLocation` links. One query for the whole organisation.
 */
export async function countEmployeesByLocation(
  organisationId: string,
  db: Db = prisma,
): Promise<Map<string, number>> {
  const rows = await db.$queryRaw<Array<{ location_id: string; count: number }>>`
    SELECT x.location_id, COUNT(DISTINCT x.employee_id)::int AS count
    FROM (
      SELECT e.primary_location_id AS location_id, e.id AS employee_id
      FROM employees e
      WHERE e.organisation_id = ${organisationId}::uuid
        AND e.deleted_at IS NULL
        AND e.primary_location_id IS NOT NULL
      UNION
      SELECT el.location_id, el.employee_id
      FROM employee_locations el
      JOIN employees e ON e.id = el.employee_id
      WHERE e.organisation_id = ${organisationId}::uuid
        AND e.deleted_at IS NULL
    ) x
    GROUP BY x.location_id`;
  return new Map(rows.map((r) => [r.location_id, Number(r.count)]));
}

/** SCHEDULED shifts at the location that have not finished yet (in progress or upcoming). */
export async function countUpcomingShiftsForLocation(
  organisationId: string,
  locationId: string,
  now: Date,
  db: Db = prisma,
): Promise<number> {
  return db.shift.count({
    where: {
      organisationId,
      locationId,
      deletedAt: null,
      status: "SCHEDULED",
      endsAt: { gt: now },
    },
  });
}

export interface SoftDeleteLocationResult extends EndedScopeAssignments {
  employeesDetached: number;
  employeeLinksRemoved: number;
  teamsDetached: number;
  shiftsDetached: number;
  /** Non-archived employees who worked at the location (primary or additional), for realtime hints. */
  affectedEmployeeIds: string[];
}

/**
 * Soft-delete a location and apply SetNull semantics to everything that pointed at it: employees'
 * primary location, additional location links, teams and (past / cancelled) shifts. Open policy
 * assignments to the location are ended so nothing resolves through a deleted scope.
 */
export async function softDeleteLocation(
  tx: Prisma.TransactionClient,
  organisationId: string,
  locationId: string,
  now: Date,
): Promise<SoftDeleteLocationResult> {
  const affected = await tx.employee.findMany({
    where: {
      organisationId,
      deletedAt: null,
      OR: [{ primaryLocationId: locationId }, { locations: { some: { locationId } } }],
    },
    select: { id: true },
  });
  const employees = await tx.employee.updateMany({
    where: { organisationId, primaryLocationId: locationId },
    data: { primaryLocationId: null },
  });
  const links = await tx.employeeLocation.deleteMany({
    where: { locationId, employee: { organisationId } },
  });
  const teams = await tx.team.updateMany({
    where: { organisationId, locationId },
    data: { locationId: null },
  });
  const shifts = await tx.shift.updateMany({
    where: { organisationId, locationId },
    data: { locationId: null },
  });
  const ended = await endAssignmentsForScope(tx, organisationId, "LOCATION", locationId, now);
  await tx.location.update({ where: { id: locationId }, data: { deletedAt: now } });
  return {
    employeesDetached: employees.count,
    employeeLinksRemoved: links.count,
    teamsDetached: teams.count,
    shiftsDetached: shifts.count,
    affectedEmployeeIds: affected.map((e) => e.id),
    ...ended,
  };
}
