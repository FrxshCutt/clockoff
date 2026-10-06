import { z } from "zod";
import { isoDateTimeSchema, timezoneSchema, uuidSchema } from "./common";
import { BREAK_POLICY_LIMITS } from "./breakPolicies";
import { apiErrorCodeSchema, shiftSourceSchema, shiftStatusSchema } from "./enumSchemas";
import {
  emptyBodySchema,
  instantSchema,
  localDateSchema,
  localTimeSchema,
  patchStringSchema,
  queryListSchema,
  uuidListSchema,
} from "./primitives";
import { employeeSummarySchema, namedRefSchema } from "./refs";

export const SHIFT_LIMITS = {
  minDurationMinutes: 15,
  maxDurationMinutes: 24 * 60,
  maxScheduledBreaks: 10,
  maxRecurrenceOccurrences: 366,
  maxQueryRangeDays: 93,
  bulkMaxShifts: 500,
} as const;

// ── Scheduled breaks & recurrence ───────────────────────────────────────────

export const scheduledBreakInputSchema = z
  .object({
    offsetMinutesFromStart: z.int().min(0).max(SHIFT_LIMITS.maxDurationMinutes),
    durationMinutes: z.int().min(1).max(BREAK_POLICY_LIMITS.maxBreakDurationMinutes),
  })
  .strict()
  .meta({ id: "ScheduledBreakInput" });
export type ScheduledBreakInput = z.infer<typeof scheduledBreakInputSchema>;

export const scheduledBreakSchema = z
  .object({
    id: uuidSchema,
    offsetMinutesFromStart: z.int().min(0),
    durationMinutes: z.int().min(1),
  })
  .meta({ id: "ScheduledBreak" });
export type ScheduledBreak = z.infer<typeof scheduledBreakSchema>;

/**
 * RFC 5545 RRULE body, e.g. `FREQ=WEEKLY;BYDAY=MO,TU,WE`. The end is given separately via `until`.
 * Structural check only (kept free of the timezone library so web forms stay light); the handler runs
 * `validateRecurrenceRule` from @workmode/shared/time/recurrence and answers INVALID_RECURRENCE for rules
 * that parse here but cannot occur (e.g. `BYMONTH=2;BYMONTHDAY=31`).
 */
export const rruleSchema = z
  .string()
  .trim()
  .max(500)
  .regex(
    /^(RRULE:)?FREQ=(DAILY|WEEKLY|MONTHLY)(;[A-Z]+=[A-Za-z0-9,+-]+)*$/,
    "Invalid recurrence rule",
  )
  .refine(
    (rule) => !/(^|[:;])(UNTIL|COUNT)=/i.test(rule),
    "Set the end date with `until`, not UNTIL/COUNT",
  )
  .meta({
    description:
      "RFC 5545 RRULE (FREQ=DAILY|WEEKLY|MONTHLY ...). End with `until`, not UNTIL/COUNT.",
  });

export const shiftRecurrenceSchema = z
  .object({
    rule: rruleSchema,
    /** Last calendar date (inclusive) on which an occurrence may start. */
    until: localDateSchema,
  })
  .strict()
  .meta({ id: "ShiftRecurrence" });
export type ShiftRecurrence = z.infer<typeof shiftRecurrenceSchema>;

// ── Create ──────────────────────────────────────────────────────────────────

const shiftCommonShape = {
  employeeId: uuidSchema,
  locationId: uuidSchema.optional(),
  /** Defaults to the location's timezone, then the organisation's. */
  timezone: timezoneSchema.optional(),
  notes: z.string().trim().max(1000).optional(),
  scheduledBreaks: z
    .array(scheduledBreakInputSchema)
    .max(SHIFT_LIMITS.maxScheduledBreaks)
    .optional(),
  recurrence: shiftRecurrenceSchema.optional(),
};

/** Local wall-clock form. `endTime <= startTime` means the shift ends the next day (overnight). */
export const createShiftByLocalTimeSchema = z
  .object({
    ...shiftCommonShape,
    date: localDateSchema,
    startTime: localTimeSchema,
    endTime: localTimeSchema,
  })
  .strict()
  .refine((v) => v.startTime !== v.endTime, {
    path: ["endTime"],
    message: "endTime must differ from startTime",
  })
  .meta({ id: "CreateShiftByLocalTime" });
