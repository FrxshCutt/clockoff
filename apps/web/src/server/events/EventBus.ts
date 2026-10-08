/**
 * Realtime events fan out from the server to dashboard SSE streams (per organisation) and to the device
 * push bridge. `type` is an open string so feature engineers can add kinds without touching this file;
 * the known kinds are listed in {@link REALTIME_EVENT_TYPES} for discoverability.
 */
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
export type KnownRealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];

/**
 * Bus event kinds that make a device re-sync (consumed by `server/realtime/pushBridge.ts`). Declared here,
 * next to the bus, because the cross-process bus must never drop them when its send queue overflows.
 * `SCHEDULE_CHANGED` is a push-only kind: the dashboard listens for `shift.changed` instead.
 */
export const PUSH_BRIDGE_EVENT_TYPES = [
  "POLICY_CHANGED",
  "BREAK_POLICY_CHANGED",
  "SCHEDULE_CHANGED",
  "OVERRIDE_CREATED",
  "OVERRIDE_REVOKED",
  "OVERRIDE_EXPIRED",
] as const;
export type PushBridgeEventType = (typeof PUSH_BRIDGE_EVENT_TYPES)[number];

export function isPushBridgeEventType(type: string): type is PushBridgeEventType {
  return (PUSH_BRIDGE_EVENT_TYPES as readonly string[]).includes(type);
}

export interface RealtimeEvent {
  type: KnownRealtimeEventType | (string & {});
  organisationId: string;
  employeeId?: string;
  /**
   * JSON-serialisable, operational data only (never PII — §12). `{ truncated: true }` alone means the
   * cross-process bus could not carry the original payload (too large, or coalesced in an overflow):
   * treat the event as "refetch" (dashboards) / "every device of the organisation" (push bridge).
   */
  payload: Record<string, unknown>;
  /** ISO-8601 UTC instant. */
  at: string;
}

export type RealtimeEventHandler = (event: RealtimeEvent) => void;
export type Unsubscribe = () => void;

export interface EventBus {
  publish(event: RealtimeEvent): void;
  /** Receive every event for `organisationId`. Returns the unsubscribe function. */
  subscribe(organisationId: string, handler: RealtimeEventHandler): Unsubscribe;
  /** Receive every event of every organisation (the push bridge). Returns the unsubscribe function. */
  subscribeAll(handler: RealtimeEventHandler): Unsubscribe;
  /** Number of live subscribers for an organisation (diagnostics / tests). */
  subscriberCount(organisationId: string): number;
}
