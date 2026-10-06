/**
 * Realtime events fan out from the server to dashboard SSE streams (per organisation).
 * `type` is an open string so feature engineers can add kinds without touching this file; the
 * known kinds are listed in {@link REALTIME_EVENT_TYPES} for discoverability.
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
] as const;
export type KnownRealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];

export interface RealtimeEvent {
  type: KnownRealtimeEventType | (string & {});
  organisationId: string;
  employeeId?: string;
  /** JSON-serialisable, operational data only (never PII — §12). */
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
  /** Number of live subscribers for an organisation (diagnostics / tests). */
  subscriberCount(organisationId: string): number;
}
