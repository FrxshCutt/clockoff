import type { StatusTone } from "@workmode/shared/status/statusMeta";
import {
  COMPLIANCE_METRIC_FILTER,
  COMPLIANCE_METRIC_KEYS,
  type ComplianceEmployeeRow,
  type ComplianceMetricKey,
  type UpcomingShift,
} from "@workmode/validation/compliance";
import { complianceListHref } from "@/components/activity/activity-filters";
import { EMPLOYEE_URL_PARAMS, type EmployeeQuickFilter } from "@/components/employees/employee-filters";
import { ROUTES } from "@/config/navigation";
import { humanizeEnum, toDate, type DateInput } from "@/lib/format";

/** Pure view-model helpers for the overview page (unit tested in node). */

// ── Metric cards ────────────────────────────────────────────────────────────

/** Icon keys resolved to lucide components in `metric-cards.tsx`. */
export const METRIC_ICONS = [
  "users",
  "circle-check",
  "hourglass",
  "shield-alert",
  "clock",
  "shield-check",
  "coffee",
  "triangle-alert",
] as const;
export type MetricIcon = (typeof METRIC_ICONS)[number];

export interface MetricCardMeta {
  readonly key: ComplianceMetricKey;
  readonly label: string;
  readonly description: string;
  readonly icon: MetricIcon;
}

export const METRIC_CARDS: readonly MetricCardMeta[] = [
  { key: "totalEmployees", label: "Total employees", description: "Active employees in your organisation.", icon: "users" },
  { key: "connected", label: "Connected", description: "Phones set up and ready to enforce Work Mode.", icon: "circle-check" },
  { key: "awaitingSetup", label: "Awaiting setup", description: "Invited or joined, but not finished setting up.", icon: "hourglass" },
  { key: "missingPermissions", label: "Missing permissions", description: "Screen Time access denied or revoked.", icon: "shield-alert" },
  { key: "workingNow", label: "Working now", description: "Expected to be on shift right now.", icon: "clock" },
  { key: "workModeActive", label: "Work Mode active", description: "Phones confirming restrictions are on.", icon: "shield-check" },
  { key: "onBreak", label: "On break", description: "Breaks in progress right now.", icon: "coffee" },
  { key: "needsAttention", label: "Needs attention", description: "On shift with a permission, sync or state problem.", icon: "triangle-alert" },
];

/**
 * Where a metric card leads. The employees list has quick filters that count the same rows for most
 * metrics; "Work Mode active" (phones *confirming* restrictions) has no employees-list equivalent, so it
 * opens the Compliance tab with the exact API filter the metric is defined by.
 */
const EMPLOYEE_QUICK_FILTER_FOR_METRIC: Record<ComplianceMetricKey, EmployeeQuickFilter | "all" | null> = {
  totalEmployees: "all",
  connected: "connected",
  awaitingSetup: "awaitingSetup",
  missingPermissions: "permissionsMissing",
  workingNow: "working",
  workModeActive: null,
  onBreak: "onBreak",
  needsAttention: "needsAttention",
};

export function metricHref(key: ComplianceMetricKey): string {
  const quick = EMPLOYEE_QUICK_FILTER_FOR_METRIC[key];
  if (quick === "all") return ROUTES.employees;
  if (quick) return `${ROUTES.employees}?${EMPLOYEE_URL_PARAMS.filter}=${quick}`;
  return complianceListHref(COMPLIANCE_METRIC_FILTER[key]);
}

const METRIC_TONES: Record<ComplianceMetricKey, StatusTone> = {
  totalEmployees: "neutral",
  connected: "success",
  awaitingSetup: "warning",
  missingPermissions: "danger",
  workingNow: "info",
  workModeActive: "success",
  onBreak: "info",
  needsAttention: "danger",
};

/** Tone for a metric's value: zero is always neutral (nothing to act on). */
export function metricValueTone(key: ComplianceMetricKey, value: number): StatusTone {
  return value > 0 ? METRIC_TONES[key] : "neutral";
}

