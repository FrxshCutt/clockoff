import { planLimitsFor } from "@workmode/shared/plans";
import type { AuditLog, AuditLogQuery, ListAuditLogsResponse } from "@workmode/validation/auditLogs";
import { decodeKeysetCursor, encodeKeysetCursor } from "@/server/notifications/cursor";
import type { ManagerContext } from "@/server/tenancy/context";
import { findAuditLogs, type AuditLogRow } from "./auditLogs.repository";

/**
 * Audit log (§5 audit logs, §13): manager actions only — who changed what, when, from where — never
 * employee behaviour. `audit:read` (OWNER / ADMIN). Cursor-paginated, newest first. Rows older than the
 * plan's `auditLogRetentionDays` are not shown (retention is enforced at read time; a purge job may
 * delete them later).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export function toAuditLogDto(row: AuditLogRow): AuditLog {
  return {
    id: row.id,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    actor: row.actorUser
      ? { id: row.actorUser.id, name: row.actorUser.name, email: row.actorUser.email }
      : null,
    before: row.before ?? null,
    after: row.after ?? null,
    ip: row.ip,
    userAgent: row.userAgent,
    occurredAt: row.occurredAt.toISOString(),
  };
}

/** Earliest instant the organisation's plan still shows. */
export function retentionFloor(plan: ManagerContext["organisation"]["plan"], now: Date): Date {
  return new Date(now.getTime() - planLimitsFor(plan).auditLogRetentionDays * DAY_MS);
}

/** `GET /api/audit-logs?cursor&limit&entityType&entityId&actorUserId&action&from&to` */
export async function listAuditLogs(
  ctx: ManagerContext,
  query: AuditLogQuery,
): Promise<ListAuditLogsResponse> {
  const now = new Date();
  const floor = retentionFloor(ctx.organisation.plan, now);
  const requestedFrom = query.from ? new Date(query.from) : null;
  const from = requestedFrom && requestedFrom.getTime() > floor.getTime() ? requestedFrom : floor;
  const rows = await findAuditLogs(
    ctx.organisation.id,
    {
      entityType: query.entityType,
      entityId: query.entityId,
      actorUserId: query.actorUserId,
      action: query.action,
      from,
      to: query.to ? new Date(query.to) : undefined,
    },
    query.cursor ? decodeKeysetCursor(query.cursor) : null,
    query.limit + 1,
  );
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toAuditLogDto),
    nextCursor:
      rows.length > query.limit && last
        ? encodeKeysetCursor({ at: last.occurredAt, id: last.id })
        : null,
  };
}
