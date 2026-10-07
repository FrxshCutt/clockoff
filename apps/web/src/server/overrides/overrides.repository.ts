import { prisma, type Prisma } from "@clockoff/db";
import type { OverrideStatus } from "@clockoff/validation/overrides";
import { overrideInclude, type OverrideRow } from "@/server/employees/employees.repository";

/** Organisation-scoped manager-override reads/writes. `organisationId` always comes from the verified context. */

type Db = Prisma.TransactionClient | typeof prisma;

export { overrideInclude };
export type { OverrideRow };

export async function findOverrideInOrganisation(
  organisationId: string,
  id: string,
  db: Db = prisma,
): Promise<OverrideRow | null> {
  return db.managerOverride.findFirst({ where: { id, organisationId }, include: overrideInclude });
}

export interface OverrideListFilter {
  employeeId?: string;
  types?: readonly OverrideRow["type"][];
  statuses?: readonly OverrideStatus[];
  /** Exclusive keyset cursor: rows strictly older than (createdAt, id). */
  after?: { createdAt: Date; id: string };
}

/** `OverrideStatus` → row predicate at `now` (see `deriveOverrideStatus`). */
export function overrideStatusWhere(
  status: OverrideStatus,
  now: Date,
): Prisma.ManagerOverrideWhereInput {
  switch (status) {
    case "REVOKED":
      return { revokedAt: { not: null } };
    case "EXPIRED":
      return { revokedAt: null, expiresAt: { lte: now } };
    case "ACTIVE":
      return { revokedAt: null, startsAt: { lte: now }, expiresAt: { gt: now } };
    case "SCHEDULED":
      return { revokedAt: null, startsAt: { gt: now } };
    default: {
      const exhaustive: never = status;
      throw new Error(`Unhandled override status ${String(exhaustive)}`);
    }
  }
}

/** Newest first (`createdAt` desc, `id` desc). */
export async function findOverrides(
  organisationId: string,
  filter: OverrideListFilter,
  now: Date,
  limit: number,
  db: Db = prisma,
): Promise<OverrideRow[]> {
  const and: Prisma.ManagerOverrideWhereInput[] = [];
  if (filter.employeeId) and.push({ employeeId: filter.employeeId });
  if (filter.types && filter.types.length > 0) and.push({ type: { in: [...filter.types] } });
  if (filter.statuses && filter.statuses.length > 0) {
    and.push({ OR: filter.statuses.map((status) => overrideStatusWhere(status, now)) });
  }
  if (filter.after) {
    and.push({
      OR: [
        { createdAt: { lt: filter.after.createdAt } },
        { createdAt: filter.after.createdAt, id: { lt: filter.after.id } },
      ],
    });
  }
  return db.managerOverride.findMany({
    where: { organisationId, ...(and.length > 0 ? { AND: and } : {}) },
    include: overrideInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
  });
}

export async function findActiveEmployee(
  organisationId: string,
  employeeId: string,
  db: Db = prisma,
) {
  return db.employee.findFirst({
    where: { id: employeeId, organisationId, deletedAt: null },
    select: { id: true, employmentStatus: true, firstName: true, lastName: true },
  });
}

export async function findBreakPolicyInOrganisation(
  organisationId: string,
  id: string,
  db: Db = prisma,
) {
  return db.breakPolicy.findFirst({
    where: { id, organisationId, deletedAt: null },
    select: { id: true, restrictionBehaviour: true, relaxedCategories: true },
  });
}

/** The employee's SCHEDULED shift in progress at `now`, if any (END_WORK_MODE_EARLY default expiry). */
export async function findShiftInProgress(
  organisationId: string,
  employeeId: string,
  now: Date,
  db: Db = prisma,
) {
  return db.shift.findFirst({
    where: {
      organisationId,
      employeeId,
      status: "SCHEDULED",
      deletedAt: null,
      startsAt: { lte: now },
      endsAt: { gt: now },
    },
    select: { id: true, endsAt: true },
    orderBy: [{ endsAt: "desc" }],
  });
}

export async function createOverrideRow(
  data: Prisma.ManagerOverrideUncheckedCreateInput,
  db: Db = prisma,
): Promise<OverrideRow> {
  return db.managerOverride.create({ data, include: overrideInclude });
}

/** Guarded revoke: only a row that is not yet revoked is updated. Returns whether THIS call revoked it. */
export async function revokeOverrideRow(
  organisationId: string,
  id: string,
  revokedAt: Date,
  db: Db = prisma,
): Promise<boolean> {
  const result = await db.managerOverride.updateMany({
    where: { id, organisationId, revokedAt: null },
    data: { revokedAt },
  });
  return result.count === 1;
}