export type CreateShiftByLocalTimeInput = z.infer<typeof createShiftByLocalTimeSchema>;

/** Instant form (ISO-8601 with offsets). */
export const createShiftByInstantSchema = z
  .object({
    ...shiftCommonShape,
    startsAt: isoDateTimeSchema,
    endsAt: isoDateTimeSchema,
  })
  .strict()
  .refine((v) => Date.parse(v.endsAt) > Date.parse(v.startsAt), {
    path: ["endsAt"],
    message: "endsAt must be after startsAt",
  })
  .meta({ id: "CreateShiftByInstant" });
export type CreateShiftByInstantInput = z.infer<typeof createShiftByInstantSchema>;

/** `POST /api/shifts` — either the local-time form or the instant form. */
export const createShiftSchema = z
  .union([createShiftByLocalTimeSchema, createShiftByInstantSchema])
  .meta({ id: "CreateShiftInput" });
export type CreateShiftInput = z.infer<typeof createShiftSchema>;

export function isInstantShiftInput(input: CreateShiftInput): input is CreateShiftByInstantInput {
  return "startsAt" in input;
}

// ── Update / actions ────────────────────────────────────────────────────────

/** `PATCH /api/shifts/:id` — any subset; local-time and instant fields cannot be mixed. */
export const updateShiftSchema = z
  .object({
    locationId: uuidSchema.nullable().optional(),
    date: localDateSchema.optional(),
    startTime: localTimeSchema.optional(),
    endTime: localTimeSchema.optional(),
    startsAt: isoDateTimeSchema.optional(),
    endsAt: isoDateTimeSchema.optional(),
    timezone: timezoneSchema.optional(),
    notes: patchStringSchema(1000),
    /** Replaces all scheduled breaks when present. */
    scheduledBreaks: z
      .array(scheduledBreakInputSchema)
      .max(SHIFT_LIMITS.maxScheduledBreaks)
      .optional(),
    /** Optimistic concurrency: the `version` the client last saw. CONFLICT when it moved on. */
    expectedVersion: z.int().min(1).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const hasLocal = v.date !== undefined || v.startTime !== undefined || v.endTime !== undefined;
    const hasInstant = v.startsAt !== undefined || v.endsAt !== undefined;
    if (hasLocal && hasInstant) {
      ctx.addIssue({
        code: "custom",
        message: "Use either date/startTime/endTime or startsAt/endsAt, not both",
      });
    }
    if (
      v.startsAt !== undefined &&
      v.endsAt !== undefined &&
      Date.parse(v.endsAt) <= Date.parse(v.startsAt)
    ) {
      ctx.addIssue({ code: "custom", path: ["endsAt"], message: "endsAt must be after startsAt" });
    }
  });
export type UpdateShiftInput = z.infer<typeof updateShiftSchema>;

/** `POST /api/shifts/:id/duplicate` — same times/breaks on another date. */
export const duplicateShiftSchema = z.object({ date: localDateSchema }).strict();
export type DuplicateShiftInput = z.infer<typeof duplicateShiftSchema>;

/** `POST /api/shifts/:id/cancel` */
export const cancelShiftSchema = z
  .object({ reason: z.string().trim().max(500).optional() })
  .strict();
export type CancelShiftInput = z.infer<typeof cancelShiftSchema>;

// ── Queries ─────────────────────────────────────────────────────────────────

/** `GET /api/shifts?from&to...` — `from`/`to` are instants; the range may not exceed `maxQueryRangeDays`. */
export const shiftQuerySchema = z
  .object({
    from: isoDateTimeSchema,
    to: isoDateTimeSchema,
    employeeId: uuidSchema.optional(),
    locationId: uuidSchema.optional(),
    teamId: uuidSchema.optional(),
    status: queryListSchema(shiftStatusSchema).optional(),
  })
  .superRefine((v, ctx) => {
    const from = Date.parse(v.from);
    const to = Date.parse(v.to);
    if (to <= from) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "to must be after from" });
    } else if (to - from > SHIFT_LIMITS.maxQueryRangeDays * 86_400_000) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: `Range may not exceed ${SHIFT_LIMITS.maxQueryRangeDays} days`,
      });
    }
  });
