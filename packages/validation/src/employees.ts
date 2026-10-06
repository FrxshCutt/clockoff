import { z } from "zod";
import {
  emailSchema,
  isoDateTimeSchema,
  nonEmptyString,
  offsetPaginationQuerySchema,
  uuidSchema,
} from "./common";
import { activityEventSchema } from "./activity";
import { deviceSummarySchema } from "./devices";
import {
  apiErrorCodeSchema,
  deviceStatusBadgeSchema,
  employmentStatusSchema,
  inviteChannelSchema,
  inviteStatusSchema,
  workModeStateSchema,
} from "./enumSchemas";
import { employeeInviteSchema } from "./invites";
import { overrideSchema } from "./overrides";
import { resolvedPolicyRefSchema } from "./policies";
import {
  instantSchema,
  nullableInstantSchema,
  offsetPaginatedResponseSchema,
  patchStringSchema,
  phoneSchema,
  queryListSchema,
  sortParamSchema,
  uuidListSchema,
} from "./primitives";
import {
  deviceStatusSchema,
  employeeSummarySchema,
  namedRefSchema,
  shiftSummarySchema,
} from "./refs";
import {
  breakAllowanceSchema,
  breakSessionSchema,
  employeeWorkStateSchema,
  expectedStateSchema,
} from "./workState";

export const EMPLOYEE_LIMITS = {
  nameMaxLength: 100,
  jobTitleMaxLength: 120,
  externalIdMaxLength: 100,
  maxLocations: 50,
  maxTeams: 50,
  bulkMaxEmployees: 500,
} as const;

const firstNameSchema = nonEmptyString(EMPLOYEE_LIMITS.nameMaxLength);
const lastNameSchema = nonEmptyString(EMPLOYEE_LIMITS.nameMaxLength);
const externalEmployeeIdSchema = nonEmptyString(EMPLOYEE_LIMITS.externalIdMaxLength);
const jobTitleSchema = nonEmptyString(EMPLOYEE_LIMITS.jobTitleMaxLength);
const locationIdsSchema = uuidListSchema({ max: EMPLOYEE_LIMITS.maxLocations });
const teamIdsSchema = uuidListSchema({ max: EMPLOYEE_LIMITS.maxTeams });

// ── List query ──────────────────────────────────────────────────────────────

export const EMPLOYEE_SORT_FIELDS = [
  "lastName",
  "firstName",
  "createdAt",
  "inviteStatus",
  "lastSyncAt",
] as const;
export type EmployeeSortField = (typeof EMPLOYEE_SORT_FIELDS)[number];

/** `GET /api/employees` — archived (soft-deleted) employees are never listed. */
export const employeeQuerySchema = offsetPaginationQuerySchema.extend({
  /** Matches first/last name, email, external id and job title (case-insensitive substring). */
  search: z.string().trim().max(100).optional(),
  inviteStatus: queryListSchema(inviteStatusSchema).optional(),
  /** Filters on the derived badge (§9); evaluated after the database query. */
  deviceStatus: queryListSchema(deviceStatusBadgeSchema).optional(),
  employmentStatus: queryListSchema(employmentStatusSchema).optional(),
  locationId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
  teamId: uuidSchema.optional(),
  /** Employees whose RESOLVED Work Policy is this one. */
  policyId: uuidSchema.optional(),
  sort: sortParamSchema(EMPLOYEE_SORT_FIELDS).default("lastName"),
});
export type EmployeeQuery = z.infer<typeof employeeQuerySchema>;

// ── Create / update ─────────────────────────────────────────────────────────

