import { publishEvent } from "@/server/events";

/**
 * Schedule change notifications. Every shift mutation (create, update, cancel, delete, bulk action, CSV
 * commit, recurrence materialisation) publishes ONE `SCHEDULE_CHANGED` event per affected employee on the
 * organisation bus. The device push bridge turns it into a silent push so the employee's iPhone re-syncs
 * its schedule; the dashboard SSE stream receives it as well (payloads are ids only — §12).
 *
 * `shift.changed` (one of the documented REALTIME_EVENT_TYPES) is published alongside with the same
 * payload as a cache-invalidation hint for the web dashboard.
 */
export const SCHEDULE_CHANGED_EVENT = "SCHEDULE_CHANGED" as const;

export const SCHEDULE_CHANGE_REASONS = [
  "CREATED",
  "UPDATED",
  "CANCELLED",
  "DELETED",
  "IMPORTED",
  "MATERIALISED",
] as const;
export type ScheduleChangeReason = (typeof SCHEDULE_CHANGE_REASONS)[number];

export interface ScheduleChangedPayload {
  employeeId: string;
  /** Shifts created, changed, cancelled or removed by the action. */
  shiftIds: string[];
  reason: ScheduleChangeReason;
}

export function publishScheduleChanged(
  organisationId: string,
  payload: ScheduleChangedPayload,
): void {
  if (payload.shiftIds.length === 0) return;
  const body = {
    employeeId: payload.employeeId,
    shiftIds: [...payload.shiftIds],
    reason: payload.reason,
  };
  publishEvent({
    type: SCHEDULE_CHANGED_EVENT,
    organisationId,
    employeeId: payload.employeeId,
    payload: body,
  });
  publishEvent({
    type: "shift.changed",
    organisationId,
    employeeId: payload.employeeId,
    payload: body,
  });
}

/** Groups shifts by employee and publishes one event per employee. */
export function publishScheduleChangedForShifts(
  organisationId: string,
  shifts: ReadonlyArray<{ id: string; employeeId: string }>,
  reason: ScheduleChangeReason,
): void {
  const byEmployee = new Map<string, string[]>();
  for (const shift of shifts) {
    const list = byEmployee.get(shift.employeeId) ?? [];
    list.push(shift.id);
    byEmployee.set(shift.employeeId, list);
  }
  for (const [employeeId, shiftIds] of byEmployee) {
    publishScheduleChanged(organisationId, { employeeId, shiftIds, reason });
  }
}
