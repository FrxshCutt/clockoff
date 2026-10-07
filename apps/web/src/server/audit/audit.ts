import { prisma, type AuditLog, type Prisma } from "@clockoff/db";

/**
 * Audit trail for manager-initiated changes (§13). `before` / `after` are JSON snapshots the caller
 * chooses — pass domain objects, not whole Prisma rows with secrets.
 */

/** Anything with an organisation and (optionally) an acting user — `ManagerContext` satisfies this. */
export interface AuditActor {
  organisation: { id: string };
  user?: { id: string } | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditEntry {
  /** Dotted verb, e.g. `organisation.updated`, `member.role_changed`. */
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  occurredAt?: Date;
}

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * JSON-serialise arbitrary data for a `Json?` column (drops `undefined` members, converts Dates to ISO
 * strings). Returns `undefined` — stored as SQL NULL — for `undefined`, `null` or values that do not
 * serialise (Prisma rejects a bare `null` for nullable JSON columns).
 */
export function toJsonValue(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  const serialised = JSON.stringify(value);
  if (serialised === undefined) return undefined;
  const parsed = JSON.parse(serialised) as Prisma.InputJsonValue | null;
  return parsed === null ? undefined : parsed;
}

export async function audit(
  ctx: AuditActor,
  entry: AuditEntry,
  db: Db = prisma,
): Promise<AuditLog> {
  const before = toJsonValue(entry.before);
  const after = toJsonValue(entry.after);
  return db.auditLog.create({
    data: {
      organisationId: ctx.organisation.id,
      actorUserId: ctx.user?.id ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      ...(entry.occurredAt ? { occurredAt: entry.occurredAt } : {}),
    },
  });
}
