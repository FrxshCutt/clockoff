import type { ActivityEventType, PermissionState, SelectionState } from "@clockoff/shared/enums";
import type { StatusTone } from "@clockoff/shared/status/statusMeta";
import type { ActivityEvent } from "@clockoff/validation/activity";
import type { DeviceSummary } from "@clockoff/validation/devices";
import type {
  Employee,
  EmployeeDetail,
  EmployeeStateResponse,
} from "@clockoff/validation/employees";
import type { ResolvedPolicyRef } from "@clockoff/validation/policies";
import type { ShiftSummary } from "@clockoff/validation/refs";
import { formatDate, formatTime, toDate, type DateInput } from "@/lib/format";

/** Pure view-model helpers for the employee list and detail pages (unit tested in node). */

export function employeeFullName(employee: { firstName: string; lastName: string }): string {
  return `${employee.firstName} ${employee.lastName}`.trim();
}

// ── Resolved policy ─────────────────────────────────────────────────────────

export interface ResolvedFromDescription {
  /** Short label, e.g. "From team". */
  readonly label: string;
  /** The scope's name when it can be derived from the employee (one team / primary location). */
  readonly detail: string | null;
  /** One-line subtitle for tables, e.g. `from Team: Front of House`. */
  readonly subtitle: string;
}

/**
 * `ResolvedPolicyRef.resolvedFrom` only carries the scope type. For TEAM the team name is shown when the
 * employee belongs to exactly one team (otherwise which team won is ambiguous), for LOCATION the primary
 * location (the only location the hierarchy consults, §6.1).
 */
export function describeResolvedFrom(
  ref: Pick<ResolvedPolicyRef, "resolvedFrom"> | null,
  employee: Pick<Employee, "teams" | "primaryLocation">,
): ResolvedFromDescription | null {
  if (!ref) return null;
  switch (ref.resolvedFrom) {
    case "EMPLOYEE":
      return { label: "Employee override", detail: null, subtitle: "Employee override" };
    case "TEAM": {
      const detail = employee.teams.length === 1 ? (employee.teams[0]?.name ?? null) : null;
      return {
        label: "From team",
        detail,
        subtitle: detail ? `from Team: ${detail}` : "from Team",
      };
    }
    case "LOCATION": {
      const detail = employee.primaryLocation?.name ?? null;
      return {
        label: "From location",
        detail,
        subtitle: detail ? `from Location: ${detail}` : "from Location",
      };
    }
    case "ORGANISATION":
      return { label: "From organisation", detail: null, subtitle: "from Organisation" };
    case "DEFAULT":
      return { label: "Organisation default", detail: null, subtitle: "Organisation default" };
    default:
      return { label: "Resolved", detail: null, subtitle: String(ref.resolvedFrom) };
  }
}

// ── Next shift ──────────────────────────────────────────────────────────────

export interface NextShiftDescription {
  /** "In progress", "Today", "Tomorrow" or a formatted date. */
  readonly primary: string;
  /** Wall-clock range in the shift's zone, e.g. `09:00–17:00` (`(+1)` when it ends the next day). */
  readonly range: string;
  readonly isActive: boolean;
}

