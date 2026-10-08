import { publishEvent } from "@/server/events";

/**
 * Realtime bus events for policy changes. Devices (via the push bridge) and the dashboard refetch on them;
 * payloads carry ids and counts only (§12). `POLICY_CHANGED` / `BREAK_POLICY_CHANGED` are the kinds the
 * push bridge keys on; both are listed in `REALTIME_EVENT_TYPES` (server and validation copies) so the
 * dashboard's SSE client subscribes to them as well. The older `policy.changed` kind stays listed for
 * compatibility but is not published here.
 *
 * The bus carries these events to every process; the worker that leads the push bridge turns them into
 * silent pushes, wherever they were published.
 */
export const POLICY_EVENT_TYPES = {
  policyChanged: "POLICY_CHANGED",
  breakPolicyChanged: "BREAK_POLICY_CHANGED",
} as const;

export type PolicyChangeReason = "PUBLISHED" | "ASSIGNED" | "UNASSIGNED" | "DEFAULT_CHANGED";
export type BreakPolicyChangeReason =
  "RULES_CHANGED" | "ASSIGNED" | "UNASSIGNED" | "DEFAULT_CHANGED";

export interface PolicyChangedEvent {
  organisationId: string;
  /** Null when the organisation default was cleared. */
  policyId: string | null;
  reason: PolicyChangeReason;
  affectedEmployeeIds: readonly string[];
  versionId?: string;
  versionNumber?: number;
}

export function publishPolicyChanged(event: PolicyChangedEvent): void {
  publishEvent({
    type: POLICY_EVENT_TYPES.policyChanged,
    organisationId: event.organisationId,
    payload: {
      policyId: event.policyId,
      reason: event.reason,
      affectedEmployeeIds: [...event.affectedEmployeeIds],
      affectedEmployeeCount: event.affectedEmployeeIds.length,
      ...(event.versionId !== undefined ? { versionId: event.versionId } : {}),
      ...(event.versionNumber !== undefined ? { versionNumber: event.versionNumber } : {}),
    },
  });
}

export interface BreakPolicyChangedEvent {
  organisationId: string;
  breakPolicyId: string | null;
  reason: BreakPolicyChangeReason;
  affectedEmployeeIds: readonly string[];
}

export function publishBreakPolicyChanged(event: BreakPolicyChangedEvent): void {
  publishEvent({
    type: POLICY_EVENT_TYPES.breakPolicyChanged,
    organisationId: event.organisationId,
    payload: {
      breakPolicyId: event.breakPolicyId,
      reason: event.reason,
      affectedEmployeeIds: [...event.affectedEmployeeIds],
      affectedEmployeeCount: event.affectedEmployeeIds.length,
    },
  });
}