export type ShiftQuery = z.infer<typeof shiftQuerySchema>;

/** `GET /api/employees/:id/shifts` */
export const employeeShiftsQuerySchema = z.object({
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
  status: queryListSchema(shiftStatusSchema).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type EmployeeShiftsQuery = z.infer<typeof employeeShiftsQuerySchema>;

// ── Responses ───────────────────────────────────────────────────────────────

export const shiftSchema = z
  .object({
    id: uuidSchema,
    employee: employeeSummarySchema,
    location: namedRefSchema.nullable(),
    startsAt: instantSchema,
    endsAt: instantSchema,
    timezone: z.string(),
    durationMinutes: z.int().min(0),
    status: shiftStatusSchema,
    source: shiftSourceSchema,
    externalShiftId: z.string().nullable(),
    notes: z.string().nullable(),
    recurrenceRule: z.string().nullable(),
    parentRecurrenceId: uuidSchema.nullable(),
    version: z.int().min(1),
    scheduledBreaks: z.array(scheduledBreakSchema),
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .meta({ id: "Shift" });
export type Shift = z.infer<typeof shiftSchema>;

export const listShiftsResponseSchema = z
  .object({ shifts: z.array(shiftSchema) })
  .meta({ id: "ListShiftsResponse" });
export type ListShiftsResponse = z.infer<typeof listShiftsResponseSchema>;

export const shiftResponseSchema = z.object({ shift: shiftSchema }).meta({ id: "ShiftResponse" });
export type ShiftResponse = z.infer<typeof shiftResponseSchema>;

/** `POST /api/shifts` — with a recurrence several shifts are created; the first is the anchor. */
export const createShiftResponseSchema = z
  .object({ shifts: z.array(shiftSchema).min(1) })
  .meta({ id: "CreateShiftResponse" });
export type CreateShiftResponse = z.infer<typeof createShiftResponseSchema>;

// ── Bulk ────────────────────────────────────────────────────────────────────

export const SHIFT_BULK_ACTIONS = ["MOVE", "REPEAT", "CANCEL", "DELETE"] as const;
export type ShiftBulkAction = (typeof SHIFT_BULK_ACTIONS)[number];
export const shiftBulkActionSchema = z.enum(SHIFT_BULK_ACTIONS).meta({ id: "ShiftBulkAction" });

const shiftIdsSchema = uuidListSchema({ min: 1, max: SHIFT_LIMITS.bulkMaxShifts });

/** `POST /api/shifts/bulk` */
export const bulkShiftActionSchema = z
  .discriminatedUnion("action", [
    z
      .object({
        action: z.literal("MOVE"),
        shiftIds: shiftIdsSchema,
        payload: z
          .object({
            deltaDays: z.int().min(-366).max(366),
            deltaMinutes: z.int().min(-1440).max(1440).default(0),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        action: z.literal("REPEAT"),
        shiftIds: shiftIdsSchema,
        /** Copies each shift to the following N weeks (same weekday and times). */
        payload: z.object({ weeks: z.int().min(1).max(12) }).strict(),
      })
      .strict(),
    z
      .object({
        action: z.literal("CANCEL"),
        shiftIds: shiftIdsSchema,
        payload: z
          .object({ reason: z.string().trim().max(500).optional() })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal("DELETE"),
        shiftIds: shiftIdsSchema,
        payload: emptyBodySchema.optional(),
      })
      .strict(),
  ])
  .meta({ id: "BulkShiftActionInput" });
export type BulkShiftActionInput = z.infer<typeof bulkShiftActionSchema>;

export const bulkShiftActionResponseSchema = z
  .object({
    action: shiftBulkActionSchema,
    processed: z.int().min(0),
    succeeded: z.int().min(0),
    failed: z.array(
      z.object({ shiftId: uuidSchema, code: apiErrorCodeSchema, message: z.string() }),
    ),
    /** Shifts created or updated by the action. */
    shifts: z.array(shiftSchema),
  })
  .meta({ id: "BulkShiftActionResponse" });
export type BulkShiftActionResponse = z.infer<typeof bulkShiftActionResponseSchema>;
