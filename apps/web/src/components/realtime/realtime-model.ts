import type { QueryKey } from "@tanstack/react-query";
import {
  REALTIME_EVENT_TYPES,
  sseEventSchema,
  type RealtimeEventType,
  type SseEvent,
} from "@clockoff/validation/realtime";
import { activityKeys } from "@/components/activity/activity-keys";
import { deviceKeys } from "@/components/devices/device-keys";
import { employeeKeys, overrideKeys } from "@/components/employees/employee-keys";
import { importKeys } from "@/components/imports/import-queries";
import { complianceKeys } from "@/components/overview/compliance-keys";
import { breakPolicyQueryKeys, policyQueryKeys } from "@/components/policies/policy-query-keys";
import { scheduleKeys } from "@/components/schedule/schedule-queries";
import { queryKeys } from "@/lib/query-client";

/**
 * Pure logic behind the realtime connection (`useRealtimeConnection`): reconnect backoff, the polling
 * fallback threshold, SSE frame parsing and the "which queries does this event stale" table. No React or
 * browser APIs here so every rule is unit tested in node.
 */

export type RealtimeStatus = "connected" | "reconnecting" | "polling";

export const REALTIME_STREAM_PATH = "/api/realtime/stream";

export const REALTIME_TIMING = {
  /** Delay before the first reconnect attempt. */
  baseDelayMs: 1_000,
  /** Reconnect delays never exceed this. */
  maxDelayMs: 30_000,
  /** Disconnected for longer than this → status "polling" and the periodic refetch starts. */
  pollingAfterMs: 10_000,
  /** Fallback refetch interval while polling. */
  pollIntervalMs: 30_000,
  /** Invalidations caused by a burst of events are coalesced over this window. */
  coalesceMs: 250,
} as const;

/** The timing table's shape (widened so tests and callers can pass their own values). */
export type RealtimeTiming = { readonly [K in keyof typeof REALTIME_TIMING]: number };

/**
 * Exponential backoff with "equal jitter": attempt 0 → 0.5–1 s, 1 → 1–2 s, 2 → 2–4 s … capped at
 * `maxDelayMs`. The jitter spreads reconnecting dashboards out instead of letting them all retry in the
 * same tick after a server restart.
 */
export function nextBackoffMs(
  attempt: number,
  random: () => number = Math.random,
  timing: RealtimeTiming = REALTIME_TIMING,
): number {
  const exponent = Math.max(0, Math.min(Math.floor(Number.isFinite(attempt) ? attempt : 0), 30));
  const ceiling = Math.min(timing.maxDelayMs, timing.baseDelayMs * 2 ** exponent);
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.round(ceiling / 2 + (ceiling / 2) * r);
}

/** True once the connection has been down for longer than `pollingAfterMs`. */
export function isPollingFallbackDue(
  disconnectedSinceMs: number | null,
  nowMs: number,
  timing: RealtimeTiming = REALTIME_TIMING,
): boolean {
  return disconnectedSinceMs !== null && nowMs - disconnectedSinceMs > timing.pollingAfterMs;
}

/** Status to show while not connected: a short blip reads as "reconnecting", a long outage as "polling". */
export function statusWhileDisconnected(
  disconnectedSinceMs: number | null,
  nowMs: number,
  timing: RealtimeTiming = REALTIME_TIMING,
): RealtimeStatus {
  return isPollingFallbackDue(disconnectedSinceMs, nowMs, timing) ? "polling" : "reconnecting";
}

/**
 * The kinds the policies / break-policies services publish (`server/policies/events.ts`). The stream client
 * only subscribes to what `REALTIME_EVENT_TYPES` declares, so these entries are inert until the contract
 * lists them (it is being extended to); keeping them here means no UI change is needed when it does.
 */
export type PolicyBusEventType = "POLICY_CHANGED" | "BREAK_POLICY_CHANGED";

/**
 * Event type → query keys to invalidate. Realtime payloads are hints, never the source of truth (§5), so
 * every event simply refetches the resources it can have changed. Prefix keys are used so detail,
 * list and derived queries under a domain all refresh. Partial on purpose: the server may gain event
 * kinds before this UI does, and those fall back to `DEFAULT_INVALIDATION_KEYS`.
 */
export const REALTIME_INVALIDATIONS: Partial<
  Record<RealtimeEventType | PolicyBusEventType, readonly QueryKey[]>
