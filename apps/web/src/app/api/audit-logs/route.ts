import { auditLogQuerySchema } from "@clockoff/validation/auditLogs";
import { listAuditLogs } from "@/server/auditLogs";
import { createHandler } from "@/server/http/apiHandler";

/** `GET /api/audit-logs?cursor&limit&entityType&entityId&actorUserId&action&from&to` (audit:read) → `listAuditLogsResponseSchema`. */
export const GET = createHandler(
  { auth: "manager", permission: "audit:read", query: auditLogQuerySchema },
  async ({ ctx, query }) => listAuditLogs(ctx, query),
);
