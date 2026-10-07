import { ACTIVITY_EVENT_TYPES, type ActivityEventType } from "@clockoff/shared/enums";
import type { ActivityEvent } from "@clockoff/validation/activity";
import { humanizeEnum } from "@/lib/format";

/** Pure helpers for the employee activity feed (unit tested in node). */

/** Friendly names for the type filter; anything not listed falls back to `humanizeEnum`. */
export const ACTIVITY_TYPE_LABELS: Partial<Record<ActivityEventType, string>> = {
  EMPLOYEE_JOINED: "Joined from the app",
  SETUP_COMPLETED: "Setup completed",
  PERMISSION_GRANTED: "Screen Time permission granted",
  PERMISSION_NEEDS_ATTENTION: "Permission needs attention",
  SELECTION_CONFIGURED: "Apps selected",
  WORK_MODE_STARTED: "Work Mode started",
  WORK_MODE_ENDED: "Work Mode ended",
  BREAK_STARTED: "Break started",
  BREAK_ENDED: "Break ended",
  BREAK_EXPIRED: "Break expired",
  SCHEDULE_SYNCED: "Schedule synced",
  POLICY_SYNCED: "Policy synced",
  DEVICE_SYNC_DELAYED: "Device sync delayed",
  POLICY_UPDATED: "Policy updated",
  SHIFT_CREATED: "Shift created",
  SHIFT_UPDATED: "Shift updated",
  SHIFT_CANCELLED: "Shift cancelled",
  OVERRIDE_CREATED: "Override created",
  OVERRIDE_EXPIRED: "Override expired",
  POLICY_RESOLUTION_WARNING: "Policy resolution warning",
};

export function activityTypeLabel(type: string): string {
  return ACTIVITY_TYPE_LABELS[type as ActivityEventType] ?? humanizeEnum(type);
}

export interface ActivityTypeOption {
  readonly id: ActivityEventType;
  readonly name: string;
}

/** Every event type as a select option, alphabetical by label. */
export const ACTIVITY_TYPE_OPTIONS: readonly ActivityTypeOption[] = [...ACTIVITY_EVENT_TYPES]
  .map((type) => ({ id: type, name: activityTypeLabel(type) }))
  .sort((a, b) => a.name.localeCompare(b.name));

export function isActivityEventType(value: unknown): value is ActivityEventType {
  return typeof value === "string" && (ACTIVITY_EVENT_TYPES as readonly string[]).includes(value);
}

export interface ActivityDayGroup {
  /** `YYYY-MM-DD` in the display zone. */
  readonly day: string;
  /** First instant of the group (used to label it). */
  readonly at: string;
  readonly events: readonly ActivityEvent[];
}

function dayKey(instant: string, timeZone: string | undefined): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return "invalid";
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Groups a newest-first feed into calendar days in `timeZone`, preserving order. Duplicate ids (a page
 * boundary refetched after a new event arrived) are dropped.
 */
export function groupActivityByDay(
  events: readonly ActivityEvent[],
  timeZone: string | undefined,
): ActivityDayGroup[] {
  const groups: { day: string; at: string; events: ActivityEvent[] }[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    const day = dayKey(event.occurredAt, timeZone);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.events.push(event);
    else groups.push({ day, at: event.occurredAt, events: [event] });
  }
  return groups;
}

/** "Device", "Jane Smith" (manager) or "ClockOff" (system) — who caused the event. */
export function describeActor(event: Pick<ActivityEvent, "actorType" | "actor">): string {
  switch (event.actorType) {
    case "MANAGER":
      return event.actor?.name ?? "A manager";
    case "EMPLOYEE_DEVICE":
      return "Device";
    case "SYSTEM":
      return "ClockOff";
    default:
      return humanizeEnum(String(event.actorType));
  }
}