> = {
  "activity.recorded": [activityKeys.all, complianceKeys.all, employeeKeys.all],
  "employee.work_state.changed": [complianceKeys.all, employeeKeys.all, activityKeys.all],
  // Joining / leaving / deactivating a phone also moves the overview's setup checklist ("Employees connect
  // their phones", "Go live"), which no manager action on that page would refresh.
  "device.status.changed": [
    complianceKeys.all,
    deviceKeys.all,
    employeeKeys.all,
    queryKeys.onboarding,
  ],
  "notification.created": [queryKeys.notifications],
  "shift.changed": [scheduleKeys.shiftsRoot, complianceKeys.all, employeeKeys.all],
  "policy.changed": [
    policyQueryKeys.all,
    breakPolicyQueryKeys.all,
    employeeKeys.all,
    complianceKeys.all,
  ],
  "override.changed": [overrideKeys.all, employeeKeys.all, complianceKeys.all],
  "import.completed": [
    importKeys.root,
    scheduleKeys.shiftsRoot,
    complianceKeys.all,
    employeeKeys.all,
    activityKeys.all,
  ],
  // Override lifecycle events (also consumed by the device push bridge).
  OVERRIDE_CREATED: [overrideKeys.all, employeeKeys.all, complianceKeys.all, activityKeys.all],
  OVERRIDE_REVOKED: [overrideKeys.all, employeeKeys.all, complianceKeys.all, activityKeys.all],
  OVERRIDE_EXPIRED: [overrideKeys.all, employeeKeys.all, complianceKeys.all, activityKeys.all],
  // Policy lifecycle events (also consumed by the device push bridge): the policy pages and everything
  // derived from the resolved policy (employee rows, compliance) refetch.
  POLICY_CHANGED: [policyQueryKeys.all, employeeKeys.all, complianceKeys.all, activityKeys.all],
  BREAK_POLICY_CHANGED: [
    breakPolicyQueryKeys.all,
    employeeKeys.all,
    complianceKeys.all,
    activityKeys.all,
  ],
};

/**
 * A known event kind without a specific entry means "something operational changed": the dashboards that
 * summarise state refetch. Kinds this UI has never heard of are ignored (see `invalidationKeysFor`).
 */
export const DEFAULT_INVALIDATION_KEYS: readonly QueryKey[] = [
  complianceKeys.all,
  employeeKeys.all,
  activityKeys.all,
];

function dedupeKeys(keys: readonly QueryKey[]): QueryKey[] {
  const seen = new Set<string>();
  const out: QueryKey[] = [];
  for (const key of keys) {
    const id = JSON.stringify(key);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(key);
  }
  return out;
}

/** Every key a realtime event can touch: refetched on the polling interval and once after a reconnect. */
export const REALTIME_ALL_KEYS: readonly QueryKey[] = dedupeKeys([
  ...Object.values(REALTIME_INVALIDATIONS).flatMap((keys) => keys ?? []),
  ...DEFAULT_INVALIDATION_KEYS,
]);

export function isRealtimeEventType(value: string): value is RealtimeEventType {
  return (REALTIME_EVENT_TYPES as readonly string[]).includes(value);
}

/** Keys to invalidate for an event type; kinds the contract does not declare are ignored (the stream never delivers them). */
export function invalidationKeysFor(type: string): readonly QueryKey[] {
  if (!isRealtimeEventType(type)) return [];
  return (
    REALTIME_INVALIDATIONS[type as RealtimeEventType | PolicyBusEventType] ??
    DEFAULT_INVALIDATION_KEYS
  );
}

/** Parses the `data:` field of an SSE frame; anything malformed is dropped rather than thrown. */
export function parseSseEvent(data: unknown): SseEvent | null {
  if (typeof data !== "string" || data.trim() === "") return null;
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = sseEventSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export interface RealtimeStatusMeta {
  readonly label: string;
  readonly description: string;
  readonly tone: "success" | "warning" | "neutral";
}

/** Shown before the stream has opened or failed for the first time (see `RealtimeContextValue.connecting`). */
export const REALTIME_CONNECTING_META: RealtimeStatusMeta = {
  label: "Connecting…",
  description: "Opening the live connection.",
  tone: "neutral",
};

export const REALTIME_STATUS_META: Record<RealtimeStatus, RealtimeStatusMeta> = {
  connected: { label: "Live", description: "Updates arrive as they happen.", tone: "success" },
  reconnecting: {
    label: "Reconnecting…",
    description: "The live connection dropped. Trying again.",
    tone: "warning",
  },
  polling: {
    label: "Refreshing every 30 s",
    description: "Live updates are unavailable right now. Data refreshes every 30 seconds.",
    tone: "neutral",
  },
};
