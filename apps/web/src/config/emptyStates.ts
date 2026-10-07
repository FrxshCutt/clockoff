import type { LucideIcon } from "lucide-react";
import {
  Activity,
  BellOff,
  CalendarClock,
  Coffee,
  FileUp,
  LayoutDashboard,
  MapPin,
  Plug,
  ScrollText,
  SearchX,
  ShieldCheck,
  Smartphone,
  UserPlus,
  Users,
} from "lucide-react";
import { ROUTES } from "./navigation";

/**
 * Empty-state copy for every list in the dashboard. Copy marked "spec" is quoted verbatim from the product
 * spec; keep it unchanged. Pages render these through `<EmptyState>` so wording lives in one place.
 */
export interface EmptyStateCopy {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly description: string;
  /** Primary call to action. `href` is omitted while the destination flow is still being built. */
  readonly action?: { readonly label: string; readonly href?: string };
  readonly secondaryAction?: { readonly label: string; readonly href?: string };
}

export const EMPTY_STATES = {
  overview: {
    icon: LayoutDashboard,
    title: "Live status appears once shifts begin",
    description:
      "When employees have connected their phones and a shift starts, you'll see who is in Work Mode, on a break or needs attention.",
    action: { label: "Add Employee", href: ROUTES.employees },
  },
  // spec: NO EMPLOYEES
  employees: {
    icon: Users,
    title: "No employees yet",
    description: "Add your first employee to begin setting up distraction-free shifts.",
    action: { label: "Add Employee" },
  },
  employeeDetail: {
    icon: Users,
    title: "Employee details",
    description:
      "Profile, invite status, device connection and upcoming shifts for this employee will appear here.",
    action: { label: "Back to employees", href: ROUTES.employees },
  },
  schedule: {
    icon: CalendarClock,
    title: "No shifts scheduled",
    description: "Add shifts or import your rota so each phone knows when to switch Work Mode on.",
    action: { label: "Import Schedule", href: ROUTES.scheduleImport },
    secondaryAction: { label: "Add Shift" },
  },
  scheduleImport: {
    icon: FileUp,
    title: "Import your rota",
    description:
      "Upload a CSV of shifts. Every row is checked before anything is saved, so you can fix problems first.",
    action: { label: "Upload CSV" },
    secondaryAction: { label: "Back to schedule", href: ROUTES.schedule },
  },
  // spec: NO POLICY
  policies: {
    icon: ShieldCheck,
    title: "No Work Policy yet",
    description: "Create a Work Policy to decide which distractions are restricted during shifts.",
    action: { label: "Create Policy", href: ROUTES.policyNew },
  },
  policiesAllArchived: {
    icon: ShieldCheck,
    title: "No active policies",
    description:
      "Every Work Policy is archived. Show archived policies to duplicate one, or create a new policy.",
    action: { label: "Create Policy", href: ROUTES.policyNew },
  },
  policyNew: {
    icon: ShieldCheck,
    title: "Create a Work Policy",
    description:
      "Choose which categories of apps are restricted during shifts, then assign the policy to your organisation, a location, a team or an employee.",
    action: { label: "Back to policies", href: ROUTES.policies },
  },
  policyDetail: {
    icon: ShieldCheck,
    title: "Policy details",
    description:
      "Restricted categories, assignments and version history for this Work Policy will appear here.",
    action: { label: "Back to policies", href: ROUTES.policies },
  },
  breakRules: {
    icon: Coffee,
    title: "No Break Rules yet",
    description:
      "Set how long breaks last and what relaxes during them, so employees can step away without switching Work Mode off.",
    action: { label: "Create Break Rules", href: ROUTES.breakRuleNew },
  },
  breakRuleNew: {
    icon: Coffee,
    title: "Create Break Rules",
    description:
      "Set how long breaks last, how often they can be taken and what relaxes during them.",
    action: { label: "Back to Break Rules", href: ROUTES.breakRules },
  },
  breakRuleDetail: {
    icon: Coffee,
    title: "Break Rules details",
    description: "Break length, frequency and what relaxes during a break will appear here.",
    action: { label: "Back to Break Rules", href: ROUTES.breakRules },
  },
  integrations: {
    icon: Plug,
    title: "No integrations connected",
    description:
      "Connect your rota software to keep shifts in sync automatically. CSV import works in the meantime.",
    action: { label: "Import a CSV instead", href: ROUTES.scheduleImport },
  },
  activity: {
    icon: Activity,
    title: "No activity yet",
    description:
      "Employees joining, finishing setup, starting Work Mode and taking breaks will show up here as it happens.",
  },
  locations: {
    icon: MapPin,
    title: "No locations or teams yet",
    description:
      "Add locations and teams to assign policies and schedules to the right people at once.",
    action: { label: "Add Location" },
  },
  devices: {
    icon: Smartphone,
    title: "No devices connected",
    description: "Devices appear here once employees join from the ClockOff app on their iPhone.",
    action: { label: "Go to employees", href: ROUTES.employees },
  },
  deviceDetail: {
    icon: Smartphone,
    title: "Device details",
    description:
      "Connection, Screen Time permission and sync status for this device will appear here.",
    action: { label: "Back to devices", href: ROUTES.devices },
  },
  auditLogs: {
    icon: ScrollText,
    title: "No audit entries yet",
    description:
      "Changes managers make to employees, policies, schedules and settings are recorded here.",
  },
  members: {
    icon: UserPlus,
    title: "No other managers yet",
    description: "Invite owners, admins or managers to help run schedules and policies.",
    action: { label: "Invite Manager" },
  },
  notifications: {
    icon: BellOff,
    title: "You're all caught up",
    description: "Alerts about devices, breaks and integrations will appear here.",
  },
  search: {
    icon: SearchX,
    title: "No matching results",
    description: "Try a different search or clear the filters.",
  },
} as const satisfies Record<string, EmptyStateCopy>;

export type EmptyStateKey = keyof typeof EMPTY_STATES;
