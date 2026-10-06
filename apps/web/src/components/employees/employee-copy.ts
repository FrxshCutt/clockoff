import type { LucideIcon } from "lucide-react";
import { Activity, CalendarClock, KeyRound, Send, Users } from "lucide-react";
import type { EmptyStateCopy } from "@/config/emptyStates";

/**
 * Copy owned by the employee pages that has no entry in `@/config/emptyStates` (sub-lists on the detail
 * page). The page-level copy (`employees`, `employeeDetail`, `search`, `activity`) comes from the config.
 */
export const EMPLOYEE_EMPTY_STATES = {
  shifts: {
    icon: CalendarClock,
    title: "No upcoming shifts",
    description: "Add a shift so this employee's phone knows when Work Mode should switch on.",
    action: { label: "Add shift" },
  },
  invites: {
    icon: Send,
    title: "Not invited yet",
    description: "Create an invite to get the employee's personal code and setup steps to share.",
    action: { label: "Create invite" },
  },
  overrides: {
    icon: KeyRound,
    title: "No overrides",
    description:
      "Overrides let you lift or relax Work Mode for a while, with a reason that is kept on record.",
    action: { label: "Create override" },
  },
  activity: {
    icon: Activity,
    title: "No activity yet",
    description:
      "Joining, finishing setup, Work Mode starting and breaks will appear here as they happen.",
  },
  picker: {
    icon: Users,
    title: "No employees found",
    description: "Try a different name, email or employee ID.",
  },
} as const satisfies Record<string, EmptyStateCopy & { icon: LucideIcon }>;

export const EMPLOYEE_TABS = [
  "overview",
  "schedule",
  "policy",
  "activity",
  "invites",
  "overrides",
] as const;
export type EmployeeTab = (typeof EMPLOYEE_TABS)[number];
export const DEFAULT_EMPLOYEE_TAB: EmployeeTab = "overview";

export const EMPLOYEE_TAB_META: Record<EmployeeTab, { label: string; description: string }> = {
  overview: {
    label: "Overview",
    description: "Connection, permissions, setup progress, sync and what is happening today.",
  },
  schedule: { label: "Schedule", description: "Upcoming shifts for this employee." },
  policy: {
    label: "Policy",
    description: "The Work Policy and Break Rules that apply, and employee-level overrides.",
  },
  activity: {
    label: "Activity",
    description: "Operational events for this employee, newest first.",
  },
  invites: {
    label: "Invites",
    description: "Invite codes, their status and the setup instructions to share.",
  },
  overrides: {
    label: "Overrides",
    description: "Temporary exemptions and relaxations a manager has applied.",
  },
};

export function isEmployeeTab(value: unknown): value is EmployeeTab {
  return typeof value === "string" && (EMPLOYEE_TABS as readonly string[]).includes(value);
}

export function parseEmployeeTab(value: string | null | undefined): EmployeeTab {
  return isEmployeeTab(value) ? value : DEFAULT_EMPLOYEE_TAB;
}