/** `POST /api/employees` */
export const createEmployeeSchema = z
  .object({
    firstName: firstNameSchema,
    lastName: lastNameSchema,
    email: emailSchema.optional(),
    phone: phoneSchema.optional(),
    externalEmployeeId: externalEmployeeIdSchema.optional(),
    jobTitle: jobTitleSchema.optional(),
    departmentId: uuidSchema.optional(),
    primaryLocationId: uuidSchema.optional(),
    /** Additional locations the employee works at (the primary one is added automatically). */
    locationIds: locationIdsSchema.optional(),
    teamIds: teamIdsSchema.optional(),
    /** Employee-level Work Policy override (an EMPLOYEE-scope assignment). */
    policyId: uuidSchema.optional(),
    /** Employee-level Break Policy override. */
    breakPolicyId: uuidSchema.optional(),
  })
  .strict();
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;

/**
 * `PATCH /api/employees/:id` — omitted = unchanged, `null` = clear. `locationIds` / `teamIds` replace the
 * whole set; `policyId: null` / `breakPolicyId: null` remove the employee-level override.
 */
export const updateEmployeeSchema = z
  .object({
    firstName: firstNameSchema.optional(),
    lastName: lastNameSchema.optional(),
    email: emailSchema.nullable().optional(),
    phone: phoneSchema.nullable().optional(),
    externalEmployeeId: patchStringSchema(EMPLOYEE_LIMITS.externalIdMaxLength),
    jobTitle: patchStringSchema(EMPLOYEE_LIMITS.jobTitleMaxLength),
    departmentId: uuidSchema.nullable().optional(),
    primaryLocationId: uuidSchema.nullable().optional(),
    locationIds: locationIdsSchema.optional(),
    teamIds: teamIdsSchema.optional(),
    policyId: uuidSchema.nullable().optional(),
    breakPolicyId: uuidSchema.nullable().optional(),
  })
  .strict();
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;

// ── Lifecycle & assignment actions ──────────────────────────────────────────

/** `POST /api/employees/:id/deactivate` — revokes the employee's devices and pending invites. */
export const deactivateEmployeeSchema = z
  .object({ reason: z.string().trim().max(500).optional() })
  .strict();
export type DeactivateEmployeeInput = z.infer<typeof deactivateEmployeeSchema>;

/** `POST /api/employees/:id/reactivate` */
export const reactivateEmployeeSchema = z.object({}).strict();
/** `POST /api/employees/:id/archive` — soft delete; the employee disappears from lists. */
export const archiveEmployeeSchema = z.object({}).strict();

/** `POST /api/employees/:id/assign-policy` — `null` removes the employee-level override. */
export const assignEmployeePolicySchema = z.object({ policyId: uuidSchema.nullable() }).strict();
export type AssignEmployeePolicyInput = z.infer<typeof assignEmployeePolicySchema>;

/** `POST /api/employees/:id/assign-break-policy` — `null` removes the employee-level override. */
export const assignEmployeeBreakPolicySchema = z
  .object({ breakPolicyId: uuidSchema.nullable() })
  .strict();
export type AssignEmployeeBreakPolicyInput = z.infer<typeof assignEmployeeBreakPolicySchema>;

/** `POST /api/employees/:id/assign-location` — at least one field. `locationIds` replaces the set. */
export const assignEmployeeLocationSchema = z
  .object({
    primaryLocationId: uuidSchema.nullable().optional(),
    locationIds: locationIdsSchema.optional(),
  })
  .strict()
  .refine((v) => v.primaryLocationId !== undefined || v.locationIds !== undefined, {
    message: "Provide primaryLocationId and/or locationIds",
  });
export type AssignEmployeeLocationInput = z.infer<typeof assignEmployeeLocationSchema>;

/** `POST /api/employees/:id/assign-team` — replaces the employee's team memberships. */
export const assignEmployeeTeamSchema = z.object({ teamIds: teamIdsSchema }).strict();
export type AssignEmployeeTeamInput = z.infer<typeof assignEmployeeTeamSchema>;

// ── Bulk ────────────────────────────────────────────────────────────────────

