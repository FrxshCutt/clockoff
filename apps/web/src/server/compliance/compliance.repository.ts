import { prisma, type Prisma } from "@clockoff/db";

/** Organisation-scoped reads for the compliance dashboard. `organisationId` always comes from `ctx`. */

type Db = Prisma.TransactionClient | typeof prisma;

export interface ComplianceEmployeeFilter {
  locationId?: string;
  teamId?: string;
  search?: string;
}

/** Ids of ACTIVE (not archived, not deactivated) employees, ordered by last name, first name. */
export async function findActiveEmployeeIds(
  organisationId: string,
  filter: ComplianceEmployeeFilter,
  db: Db = prisma,
): Promise<string[]> {
  const search = filter.search?.trim();
  const rows = await db.employee.findMany({
    where: {
      organisationId,
      deletedAt: null,
      employmentStatus: "ACTIVE",
      ...(filter.locationId ? { primaryLocationId: filter.locationId } : {}),
      ...(filter.teamId ? { teams: { some: { teamId: filter.teamId } } } : {}),
      ...(search
        ? {
            OR: [
              { firstName: { contains: search, mode: "insensitive" } },
              { lastName: { contains: search, mode: "insensitive" } },
              { jobTitle: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    select: { id: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
  });
  return rows.map((r) => r.id);
}

export const upcomingShiftInclude = {
  location: { select: { id: true, name: true } },
  employee: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      jobTitle: true,
      inviteStatus: true,
      primaryLocation: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.ShiftInclude;
export type UpcomingShiftRow = Prisma.ShiftGetPayload<{ include: typeof upcomingShiftInclude }>;

/** SCHEDULED shifts of active employees starting in `(from, to]`, soonest first. */
export async function findUpcomingShifts(
  organisationId: string,
  from: Date,
  to: Date,
  limit: number,
  db: Db = prisma,
): Promise<UpcomingShiftRow[]> {
  return db.shift.findMany({
    where: {
      organisationId,
      status: "SCHEDULED",
      deletedAt: null,
      startsAt: { gt: from, lte: to },
      employee: { deletedAt: null, employmentStatus: "ACTIVE" },
    },
    include: upcomingShiftInclude,
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    take: limit,
  });
}

export async function findIntegrationStatuses(organisationId: string, db: Db = prisma) {
  return db.integration.findMany({
    where: { organisationId },
    include: { connection: { select: { lastSyncAt: true, lastError: true } } },
    orderBy: [{ provider: "asc" }],
  });
}
