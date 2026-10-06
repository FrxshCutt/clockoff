import { z } from "zod";
import {
  cursorPaginationQuerySchema,
  isoDateTimeSchema,
  paginatedResponseSchema,
  uuidSchema,
} from "./common";
import { instantSchema } from "./primitives";
import { actorRefSchema } from "./refs";

/**
 * Audit log (§5 audit logs): manager actions only — who changed a policy, who created an override — never
 * employee behaviour. Requires `audit:read`. Cursor-paginated, newest first.
 */

/** `GET /api/audit-logs` */
export const auditLogQuerySchema = cursorPaginationQuerySchema
  .extend({
    /** e.g. `policy`, `employee`, `shift`, `override`. */
    entityType: z.string().trim().min(1).max(64).optional(),
    entityId: z.string().trim().min(1).max(64).optional(),
    actorUserId: uuidSchema.optional(),
    /** e.g. `policy.published`. */
    action: z.string().trim().min(1).max(100).optional(),
    from: isoDateTimeSchema.optional(),
    to: isoDateTimeSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.from !== undefined && v.to !== undefined && Date.parse(v.to) <= Date.parse(v.from)) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "to must be after from" });
    }
  });
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

export const auditLogSchema = z
  .object({
    id: uuidSchema,
    action: z.string(),
    entityType: z.string(),
    entityId: z.string().nullable(),
    /** Null for system actions or a deleted user. */
    actor: actorRefSchema.nullable(),
    /** Snapshot before / after the change (secrets and tokens are never recorded). */
    before: z.unknown().nullable(),
    after: z.unknown().nullable(),
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
    occurredAt: instantSchema,
  })
  .meta({ id: "AuditLog" });
export type AuditLog = z.infer<typeof auditLogSchema>;

export const listAuditLogsResponseSchema = paginatedResponseSchema(auditLogSchema).meta({
  id: "ListAuditLogsResponse",
});
export type ListAuditLogsResponse = z.infer<typeof listAuditLogsResponseSchema>;
