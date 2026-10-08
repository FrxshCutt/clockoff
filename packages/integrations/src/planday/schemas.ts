import { z } from "zod";
import { parsePlandayDate, parsePlandayEffectiveDate } from "./time";

/**
 * Planday response schemas (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §4.7, notes §9). Each schema lists
 * **only** the fields ClockOff uses; Zod 4's `z.object` strips every other key at parse time, so the strip sets of
 * notes §9.2 (`userName`, phones, address, `hiredDate`, `salaryIdentifier`, termination fields, `ssn`,
 * `bankAccount`, `birthDate`, `gender`, `workHours`, `custom_*`, …), shift `comment`, `deletedBy`, punch
 * `description`, `scheduleDay.description`, `portal.aliases` and `companyName` never leave this module. The mappers
 * then build new objects field by field.
 *
 * Keys the specs mark as required stay required where a missing key would change a decision (a shift without
 * `employeeId` must not read as an open shift, one without `departmentId` must not read as "no department"): a
 * missing key fails the page with PLANDAY_INVALID_RESPONSE instead of being guessed.
 */

/** A Planday int64 id: a JSON number that is a non-negative safe integer, output as a decimal string. */
export const plandayIdSchema = z
  .number()
  .refine((n) => Number.isSafeInteger(n) && n >= 0, { message: "unsafe or negative id" })
  .transform((n) => String(n));

/** A `format: date` value (`YYYY-MM-DD`, also with a midnight time part), output as `YYYY-MM-DD`. */
export const plandayDateSchema = z.string().transform((value, ctx) => {
  const date = parsePlandayDate(value);
  if (date === null) {
    ctx.addIssue({ code: "custom", message: "not a date" });
    return z.NEVER;
  }
  return date;
});

/**
 * An HR effective date (`deactivationDate`): kept as the string Planday sent, but it must be readable, because a
 * misread dismissal date could deactivate someone too early. The mapper resolves it in the portal zone.
 */
const effectiveDateSchema = z
  .string()
  .refine((value) => value.trim() === "" || parsePlandayEffectiveDate(value, "UTC") !== null, {
    message: "not a date",
  });

/** `paging` of a list response. HR marks no field required; Scheduling and Punch Clock require all three. */
export const plandayPagingSchema = z
  .object({
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().nonnegative().optional(),
    total: z.number().int().nonnegative(),
  })
  .nullish()
  .transform((paging) => paging ?? null);
export type PlandayPaging = z.output<typeof plandayPagingSchema>;

/** `{ data: [...], paging }`: every offset-paginated list ClockOff reads (notes §7). */
export function pagedResponseSchema<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), paging: plandayPagingSchema });
}

/** `{ data: { … } }` of a by-id read; `data: null` is answered as not found by the client. */
export function singleResponseSchema<T extends z.ZodType>(item: T) {
  return z.object({ data: item.nullable() });
}

// ---------------------------------------------------------------------------------------------------------
// Portal (notes §9.1)
// ---------------------------------------------------------------------------------------------------------

export const portalInfoSchema = z.object({
  id: plandayIdSchema,
  name: z.string(),
  /** IANA or Windows: undocumented (Q28). The mapper keeps only an IANA zone as the portal zone. */
  timeZone: z.string().nullable(),
  /** Child portals: counted only. */
  portals: z.array(z.object({ id: plandayIdSchema })).nullish(),
});
export const portalInfoResponseSchema = z.object({ data: portalInfoSchema });
export type RawPortalInfo = z.output<typeof portalInfoSchema>;

// ---------------------------------------------------------------------------------------------------------
// HR (notes §9.2)
// ---------------------------------------------------------------------------------------------------------

export const departmentSchema = z.object({
  id: plandayIdSchema,
  name: z.string(),
  number: z.string().nullish(),
});
export type RawDepartment = z.output<typeof departmentSchema>;

export const employeeGroupSchema = z.object({
  id: plandayIdSchema,
  name: z.string(),
});
export type RawEmployeeGroup = z.output<typeof employeeGroupSchema>;

