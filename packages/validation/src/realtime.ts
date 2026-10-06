import { z } from "zod";
import { uuidSchema } from "./common";
import { instantSchema, jsonObjectSchema } from "./primitives";

/**
 * Realtime (§5 `GET /api/realtime/stream`): a Server-Sent Events stream per organisation. Each frame is
 * `event: <type>\nid: <n>\ndata: <SseEvent JSON>\n\n`; `: ping` comments keep the connection alive.
 * Events are cache-invalidation hints for the dashboard — refetch the resource, never treat the payload
 * as the source of truth.
 */

/** Known event kinds (mirrors REALTIME_EVENT_TYPES in apps/web/src/server/events). */
export const REALTIME_EVENT_TYPES = [
  "activity.recorded",
  "employee.work_state.changed",
  "device.status.changed",
  "notification.created",
  "shift.changed",
  "policy.changed",
  "override.changed",
  "import.completed",
  /** Override lifecycle events consumed by the device push bridge (payload: overrideId, type, employeeId|null). */
  "OVERRIDE_CREATED",
  "OVERRIDE_REVOKED",
  "OVERRIDE_EXPIRED",
  /**
   * Policy lifecycle events published by the policies / break-policies services and consumed by the device
   * push bridge. Payload: policyId | breakPolicyId (null when the organisation default was cleared), reason,
   * affectedEmployeeIds, affectedEmployeeCount; POLICY_CHANGED adds versionId / versionNumber on publish.
   * `policy.changed` above is the older dashboard-facing spelling, kept for compatibility.
   */
  "POLICY_CHANGED",
  "BREAK_POLICY_CHANGED",
] as const;
export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];

export const sseEventSchema = z
  .object({
    /** One of REALTIME_EVENT_TYPES; open string so clients ignore kinds they do not know. */
    type: z.string().meta({ examples: [...REALTIME_EVENT_TYPES] }),
    organisationId: uuidSchema,
    employeeId: uuidSchema.optional(),
    /** Operational data only (ids, states) — never PII (§12). */
    payload: jsonObjectSchema,
    at: instantSchema,
  })
  .meta({ id: "SseEvent", description: "`data:` payload of every realtime SSE frame." });
export type SseEvent = z.infer<typeof sseEventSchema>;

/** `GET /api/realtime/stream` — optionally narrowed to one employee. */
export const realtimeStreamQuerySchema = z.object({ employeeId: uuidSchema.optional() });
export type RealtimeStreamQuery = z.infer<typeof realtimeStreamQuerySchema>;