export function isComplianceMetricKey(value: unknown): value is ComplianceMetricKey {
  return typeof value === "string" && (COMPLIANCE_METRIC_KEYS as readonly string[]).includes(value);
}

// ── Upcoming shifts ─────────────────────────────────────────────────────────

export const UPCOMING_SHIFT_WINDOW_HOURS = 12;

/** Shifts that have not ended and start within the next `hours`, soonest first. */
export function upcomingShiftsWithin(
  shifts: readonly UpcomingShift[],
  now: DateInput,
  hours: number = UPCOMING_SHIFT_WINDOW_HOURS,
): UpcomingShift[] {
  const reference = toDate(now);
  if (!reference) return [];
  const horizon = reference.getTime() + hours * 3_600_000;
  return shifts
    .filter((entry) => {
      const start = toDate(entry.shift.startsAt);
      const end = toDate(entry.shift.endsAt);
      return !!start && !!end && start.getTime() <= horizon && end.getTime() > reference.getTime();
    })
    .sort((a, b) => Date.parse(a.shift.startsAt) - Date.parse(b.shift.startsAt));
}

// ── Awaiting setup ──────────────────────────────────────────────────────────

export type SetupStage = "notInvited" | "invited" | "joined" | "setupIncomplete" | "other";

export interface AwaitingSetupDescription {
  readonly stage: SetupStage;
  /** e.g. "Invite sent · waiting for them to join", "Permission missing". */
  readonly statusText: string;
  readonly tone: StatusTone;
  /** Secondary line (the badge's reason), when there is one. */
  readonly detail: string | null;
  /** "invite" (no invite yet), "resend" (invite outstanding) or null once the employee has joined. */
  readonly inviteAction: "invite" | "resend" | null;
  /** Copying the setup instructions makes sense until the employee has joined. */
  readonly canCopyInvite: boolean;
}

export function describeAwaitingSetup(
  row: Pick<ComplianceEmployeeRow, "employee" | "deviceStatus" | "permissionState" | "selectionState" | "attentionReason">,
): AwaitingSetupDescription {
  const detail = row.attentionReason?.trim() || row.deviceStatus?.reason?.trim() || null;
  switch (row.employee.inviteStatus) {
    case "NOT_INVITED":
      return { stage: "notInvited", statusText: "Not invited yet", tone: "neutral", detail, inviteAction: "invite", canCopyInvite: true };
    case "INVITED":
      return {
        stage: "invited",
        statusText: "Invite sent · waiting for them to join",
        tone: "info",
        detail,
        inviteAction: "resend",
        canCopyInvite: true,
      };
    case "JOINED":
      return {
        stage: "joined",
        statusText: "Joined · Screen Time setup not started",
        tone: "info",
        detail,
        inviteAction: null,
        canCopyInvite: false,
      };
    case "SETUP_INCOMPLETE": {
      const permission = row.permissionState;
      if (permission === "DENIED" || permission === "REVOKED") {
        return { stage: "setupIncomplete", statusText: "Permission missing", tone: "danger", detail, inviteAction: null, canCopyInvite: false };
      }
      if (permission === "APPROVED" && row.selectionState === "NONE") {
        return {
          stage: "setupIncomplete",
          statusText: "Joined · no apps selected yet",
          tone: "warning",
          detail,
          inviteAction: null,
          canCopyInvite: false,
        };
      }
      if (permission === "NOT_DETERMINED" || permission === "UNKNOWN" || permission === null) {
        return {
          stage: "setupIncomplete",
          statusText: "Joined · permission not granted yet",
          tone: "warning",
          detail,
          inviteAction: null,
          canCopyInvite: false,
        };
      }
      return { stage: "setupIncomplete", statusText: "Joined · setup incomplete", tone: "warning", detail, inviteAction: null, canCopyInvite: false };
    }
    default:
      return {
        stage: "other",
        statusText: humanizeEnum(row.employee.inviteStatus),
        tone: "neutral",
        detail,
        inviteAction: null,
        canCopyInvite: false,
      };
  }
}