export const employeeSchema = z.object({
  id: plandayIdSchema,
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().nullish(),
  departments: z.array(plandayIdSchema).nullish(),
  primaryDepartmentId: plandayIdSchema.nullish(),
  employeeGroups: z.array(plandayIdSchema).nullish(),
  deactivationDate: effectiveDateSchema.nullish(),
});
export type RawEmployee = z.output<typeof employeeSchema>;

export const deactivatedEmployeeSchema = z.object({
  id: plandayIdSchema,
  deactivationDate: effectiveDateSchema.nullish(),
});
export type RawDeactivatedEmployee = z.output<typeof deactivatedEmployeeSchema>;

/**
 * `GET /hr/v1.0/employees/{employeeId}` is read only to confirm a deactivation (notes §9.2 rule): nothing but the
 * deactivation evidence is parsed. This schema allows additional properties upstream (custom fields), all
 * stripped here.
 */
export const employeeDetailsSchema = z.object({
  isDeactivated: z.boolean().nullish(),
  deactivationDate: effectiveDateSchema.nullish(),
});
export type RawEmployeeDetails = z.output<typeof employeeDetailsSchema>;

// ---------------------------------------------------------------------------------------------------------
// Scheduling (notes §9.3)
// ---------------------------------------------------------------------------------------------------------

export const shiftSchema = z.object({
  id: plandayIdSchema,
  /** Required key, nullable value: null = not in any department. */
  departmentId: plandayIdSchema.nullable(),
  /** Required key, nullable value: null = open (unassigned) shift. */
  employeeId: plandayIdSchema.nullable(),
  employeeGroupId: plandayIdSchema.nullish(),
  /** The local date the shift starts on; checked against the parsed start (§4.8). */
  date: plandayDateSchema.nullish(),
  /** Date-time strings; read by time.ts (an unreadable value is a record-level INVALID_TIME, not a page error). */
  startDateTime: z.string().nullable(),
  endDateTime: z.string().nullable(),
  /** Required by the spec; null falls back to the portal zone. */
  timeZone: z.string().nullable(),
  /** `ShiftStatusExtended`, parsed as a string and classified (§6.6), so a new value cannot fail a sync. */
  status: z.string(),
});
export type RawShift = z.output<typeof shiftSchema>;

export const deletedShiftSchema = z.object({
  id: plandayIdSchema,
  dateTimeDeleted: z.string().nullable(),
});
export type RawDeletedShift = z.output<typeof deletedShiftSchema>;

export const scheduleDaySchema = z.object({
  date: plandayDateSchema,
  departmentId: plandayIdSchema,
  isVisible: z.boolean().nullable(),
});
export type RawScheduleDay = z.output<typeof scheduleDaySchema>;

// ---------------------------------------------------------------------------------------------------------
// Punch Clock (notes §9.4, Beta)
// ---------------------------------------------------------------------------------------------------------

export const punchClockShiftSchema = z.object({
  id: plandayIdSchema,
  shiftId: plandayIdSchema.nullish(),
  departmentId: plandayIdSchema,
  employeeId: plandayIdSchema.nullish(),
  startDateTime: z.string().nullish(),
  endDateTime: z.string().nullish(),
  isApproved: z.boolean().nullish(),
});
export type RawPunchClockShift = z.output<typeof punchClockShiftSchema>;

export const punchClockBreakSchema = z.object({
  id: plandayIdSchema,
  startDateTime: z.string(),
  endDateTime: z.string().nullish(),
});
export type RawPunchClockBreak = z.output<typeof punchClockBreakSchema>;

// ---------------------------------------------------------------------------------------------------------
// Identity server (notes §3; plan §4.3)
// ---------------------------------------------------------------------------------------------------------

/**
 * Token endpoint success body. `id_token` is not listed, so it is dropped unparsed and never stored or logged.
 * `refresh_token`, `expires_in` and `scope` are optional on the refresh grant (notes §3.3).
 */
export const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).nullish(),
  expires_in: z.number().int().positive().nullish(),
  scope: z.string().nullish(),
  token_type: z.string().nullish(),
});
export type RawTokenResponse = z.output<typeof tokenResponseSchema>;

/** The authorization-code exchange must return a refresh token (it is the connection's credential). */
export const codeExchangeResponseSchema = tokenResponseSchema.extend({
  refresh_token: z.string().min(1),
});