function localDayKey(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function dayDifference(a: Date, b: Date, timeZone: string): number {
  // Compare calendar days in the zone (ignores DST length changes by working on day keys).
  const [ya, ma, da] = localDayKey(a, timeZone).split("-").map(Number);
  const [yb, mb, db] = localDayKey(b, timeZone).split("-").map(Number);
  const utcA = Date.UTC(ya ?? 0, (ma ?? 1) - 1, da ?? 1);
  const utcB = Date.UTC(yb ?? 0, (mb ?? 1) - 1, db ?? 1);
  return Math.round((utcB - utcA) / 86_400_000);
}

export function describeNextShift(
  shift: Pick<ShiftSummary, "startsAt" | "endsAt" | "timezone"> | null,
  now: DateInput,
  options: { dateFormat?: "DMY" | "MDY" | "YMD" } = {},
): NextShiftDescription | null {
  const start = toDate(shift?.startsAt);
  const end = toDate(shift?.endsAt);
  const reference = toDate(now);
  if (!shift || !start || !end || !reference) return null;
  const timeZone = shift.timezone;
  const isActive = start.getTime() <= reference.getTime() && reference.getTime() < end.getTime();
  const overnight = dayDifference(start, end, timeZone);
  const range = `${formatTime(start, { timeZone })}–${formatTime(end, { timeZone })}${overnight > 0 ? ` (+${overnight})` : ""}`;
  if (isActive) return { primary: "In progress", range, isActive };
  const days = dayDifference(reference, start, timeZone);
  const primary =
    days === 0
      ? "Today"
      : days === 1
        ? "Tomorrow"
        : formatDate(start, { timeZone, dateFormat: options.dateFormat });
  return { primary, range, isActive };
}

// ── Schedule tab window ─────────────────────────────────────────────────────

export const EMPLOYEE_SCHEDULE_WINDOW = { pastDays: 1, futureDays: 14 } as const;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * `from` / `to` for `GET /api/employees/:id/shifts` on the Schedule tab: yesterday to two weeks ahead.
 * Anchored to the start of the current hour so the query key (and so the request) changes hourly, not on
 * every clock tick.
 */
export function employeeScheduleWindow(nowMs: number): { from: string; to: string } {
  const anchor = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  return {
    from: new Date(anchor - EMPLOYEE_SCHEDULE_WINDOW.pastDays * DAY_MS).toISOString(),
    to: new Date(anchor + EMPLOYEE_SCHEDULE_WINDOW.futureDays * DAY_MS).toISOString(),
  };
}

// ── Setup checklist ─────────────────────────────────────────────────────────

export interface SetupStep {
  readonly key: "invited" | "joined" | "permission" | "selection" | "connected";
  readonly label: string;
  readonly done: boolean;
  readonly hint: string;
}

export function buildSetupChecklist(
  employee: Pick<EmployeeDetail, "inviteStatus" | "device" | "latestInvite">,
): SetupStep[] {
  const status = employee.inviteStatus;
  const invited = status !== "NOT_INVITED";
  const joined = status === "JOINED" || status === "SETUP_INCOMPLETE" || status === "CONNECTED";
  const device = employee.device && employee.device.isActive ? employee.device : null;
  const permission = device?.permissionState === "APPROVED";
  const selection = device?.selectionState === "CONFIGURED";
  return [
    {
      key: "invited",
      label: "Invite sent",
      done: invited,
      hint: invited
        ? "The employee has an invite code."
        : "Create an invite and share the setup instructions.",
    },
    {
      key: "joined",
      label: "Joined from the app",
      done: joined,
      hint: joined
        ? "The employee entered the company and invite codes in the ClockOff app."
        : "Waiting for the employee to open the app and enter their codes.",
    },
    {
      key: "permission",
      label: "Screen Time authorised",
      done: permission,
      hint: permission
        ? "Screen Time authorisation is approved."
        : "The employee must approve Screen Time access when the app asks.",
    },
    {
      key: "selection",
      label: "Apps selected",
      done: selection,
      hint: selection
        ? "The employee chose what to shield on their phone."
        : "The employee picks the apps and categories to shield; the choice stays on their phone.",
    },
    {
      key: "connected",
      label: "Connected",
      done: status === "CONNECTED",
      hint:
        status === "CONNECTED"
          ? "Work Mode runs during their shifts."
          : "Completes automatically once every step above is done.",
    },
  ];
}

// ── Permission / selection guidance ─────────────────────────────────────────

export interface PermissionGuidance {
  readonly label: string;
  readonly tone: StatusTone;
  /** What the manager can do about it (never anything about device content). */
  readonly guidance: string;
}

export const PERMISSION_STATE_GUIDANCE: Record<PermissionState, PermissionGuidance> = {
  APPROVED: {
    label: "Approved",
    tone: "success",
    guidance: "Screen Time authorisation is granted. Restrictions can be applied during shifts.",
  },
  NOT_DETERMINED: {
    label: "Not asked yet",
    tone: "neutral",
    guidance:
      "The app hasn't requested Screen Time access yet. Ask the employee to open ClockOff and continue setup.",
  },
  DENIED: {
    label: "Denied",
    tone: "danger",
    guidance:
      "The employee declined Screen Time access. They can allow it in Settings → Screen Time → Apps with Screen Time access, then reopen ClockOff.",
  },
  REVOKED: {
    label: "Revoked",
    tone: "danger",
    guidance:
      "Screen Time access was removed after setup. Ask the employee to re-enable it in Settings → Screen Time, then reopen ClockOff.",
  },
  UNKNOWN: {
    label: "Unknown",
    tone: "warning",
    guidance:
      "The device hasn't reported its authorisation state yet. It updates on the next sync.",
  },
};

export const SELECTION_STATE_GUIDANCE: Record<SelectionState, PermissionGuidance> = {
  CONFIGURED: {
    label: "Configured",
    tone: "success",
    guidance:
      "The employee has chosen what to shield. Which apps they picked is never shared with ClockOff.",
  },
  NONE: {
    label: "Nothing selected",
    tone: "warning",
    guidance:
      "No apps or categories are selected yet, so nothing can be shielded. Ask the employee to finish the selection step in the app.",
  },
};

export function permissionGuidance(
  device: Pick<DeviceSummary, "permissionState" | "selectionState"> | null,
): {
  permission: PermissionGuidance;
  selection: PermissionGuidance;
} | null {
  if (!device) return null;
  return {
    permission:
      PERMISSION_STATE_GUIDANCE[device.permissionState] ?? PERMISSION_STATE_GUIDANCE.UNKNOWN,
    selection: SELECTION_STATE_GUIDANCE[device.selectionState] ?? SELECTION_STATE_GUIDANCE.NONE,
  };
}

// ── Today timeline ──────────────────────────────────────────────────────────

export type TimelineKind = "event" | "shiftStart" | "shiftEnd" | "now" | "nextTransition";

export interface TimelineEntry {
  readonly id: string;
  readonly at: string;
  readonly kind: TimelineKind;
  readonly title: string;
  readonly detail: string | null;
  readonly tone: StatusTone;
  readonly isFuture: boolean;
}

const EVENT_TONES: Partial<Record<ActivityEventType, StatusTone>> = {
  EMPLOYEE_JOINED: "success",
  SETUP_COMPLETED: "success",
  PERMISSION_GRANTED: "success",
  PERMISSION_NEEDS_ATTENTION: "danger",
  SELECTION_CONFIGURED: "success",
  WORK_MODE_STARTED: "success",
  WORK_MODE_ENDED: "neutral",
  BREAK_STARTED: "info",
  BREAK_ENDED: "info",
  BREAK_EXPIRED: "warning",
  SCHEDULE_SYNCED: "neutral",
  POLICY_SYNCED: "neutral",
  DEVICE_SYNC_DELAYED: "warning",
  POLICY_UPDATED: "neutral",
  SHIFT_CREATED: "neutral",
  SHIFT_UPDATED: "neutral",
  SHIFT_CANCELLED: "neutral",
  OVERRIDE_CREATED: "warning",
  OVERRIDE_EXPIRED: "neutral",
  POLICY_RESOLUTION_WARNING: "warning",
  EMPLOYEE_DEACTIVATED: "warning",
  EMPLOYEE_REACTIVATED: "success",
};

export function activityTone(type: ActivityEventType | string): StatusTone {
  return EVENT_TONES[type as ActivityEventType] ?? "neutral";
}

function eventEntry(event: ActivityEvent, nowMs: number): TimelineEntry {
  const detail = event.actorType === "MANAGER" && event.actor ? `by ${event.actor.name}` : null;
  return {
    id: `event:${event.id}`,
    at: event.occurredAt,
    kind: "event",
    title: event.summary,
    detail,
    tone: activityTone(event.type),
    isFuture: Date.parse(event.occurredAt) > nowMs,
  };
}

/**
 * Vertical timeline for the "Today" card: activity in the window (oldest first) plus the shift boundaries,
 * a "now" marker and the next expected transition. Sorted ascending; ties keep insertion order.
 */
export function buildTodayTimeline(
  state: Pick<EmployeeStateResponse, "timeline" | "expected" | "activeShift">,
  now: DateInput,
): TimelineEntry[] {
  const reference = toDate(now) ?? new Date(0);
  const nowMs = reference.getTime();
  const entries: TimelineEntry[] = state.timeline.map((event) => eventEntry(event, nowMs));

  const shift = state.expected.activeShift ?? state.expected.upcomingShift ?? null;
  if (shift) {
    const startMs = Date.parse(shift.startsAt);
    const endMs = Date.parse(shift.endsAt);
    entries.push({
      id: `shift-start:${shift.id}`,
      at: shift.startsAt,
      kind: "shiftStart",
      title: startMs > nowMs ? "Shift starts" : "Shift started",
      detail: "Work Mode restrictions apply from here.",
      tone: "info",
      isFuture: startMs > nowMs,
    });
    entries.push({
      id: `shift-end:${shift.id}`,
      at: shift.endsAt,
      kind: "shiftEnd",
      title: endMs > nowMs ? "Shift ends" : "Shift ended",
      detail: "Restrictions lift when the shift ends.",
      tone: "neutral",
      isFuture: endMs > nowMs,
    });
  }

  entries.push({
    id: "now",
    at: reference.toISOString(),
    kind: "now",
    title: "Now",
    detail: null,
    tone: "info",
    isFuture: false,
  });

  const next = state.expected.nextTransitionAt;
  if (
    next &&
    Date.parse(next) > nowMs &&
    !(shift && (next === shift.startsAt || next === shift.endsAt))
  ) {
    entries.push({
      id: "next-transition",
      at: next,
      kind: "nextTransition",
      title: "Next expected change",
      detail:
        "The expected state changes at this time (a break ends, an override expires or a shift boundary).",
      tone: "neutral",
      isFuture: true,
    });
  }

  return entries
    .map((entry, index) => ({ entry, index, ms: Date.parse(entry.at) }))
    .sort((a, b) => a.ms - b.ms || a.index - b.index)
    .map(({ entry }) => entry);
}

export interface ExpectedVsReported {
  readonly expected: EmployeeStateResponse["expected"]["state"];
  readonly reported: EmployeeStateResponse["reported"]["state"];
  readonly reportedAt: string | null;
  readonly diverged: boolean;
  readonly summary: string;
}

export function describeExpectedVsReported(
  state: Pick<EmployeeStateResponse, "expected" | "reported" | "diverged">,
): ExpectedVsReported {
  const reported = state.reported.state;
  let summary: string;
  if (reported === null) summary = "The device hasn't reported a state yet.";
  else if (state.diverged)
    summary = "The device's state disagrees with the schedule beyond the grace period.";
  else if (reported === state.expected.state) summary = "The device matches the expected state.";
  else summary = "The device is catching up with the expected state.";
  return {
    expected: state.expected.state,
    reported,
    reportedAt: state.reported.reportedAt,
    diverged: state.diverged,
    summary,
  };
}
