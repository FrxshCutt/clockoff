import { publishEvent } from "@/server/events";
import { ensureOrganisationBridged } from "@/server/realtime/pushBridge";

/**
 * Realtime bus events for policy changes. Devices (via the push bridge) and the dashboard refetch on them;
 * payloads carry ids and counts only (§12). `POLICY_CHANGED` / `BREAK_POLICY_CHANGED` are the kinds the
 * push bridge keys on; both are listed in `REALTIME_EVENT_TYPES` (server and validation copies) so the
 * dashboard's SSE client subscribes to them as well. The older `policy.changed` kind stays listed for
 * compatibility but is not published here.
 *
 * The in-process bus has no wildcard subscription, so the organisation is bridged to the push provider
 * before publishing — otherwise a change made from a web worker that has never served one of this
 * organisation's devices or dashboard streams would reach no phone.
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
  ensureOrganisationBridged(event.organisationId);
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
  ensureOrganisationBridged(event.organisationId);
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
