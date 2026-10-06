import { prisma, type Prisma } from "@workmode/db";

/** Team rows and `EmployeeTeam` memberships, scoped by the organisation id from the verified membership. */

export type Db = Prisma.TransactionClient | typeof prisma;

export const teamInclude = {
  location: { select: { id: true, name: true, deletedAt: true } },
  _count: { select: { members: { where: { employee: { deletedAt: null } } } } },
} satisfies Prisma.TeamInclude;
export type TeamRow = Prisma.TeamGetPayload<{ include: typeof teamInclude }>;

export interface TeamFilters {
  locationId?: string;
}

export async function findTeams(
  organisationId: string,
  filters: TeamFilters = {},
  db: Db = prisma,
): Promise<TeamRow[]> {
  return db.team.findMany({
    where: {
      organisationId,
      ...(filters.locationId ? { locationId: filters.locationId } : {}),
    },
    include: teamInclude,
    orderBy: [{ name: "asc" }, { createdAt: "asc" }],
  });
}

export async function findTeamInOrganisation(
  organisationId: string,
  teamId: string,
  db: Db = prisma,
): Promise<TeamRow | null> {
  return db.team.findFirst({ where: { id: teamId, organisationId }, include: teamInclude });
}

/** Ids (of `employeeIds`) that are live employees of the organisation. */
export async function findEmployeeIdsInOrganisation(
  organisationId: string,
  employeeIds: readonly string[],
  db: Db = prisma,
): Promise<Set<string>> {
  if (employeeIds.length === 0) return new Set();
  const rows = await db.employee.findMany({
    where: { organisationId, deletedAt: null, id: { in: [...employeeIds] } },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

export async function findTeamMemberIds(teamId: string, db: Db = prisma): Promise<string[]> {
  const rows = await db.employeeTeam.findMany({ where: { teamId }, select: { employeeId: true } });
  return rows.map((r) => r.employeeId);
}

/** Add memberships, ignoring employees already in the team. Returns how many were added. */
export async function addTeamMemberships(
  tx: Prisma.TransactionClient,
  teamId: string,
  employeeIds: readonly string[],
): Promise<number> {
  if (employeeIds.length === 0) return 0;
  const result = await tx.employeeTeam.createMany({
    data: employeeIds.map((employeeId) => ({ teamId, employeeId })),
    skipDuplicates: true,
  });
  return result.count;
}

/** Make `employeeIds` the whole membership. Returns the number added and removed. */
export async function replaceTeamMemberships(
  tx: Prisma.TransactionClient,
  teamId: string,
  employeeIds: readonly string[],
): Promise<{ added: number; removed: number }> {
  const removed = await tx.employeeTeam.deleteMany({
    where: { teamId, employeeId: { notIn: [...employeeIds] } },
  });
  const added = await addTeamMemberships(tx, teamId, employeeIds);
  return { added, removed: removed.count };
}

export async function removeTeamMembership(
  tx: Prisma.TransactionClient,
  teamId: string,
  employeeId: string,
): Promise<number> {
  const result = await tx.employeeTeam.deleteMany({ where: { teamId, employeeId } });
  return result.count;
}
