import { prisma, type Prisma } from "@workmode/db";
import { beforeCursorWhere, type KeysetCursor } from "@/server/notifications/cursor";

/** Audit log rows with the acting manager joined, scoped by the verified organisation id. */

export type Db = Prisma.TransactionClient | typeof prisma;

export const auditLogInclude = {
  actorUser: { select: { id: true, name: true, email: true } },
} satisfies Prisma.AuditLogInclude;
export type AuditLogRow = Prisma.AuditLogGetPayload<{ include: typeof auditLogInclude }>;

export interface AuditLogFilters {
  entityType?: string;
  entityId?: string;
  actorUserId?: string;
  action?: string;
  /** Inclusive lower bound on `occurredAt`. */
  from?: Date;
  /** Exclusive upper bound on `occurredAt`. */
  to?: Date;
}

export async function findAuditLogs(
  organisationId: string,
  filters: AuditLogFilters,
  cursor: KeysetCursor | null,
  take: number,
  db: Db = prisma,
): Promise<AuditLogRow[]> {
  const occurredAt: Prisma.DateTimeFilter = {};
  if (filters.from) occurredAt.gte = filters.from;
  if (filters.to) occurredAt.lt = filters.to;
  return db.auditLog.findMany({
    where: {
      organisationId,
      ...(filters.entityType ? { entityType: filters.entityType } : {}),
      ...(filters.entityId ? { entityId: filters.entityId } : {}),
      ...(filters.actorUserId ? { actorUserId: filters.actorUserId } : {}),
      ...(filters.action ? { action: filters.action } : {}),
      ...(filters.from || filters.to ? { occurredAt } : {}),
      ...(cursor ? beforeCursorWhere("occurredAt", cursor) : {}),
    },
    include: auditLogInclude,
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take,
  });
}
