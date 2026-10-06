import { prisma, type Prisma } from "@workmode/db";

/** Employee-invite queries, always scoped by `organisationId` (from the verified membership). */

export type Db = Prisma.TransactionClient | typeof prisma;

export const inviteInclude = {
  employee: {
    select: {
      id: true,
      organisationId: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      employmentStatus: true,
      inviteStatus: true,
      deletedAt: true,
      primaryLocation: { select: { id: true, name: true, timezone: true } },
      userLink: { select: { unlinkedAt: true } },
    },
  },
} satisfies Prisma.EmployeeInviteInclude;

export type InviteRow = Prisma.EmployeeInviteGetPayload<{ include: typeof inviteInclude }>;

export async function findInviteInOrganisation(
  organisationId: string,
  inviteId: string,
  db: Db = prisma,
): Promise<InviteRow | null> {
  return db.employeeInvite.findFirst({
    where: { id: inviteId, organisationId },
    include: inviteInclude,
  });
}

export async function findInviteByIdInOrganisation(
  organisationId: string,
  inviteId: string,
  db: Db = prisma,
) {
  return db.employeeInvite.findFirst({ where: { id: inviteId, organisationId } });
}

/** Mark every PENDING / SENT invite of the employee REVOKED (a new invite supersedes them). */
export async function revokeLiveInvitesForEmployee(
  tx: Prisma.TransactionClient,
  organisationId: string,
  employeeId: string,
  now: Date,
): Promise<number> {
  const result = await tx.employeeInvite.updateMany({
    where: { organisationId, employeeId, status: { in: ["PENDING", "SENT"] } },
    data: { status: "REVOKED", revokedAt: now },
  });
  return result.count;
}

export async function inviteCodeExists(code: string, db: Db = prisma): Promise<boolean> {
  const row = await db.employeeInvite.findUnique({ where: { code }, select: { id: true } });
  return row !== null;
}

/** A live invite (PENDING / SENT, unexpired) by code inside one organisation — the join-flow lookup. */
export async function findLiveInviteByCode(
  organisationId: string,
  code: string,
  now: Date,
  db: Db = prisma,
): Promise<InviteRow | null> {
  return db.employeeInvite.findFirst({
    where: {
      organisationId,
      code,
      status: { in: ["PENDING", "SENT"] },
      expiresAt: { gt: now },
    },
    include: inviteInclude,
  });
}
