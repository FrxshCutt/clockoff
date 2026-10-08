import { z } from "zod";
import { uuidSchema } from "./common";
import {
  integrationConnectionStatusSchema,
  integrationProviderSchema,
  integrationSyncRunKindSchema,
  integrationSyncRunStatusSchema,
  integrationSyncTriggerSchema,
} from "./enumSchemas";
import { instantSchema, jsonObjectSchema } from "./primitives";

/**
 * Realtime (§5 `GET /api/realtime/stream`): a Server-Sent Events stream per organisation. Each frame is
 * `event: <type>\nid: <n>\ndata: <SseEvent JSON>\n\n`; `: ping` comments keep the connection alive and
 * the server ends every stream after a fixed lifetime with the `REALTIME_RECONNECT_EVENT` control frame.
 * Events are cache-invalidation hints for the dashboard — refetch the resource, never treat the payload
 * as the source of truth.
 */

/**
 * Stream CONTROL frame, not an event kind: `event: reconnect\ndata: {}\n\n` is the last frame of a stream
 * the server ends on purpose (its lifetime cap). A client that knows it reconnects silently; one that does
 * not ignores the unknown named event and reconnects as after any drop. Deliberately absent from
 * `REALTIME_EVENT_TYPES`: it is never published on the bus, invalidates no query and never reaches the
 * push bridge.
 */
export const REALTIME_RECONNECT_EVENT = "reconnect" as const;

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
  /**
   * Workforce integration runs and health (Planday; docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §7.11).
   * Hints only: the dashboard refetches the run / card / banner. Payloads carry ids, enums, numbers and
   * labels ClockOff writes itself, never names, emails or Planday values. `integration.run.cancelled` also
   * tells the worker's integration runner to abort that run's slice.
   */
  "integration.run.queued",
  "integration.run.cancelled",
  "integration.sync.progress",
  "integration.health.changed",
] as const;
export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];

// ── Integration events (§7.11) ──────────────────────────────────────────────

export const INTEGRATION_REALTIME_EVENT_TYPES = [
  "integration.run.queued",
  "integration.run.cancelled",
  "integration.sync.progress",
  "integration.health.changed",
] as const satisfies readonly RealtimeEventType[];
export type IntegrationRealtimeEventType = (typeof INTEGRATION_REALTIME_EVENT_TYPES)[number];

/**
 * Payloads of the integration events. Strict: ids, enums, numbers and ClockOff's own labels only, so a payload
 * that picked up a name, an email or a Planday value fails to parse (the progress-events test relies on it).
 */
export const integrationRunQueuedPayloadSchema = z
  .object({
    provider: integrationProviderSchema,
    integrationId: uuidSchema,
    runId: uuidSchema,
    kind: integrationSyncRunKindSchema,
    trigger: integrationSyncTriggerSchema,
  })
  .strict();
export type IntegrationRunQueuedPayload = z.infer<typeof integrationRunQueuedPayloadSchema>;

export const integrationRunCancelledPayloadSchema = z
  .object({ provider: integrationProviderSchema, integrationId: uuidSchema, runId: uuidSchema })
  .strict();
export type IntegrationRunCancelledPayload = z.infer<typeof integrationRunCancelledPayloadSchema>;

export const integrationSyncProgressPayloadSchema = z
  .object({
    provider: integrationProviderSchema,
    integrationId: uuidSchema,
    runId: uuidSchema,
    kind: integrationSyncRunKindSchema,
    trigger: integrationSyncTriggerSchema,
    status: integrationSyncRunStatusSchema,
    phase: z.string().max(64),
    /** ClockOff's own label, e.g. "Reading employees (page 3)". */
    label: z.string().max(200),
    completedPhases: z.int().min(0),
    totalPhases: z.int().min(0),
    pagesRead: z.int().min(0),
    /** Not claimed by the worker yet ("Waiting to start"). */
    queued: z.boolean(),
    resumeAfter: instantSchema.nullable(),
    finished: z.boolean(),
  })
  .strict();
export type IntegrationSyncProgressPayload = z.infer<typeof integrationSyncProgressPayloadSchema>;

/** Only transitions that change the banner or the compliance flag (into or out of DEGRADED, AUTH_ERROR, DISCONNECTED). */
export const integrationHealthChangedPayloadSchema = z
  .object({
    provider: integrationProviderSchema,
    integrationId: uuidSchema,
    status: integrationConnectionStatusSchema,
  })
  .strict();
export type IntegrationHealthChangedPayload = z.infer<typeof integrationHealthChangedPayloadSchema>;

/** Payload schema of each integration event kind. */
export const INTEGRATION_EVENT_PAYLOAD_SCHEMAS = {
  "integration.run.queued": integrationRunQueuedPayloadSchema,
  "integration.run.cancelled": integrationRunCancelledPayloadSchema,
  "integration.sync.progress": integrationSyncProgressPayloadSchema,
  "integration.health.changed": integrationHealthChangedPayloadSchema,
} as const satisfies Record<IntegrationRealtimeEventType, z.ZodType>;

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
