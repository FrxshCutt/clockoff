import { z } from "zod";
import { STATUS_SEVERITIES } from "@workmode/shared/status/deriveDeviceStatus";
import { uuidSchema } from "./common";
import { deviceStatusBadgeSchema, inviteStatusSchema, shiftStatusSchema } from "./enumSchemas";
import { instantSchema, nullableInstantSchema } from "./primitives";

/**
 * Lightweight reference shapes embedded inside other resources (an employee's location, an event's
 * employee, ...). They live here so that domain modules can share them without importing each other.
 */

export const namedRefSchema = z
  .object({ id: uuidSchema, name: z.string() })
  .meta({ id: "NamedRef", description: "Reference to a named resource." });
export type NamedRef = z.infer<typeof namedRefSchema>;

/** A manager (`User`) as shown in createdBy / actor fields. */
export const actorRefSchema = z
  .object({ id: uuidSchema, name: z.string(), email: z.string().nullable() })
  .meta({ id: "ActorRef" });
export type ActorRef = z.infer<typeof actorRefSchema>;

export const employeeSummarySchema = z
  .object({
    id: uuidSchema,
    firstName: z.string(),
    lastName: z.string(),
    jobTitle: z.string().nullable(),
    primaryLocation: namedRefSchema.nullable(),
    inviteStatus: inviteStatusSchema,
  })
  .meta({ id: "EmployeeSummary" });
export type EmployeeSummary = z.infer<typeof employeeSummarySchema>;

export const shiftSummarySchema = z
  .object({
    id: uuidSchema,
    startsAt: instantSchema,
    endsAt: instantSchema,
    timezone: z.string(),
    status: shiftStatusSchema,
    location: namedRefSchema.nullable(),
  })
  .meta({ id: "ShiftSummary" });
export type ShiftSummary = z.infer<typeof shiftSummarySchema>;

/** `StatusSeverity` from `deriveDeviceStatus` (@workmode/shared): ok | info | warning | error. */
export { STATUS_SEVERITIES };
export type StatusSeverityValue = (typeof STATUS_SEVERITIES)[number];
export const statusSeveritySchema = z.enum(STATUS_SEVERITIES).meta({ id: "StatusSeverity" });

/**
 * Derived device/work badge (§9), computed by `deriveDeviceStatus` in @workmode/shared. `reason` is a short
 * human explanation when the badge needs one; `since` is when the underlying state began, when known.
 */
export const deviceStatusSchema = z
  .object({
    badge: deviceStatusBadgeSchema,
    reason: z.string().nullable(),
    severity: statusSeveritySchema,
    since: nullableInstantSchema,
  })
  .meta({ id: "DeviceStatus" });
export type DeviceStatus = z.infer<typeof deviceStatusSchema>;