export const EMPLOYEE_BULK_ACTIONS = [
  "INVITE",
  "ASSIGN_POLICY",
  "ASSIGN_BREAK_POLICY",
  "ASSIGN_LOCATION",
  "ADD_TO_TEAM",
  "DEACTIVATE",
  "REACTIVATE",
  "ARCHIVE",
] as const;
export type EmployeeBulkAction = (typeof EMPLOYEE_BULK_ACTIONS)[number];
export const employeeBulkActionSchema = z
  .enum(EMPLOYEE_BULK_ACTIONS)
  .meta({ id: "EmployeeBulkAction" });

const bulkEmployeeIdsSchema = uuidListSchema({ min: 1, max: EMPLOYEE_LIMITS.bulkMaxEmployees });

/** `POST /api/employees/bulk` — `{ employeeIds, action, payload }`, payload shape depends on the action. */
export const bulkEmployeeActionSchema = z
  .discriminatedUnion("action", [
    z
      .object({
        action: z.literal("INVITE"),
        employeeIds: bulkEmployeeIdsSchema,
        payload: z
          .object({ channel: inviteChannelSchema.default("LINK") })
          .strict()
          .default({ channel: "LINK" }),
      })
      .strict(),
    z
      .object({
        action: z.literal("ASSIGN_POLICY"),
        employeeIds: bulkEmployeeIdsSchema,
        payload: assignEmployeePolicySchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("ASSIGN_BREAK_POLICY"),
        employeeIds: bulkEmployeeIdsSchema,
        payload: assignEmployeeBreakPolicySchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("ASSIGN_LOCATION"),
        employeeIds: bulkEmployeeIdsSchema,
        payload: z.object({ primaryLocationId: uuidSchema.nullable() }).strict(),
      })
      .strict(),
    z
      .object({
        action: z.literal("ADD_TO_TEAM"),
        employeeIds: bulkEmployeeIdsSchema,
        payload: z.object({ teamId: uuidSchema }).strict(),
      })
      .strict(),
    z
      .object({
        action: z.literal("DEACTIVATE"),
        employeeIds: bulkEmployeeIdsSchema,
        payload: deactivateEmployeeSchema.optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal("REACTIVATE"),
        employeeIds: bulkEmployeeIdsSchema,
        payload: z.object({}).strict().optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal("ARCHIVE"),
        employeeIds: bulkEmployeeIdsSchema,
        payload: z.object({}).strict().optional(),
      })
      .strict(),
  ])
  .meta({ id: "BulkEmployeeActionInput" });
export type BulkEmployeeActionInput = z.infer<typeof bulkEmployeeActionSchema>;

export const bulkEmployeeActionResponseSchema = z
  .object({
    action: employeeBulkActionSchema,
    processed: z.int().min(0),
    succeeded: z.int().min(0),
    /** Per-employee failures; the rest of the batch is still applied. */
    failed: z.array(
      z.object({ employeeId: uuidSchema, code: apiErrorCodeSchema, message: z.string() }),
    ),
  })
  .meta({ id: "BulkEmployeeActionResponse" });
export type BulkEmployeeActionResponse = z.infer<typeof bulkEmployeeActionResponseSchema>;

// ── Responses ───────────────────────────────────────────────────────────────

