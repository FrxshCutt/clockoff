import { z } from "zod";
import { offsetPaginationQuerySchema, uuidSchema } from "./common";
import {
  integrationProviderSchema,
  integrationStatusSchema,
  permissionStateSchema,
  selectionStateSchema,
  workModeStateSchema,
} from "./enumSchemas";
import { instantSchema, nullableInstantSchema, offsetPaginatedResponseSchema } from "./primitives";
import { deviceStatusSchema, employeeSummarySchema, shiftSummarySchema } from "./refs";

/**
 * Compliance dashboard (§5 compliance). Metric cards count ACTIVE (not archived, not deactivated)
 * employees; each card has a matching `filter` value for `GET /api/compliance/employees`.
 */

export const COMPLIANCE_METRIC_KEYS = [
  "totalEmployees",
  "connected",
  "awaitingSetup",
  "missingPermissions",
  "workingNow",
  "workModeActive",
  "onBreak",
  "needsAttention",
] as const;
export type ComplianceMetricKey = (typeof COMPLIANCE_METRIC_KEYS)[number];

export const complianceMetricsSchema = z
  .object({
    /** Active employees. */
    totalEmployees: z.int().min(0),
    /** inviteStatus CONNECTED (permission approved + selection configured). */
    connected: z.int().min(0),
    /** NOT_INVITED, INVITED, JOINED or SETUP_INCOMPLETE. */
    awaitingSetup: z.int().min(0),
    /** Device permission DENIED / REVOKED (badge PERMISSIONS_MISSING). */
    missingPermissions: z.int().min(0),
    /** Expected to be on shift right now. */
    workingNow: z.int().min(0),
    /** Device reports restrictions active (WORKING / SHIFT_ENDING). */
    workModeActive: z.int().min(0),
    onBreak: z.int().min(0),
    /** Badges NEEDS_ATTENTION, SYNC_DELAYED, OFFLINE or PERMISSIONS_MISSING while on shift. */
    needsAttention: z.int().min(0),
  })
  .meta({ id: "ComplianceMetrics" });
export type ComplianceMetrics = z.infer<typeof complianceMetricsSchema>;

export const upcomingShiftSchema = z
  .object({
    shift: shiftSummarySchema,
    employee: employeeSummarySchema,
    deviceStatus: deviceStatusSchema.nullable(),
    /** False when the employee's phone will not be able to enforce Work Mode (not connected / no permission). */
    ready: z.boolean(),
  })
  .meta({ id: "UpcomingShift" });
export type UpcomingShift = z.infer<typeof upcomingShiftSchema>;

export const integrationStatusSummarySchema = z
  .object({
    provider: integrationProviderSchema,
    status: integrationStatusSchema,
    lastSyncAt: nullableInstantSchema,
    lastError: z.string().nullable(),
  })
  .meta({ id: "IntegrationStatusSummary" });

/** `GET /api/compliance/summary` */
export const complianceSummaryResponseSchema = z
  .object({
    generatedAt: instantSchema,
    metrics: complianceMetricsSchema,
    /** Shifts starting in the next 24 hours, soonest first (max 20). */
    upcomingShifts: z.array(upcomingShiftSchema).max(50),
    /** Only providers with a stored integration row (connected, errored or disconnected). */
    integrationStatus: z.array(integrationStatusSummarySchema),
  })
  .meta({ id: "ComplianceSummaryResponse" });
export type ComplianceSummaryResponse = z.infer<typeof complianceSummaryResponseSchema>;

export const COMPLIANCE_FILTERS = [
  "ALL",
  "CONNECTED",
  "AWAITING_SETUP",
  "MISSING_PERMISSIONS",
  "WORKING_NOW",
  "WORK_MODE_ACTIVE",
  "ON_BREAK",
  "NEEDS_ATTENTION",
] as const;
export type ComplianceFilter = (typeof COMPLIANCE_FILTERS)[number];
export const complianceFilterSchema = z.enum(COMPLIANCE_FILTERS).meta({ id: "ComplianceFilter" });

/** Metric card → list filter. */
export const COMPLIANCE_METRIC_FILTER: Record<ComplianceMetricKey, ComplianceFilter> = {
  totalEmployees: "ALL",
  connected: "CONNECTED",
  awaitingSetup: "AWAITING_SETUP",
  missingPermissions: "MISSING_PERMISSIONS",
  workingNow: "WORKING_NOW",
  workModeActive: "WORK_MODE_ACTIVE",
  onBreak: "ON_BREAK",
  needsAttention: "NEEDS_ATTENTION",
};

/** `GET /api/compliance/employees?filter=...` */
export const complianceEmployeesQuerySchema = offsetPaginationQuerySchema.extend({
  filter: complianceFilterSchema.default("ALL"),
  locationId: uuidSchema.optional(),
  teamId: uuidSchema.optional(),
  search: z.string().trim().max(100).optional(),
});
export type ComplianceEmployeesQuery = z.infer<typeof complianceEmployeesQuerySchema>;

export const complianceEmployeeRowSchema = z
  .object({
    employee: employeeSummarySchema,
    deviceStatus: deviceStatusSchema.nullable(),
    permissionState: permissionStateSchema.nullable(),
    selectionState: selectionStateSchema.nullable(),
    expectedState: workModeStateSchema.nullable(),
    reportedState: workModeStateSchema.nullable(),
    activeShift: shiftSummarySchema.nullable(),
    lastSyncAt: nullableInstantSchema,
    attentionReason: z.string().nullable(),
  })
  .meta({ id: "ComplianceEmployeeRow" });
export type ComplianceEmployeeRow = z.infer<typeof complianceEmployeeRowSchema>;

export const complianceEmployeesResponseSchema = offsetPaginatedResponseSchema(
  complianceEmployeeRowSchema,
).meta({
  id: "ComplianceEmployeesResponse",
});
export type ComplianceEmployeesResponse = z.infer<typeof complianceEmployeesResponseSchema>;
