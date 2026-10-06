import { prisma, type Prisma } from "@workmode/db";

/** Queries for the join / mobile auth lifecycle. The organisation is always derived from a verified row. */

export type Db = Prisma.TransactionClient | typeof prisma;

export const joinCodeInclude = { organisation: true } satisfies Prisma.CompanyJoinCodeInclude;
export type ActiveJoinCodeRow = Prisma.CompanyJoinCodeGetPayload<{
  include: typeof joinCodeInclude;
}>;

/** The ACTIVE company join code for a canonical `WORD-####` code, with its (live) organisation. */
export async function findActiveJoinCode(
  code: string,
  db: Db = prisma,
): Promise<ActiveJoinCodeRow | null> {
  return db.companyJoinCode.findFirst({
    where: { code, status: "ACTIVE", organisation: { deletedAt: null } },
    include: joinCodeInclude,
  });
}

/** Deactivate every other active device of the employee (one phone per person) and revoke its tokens. */
export async function retireOtherDevices(
  tx: Prisma.TransactionClient,
  organisationId: string,
  employeeId: string,
  now: Date,
): Promise<number> {
  await tx.refreshToken.updateMany({
    where: { device: { organisationId, employeeId, isActive: true }, revokedAt: null },
    data: { revokedAt: now },
  });
  const result = await tx.device.updateMany({
    where: { organisationId, employeeId, isActive: true },
    data: { isActive: false, deactivatedAt: now, pushTokenEncrypted: null },
  });
  return result.count;
}

export async function findRefreshTokenByHash(tokenHash: string, db: Db = prisma) {
  return db.refreshToken.findUnique({ where: { tokenHash } });
}