export const employeeSchema = z
  .object({
    id: uuidSchema,
    firstName: z.string(),
    lastName: z.string(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    externalEmployeeId: z.string().nullable(),
    jobTitle: z.string().nullable(),
    department: namedRefSchema.nullable(),
    primaryLocation: namedRefSchema.nullable(),
    /** Every location the employee works at, including the primary one. */
    locations: z.array(namedRefSchema),
    teams: z.array(namedRefSchema),
    employmentStatus: employmentStatusSchema,
    /** §9 lifecycle: NOT_INVITED → INVITED → JOINED → SETUP_INCOMPLETE → CONNECTED (or DEACTIVATED). */
    inviteStatus: inviteStatusSchema,
    /** Derived badge + reason; null until the employee has a device. */
    deviceStatus: deviceStatusSchema.nullable(),
    /** Employee-level Work Policy override, when set. */
    policyOverride: namedRefSchema.nullable(),
    /** Employee-level Break Policy override, when set. */
    breakPolicyOverride: namedRefSchema.nullable(),
    /** The Work Policy that actually applies and which scope it came from (§6.1). */
    resolvedPolicy: resolvedPolicyRefSchema.nullable(),
    resolvedBreakPolicy: resolvedPolicyRefSchema.nullable(),
    /** Next scheduled shift that has not ended yet (the current one while on shift). */
    nextShift: shiftSummarySchema.nullable(),
    /** Last device check-in (Device.lastDeviceSyncAt). */
    lastSyncAt: nullableInstantSchema,
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .meta({ id: "Employee" });
export type Employee = z.infer<typeof employeeSchema>;

/** `GET /api/employees/:id` adds the device, the latest invite and the stored work state. */
export const employeeDetailSchema = employeeSchema
  .extend({
    device: deviceSummarySchema.nullable(),
    latestInvite: employeeInviteSchema.nullable(),
    workState: employeeWorkStateSchema.nullable(),
  })
  .meta({ id: "EmployeeDetail" });
export type EmployeeDetail = z.infer<typeof employeeDetailSchema>;

export const listEmployeesResponseSchema = offsetPaginatedResponseSchema(employeeSchema).meta({
  id: "ListEmployeesResponse",
});
export type ListEmployeesResponse = z.infer<typeof listEmployeesResponseSchema>;

export const employeeResponseSchema = z
  .object({ employee: employeeSchema })
  .meta({ id: "EmployeeResponse" });
export type EmployeeResponse = z.infer<typeof employeeResponseSchema>;

export const employeeDetailResponseSchema = z
  .object({ employee: employeeDetailSchema })
  .meta({ id: "EmployeeDetailResponse" });
export type EmployeeDetailResponse = z.infer<typeof employeeDetailResponseSchema>;

// ── State (expected vs reported) ────────────────────────────────────────────

/** `GET /api/employees/:id/state` — timeline window; defaults to the last 24 hours. */
export const employeeStateQuerySchema = z
  .object({ from: isoDateTimeSchema.optional(), to: isoDateTimeSchema.optional() })
  .superRefine((v, ctx) => {
    if (v.from !== undefined && v.to !== undefined) {
      const span = Date.parse(v.to) - Date.parse(v.from);
      if (span <= 0)
        ctx.addIssue({ code: "custom", path: ["to"], message: "to must be after from" });
      else if (span > 31 * 86_400_000) {
        ctx.addIssue({ code: "custom", path: ["to"], message: "Range may not exceed 31 days" });
      }
    }
  });
export type EmployeeStateQuery = z.infer<typeof employeeStateQuerySchema>;

export const employeeStateResponseSchema = z
  .object({
    employee: employeeSummarySchema,
    /** Computed live from shifts, breaks, overrides and the device permission state. */
    expected: expectedStateSchema,
    /** Last state the device reported (null before the first report). */
    reported: z.object({
      state: workModeStateSchema.nullable(),
      reportedAt: nullableInstantSchema,
    }),
    /** True when the reported state disagrees with the expected one beyond the grace period. */
    diverged: z.boolean(),
    deviceStatus: deviceStatusSchema.nullable(),
    device: deviceSummarySchema.nullable(),
    workState: employeeWorkStateSchema.nullable(),
    activeShift: shiftSummarySchema.nullable(),
    activeBreak: breakSessionSchema.nullable(),
    breakAllowance: breakAllowanceSchema.nullable(),
    activeOverrides: z.array(overrideSchema),
    /** Activity for this employee in the window, oldest first. */
    timeline: z.array(activityEventSchema),
  })
  .meta({ id: "EmployeeStateResponse" });
export type EmployeeStateResponse = z.infer<typeof employeeStateResponseSchema>;
