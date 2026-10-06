import { z } from "zod";
import {
  cursorPaginationQuerySchema,
  isoDateTimeSchema,
  paginatedResponseSchema,
  uuidSchema,
} from "./common";
import { activityEventTypeSchema, actorTypeSchema } from "./enumSchemas";
import { instantSchema, jsonObjectSchema, queryListSchema } from "./primitives";
import { actorRefSchema, employeeSummarySchema } from "./refs";

/**
 * Activity feed (§5 `GET /api/activity`). Events are operational facts (joined, permission granted, break
 * started, policy synced, ...) — never device content (§12). Cursor-paginated, newest first.
 */

function validateRange(
  value: { from?: string | undefined; to?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (
    value.from !== undefined &&
    value.to !== undefined &&
    Date.parse(value.to) <= Date.parse(value.from)
  ) {
    ctx.addIssue({ code: "custom", path: ["to"], message: "to must be after from" });
  }
}

const activityFilterShape = {
  type: queryListSchema(activityEventTypeSchema).optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
  locationId: uuidSchema.optional(),
};

/** `GET /api/activity` */
export const activityQuerySchema = cursorPaginationQuerySchema
  .extend({ employeeId: uuidSchema.optional(), ...activityFilterShape })
  .superRefine(validateRange);
export type ActivityQuery = z.infer<typeof activityQuerySchema>;

/** `GET /api/employees/:id/activity` — the employee comes from the path. */
export const employeeActivityQuerySchema = cursorPaginationQuerySchema
  .extend({
    type: activityFilterShape.type,
    from: activityFilterShape.from,
    to: activityFilterShape.to,
  })
  .superRefine(validateRange);
export type EmployeeActivityQuery = z.infer<typeof employeeActivityQuerySchema>;

export const activityEventSchema = z
  .object({
    id: uuidSchema,
    type: activityEventTypeSchema,
    occurredAt: instantSchema,
    actorType: actorTypeSchema,
    /** The manager who acted (actorType MANAGER), else null. */
    actor: actorRefSchema.nullable(),
    /** Null for organisation-level events (e.g. INTEGRATION_ERROR, IMPORT_COMPLETED). */
    employee: employeeSummarySchema.nullable(),
    deviceId: uuidSchema.nullable(),
    /** Plain-English one-liner for the feed, e.g. "Jane Smith started a 15 minute break". */
    summary: z.string(),
    /** Operational metadata only (shiftId, breakSessionId, policyVersion, ...). */
    metadata: jsonObjectSchema,
  })
  .meta({ id: "ActivityEvent" });
export type ActivityEvent = z.infer<typeof activityEventSchema>;

export const listActivityResponseSchema = paginatedResponseSchema(activityEventSchema).meta({
  id: "ListActivityResponse",
});
export type ListActivityResponse = z.infer<typeof listActivityResponseSchema>;
