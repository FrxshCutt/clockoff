import { prisma, type Prisma } from "@workmode/db";

/**
 * Company join code rows, always scoped by the organisation id the caller took from its verified
 * membership. At most one row per organisation is ACTIVE (partial unique index
 * `company_join_codes_one_active_per_org`); `code` is globally unique.
 */

export type Db = Prisma.TransactionClient | typeof prisma;

export const joinCodeInclude = {
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.CompanyJoinCodeInclude;
export type JoinCodeRow = Prisma.CompanyJoinCodeGetPayload<{ include: typeof joinCodeInclude }>;

/** Every code of the organisation, newest first. */
export async function findJoinCodes(
  organisationId: string,
  db: Db = prisma,
): Promise<JoinCodeRow[]> {
  return db.companyJoinCode.findMany({
    where: { organisationId },
    include: joinCodeInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

export async function findActiveJoinCode(
  organisationId: string,
  db: Db = prisma,
): Promise<JoinCodeRow | null> {
  return db.companyJoinCode.findFirst({
    where: { organisationId, status: "ACTIVE" },
    include: joinCodeInclude,
  });
}

/**
 * `SELECT … FOR UPDATE` on the organisation row inside a transaction so concurrent code regenerations,
 * revocations and plan-limited creations for one organisation serialise. Returns false when the row does
 * not exist.
 */
export async function lockOrganisationRow(
  tx: Prisma.TransactionClient,
  organisationId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM organisations WHERE id = ${organisationId}::uuid FOR UPDATE`;
  return rows.length > 0;
}

export async function revokeActiveJoinCodes(
  organisationId: string,
  now: Date,
  db: Db = prisma,
): Promise<number> {
  const result = await db.companyJoinCode.updateMany({
    where: { organisationId, status: "ACTIVE" },
    data: { status: "REVOKED", revokedAt: now },
  });
  return result.count;
}

export async function createActiveJoinCode(
  organisationId: string,
  code: string,
  createdById: string,
  db: Db = prisma,
): Promise<JoinCodeRow> {
  return db.companyJoinCode.create({
    data: { organisationId, code, status: "ACTIVE", createdById },
    include: joinCodeInclude,
  });
}
