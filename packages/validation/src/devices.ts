import { z } from "zod";
import { offsetPaginationQuerySchema, uuidSchema } from "./common";
import {
  permissionStateSchema,
  platformSchema,
  selectionStateSchema,
  workModeStateSchema,
} from "./enumSchemas";
import {
  instantSchema,
  nullableInstantSchema,
  offsetPaginatedResponseSchema,
  queryBooleanSchema,
  queryListSchema,
} from "./primitives";
import { employeeSummarySchema } from "./refs";

/** Counts only — never tokens, bundle identifiers or domains (§12). Shared by the device report and the summary. */
export const selectionCountsSchema = z
  .object({
    categories: z.int().min(0).max(10_000),
    applications: z.int().min(0).max(10_000),
    webDomains: z.int().min(0).max(10_000),
  })
  .strict()
  .meta({
    id: "SelectionCounts",
    description: "How many categories / apps / web domains the employee selected. Counts only.",
  });
export type SelectionCounts = z.infer<typeof selectionCountsSchema>;

/**
 * Everything a manager may see about a phone (§12): operational and compliance signals only. No device
 * identifiers (IDFV/IDFA), phone numbers, push tokens, app lists, selected apps, locations or content.
 */
export const deviceSummarySchema = z
  .object({
    id: uuidSchema,
    platform: platformSchema,
    appVersion: z.string().nullable(),
    osVersion: z.string().nullable(),
    deviceModel: z.string().nullable(),
    permissionState: permissionStateSchema,
    selectionState: selectionStateSchema,
    selectionCounts: selectionCountsSchema,
    restrictionEngineState: workModeStateSchema,
    policyVersionId: uuidSchema.nullable(),
    policyVersionNumber: z.int().min(1).nullable(),
    scheduleVersion: z.int().min(0),
    timezone: z.string().nullable(),
    lastDeviceSyncAt: nullableInstantSchema,
    lastPolicySyncAt: nullableInstantSchema,
    lastScheduleSyncAt: nullableInstantSchema,
    lastSeenAt: nullableInstantSchema,
    lastClockSkewSeconds: z.int().nullable(),
    /** Whether a push token is registered (the token itself is never returned). */
    hasPushToken: z.boolean(),
    isActive: z.boolean(),
    deactivatedAt: nullableInstantSchema,
    createdAt: instantSchema,
  })
  .meta({
    id: "DeviceSummary",
    description:
      "Operational signals only (§12): no identifiers, app lists, push tokens, locations or content.",
  });
export type DeviceSummary = z.infer<typeof deviceSummarySchema>;

export const deviceQuerySchema = offsetPaginationQuerySchema.extend({
  employeeId: uuidSchema.optional(),
  locationId: uuidSchema.optional(),
  isActive: queryBooleanSchema.optional(),
  permissionState: queryListSchema(permissionStateSchema).optional(),
});
export type DeviceQuery = z.infer<typeof deviceQuerySchema>;

export const deviceWithEmployeeSchema = z
  .object({ device: deviceSummarySchema, employee: employeeSummarySchema })
  .meta({ id: "DeviceWithEmployee" });
export type DeviceWithEmployee = z.infer<typeof deviceWithEmployeeSchema>;

export const listDevicesResponseSchema = offsetPaginatedResponseSchema(
  deviceWithEmployeeSchema,
).meta({
  id: "ListDevicesResponse",
});
export type ListDevicesResponse = z.infer<typeof listDevicesResponseSchema>;

export const deviceResponseSchema = deviceWithEmployeeSchema;
export type DeviceResponse = DeviceWithEmployee;

/** `POST /api/devices/:id/deactivate` — revokes the device's refresh tokens; the app must re-join. */
export const deactivateDeviceSchema = z
  .object({ reason: z.string().trim().max(500).optional() })
  .strict();
export type DeactivateDeviceInput = z.infer<typeof deactivateDeviceSchema>;
