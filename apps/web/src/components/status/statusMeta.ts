import {
  BILLING_STATUSES,
  BREAK_SESSION_STATUSES,
  DEVICE_STATUS_BADGES,
  EMPLOYEE_INVITE_STATUSES,
  INTEGRATION_STATUSES,
  INVITE_STATUSES,
  POLICY_STATUSES,
  ROLES,
  SHIFT_STATUSES,
  WORK_MODE_STATES,
  type BillingStatus,
  type BreakSessionStatus,
  type DeviceStatusBadge,
  type EmployeeInviteStatus,
  type IntegrationStatus,
  type InviteStatus,
  type PolicyStatus,
  type Role,
  type ShiftStatus,
  type WorkModeState,
} from "@workmode/shared/enums";
import {
  INVITE_STATUS_META,
  STATUS_BADGE_META,
  WORK_MODE_STATE_META,
  type StatusTone,
} from "@workmode/shared/status/statusMeta";

/**
 * Pure mapping tables behind `<StatusBadge>`: every value of every status enum → label, tone, icon and a
 * one-line description. No React here so the tables are unit-testable in node. Device, invite and Work Mode
 * copy comes from `@workmode/shared` (shared with the iOS app); the rest is dashboard-only.
 */

export type { StatusTone };

export const STATUS_TONES = [
  "neutral",
  "success",
  "info",
  "warning",
  "danger",
] as const satisfies readonly StatusTone[];

/** Icon keys resolved to lucide components in `status-badge.tsx` (kept as strings so this module stays pure). */
export const STATUS_ICONS = [
  "circle",
  "circle-check",
  "circle-dashed",
  "circle-x",
  "circle-pause",
  "clock",
  "coffee",
  "shield-check",
  "shield-alert",
  "shield-off",
  "triangle-alert",
  "wifi-off",
  "refresh",
  "mail",
  "send",
  "user-check",
  "user-x",
  "user",
  "smartphone",
  "archive",
  "pencil",
  "crown",
  "key",
  "plug",
  "unplug",
  "hourglass",
  "ban",
  "help",
  "zap",
  "power",
] as const;
export type StatusIcon = (typeof STATUS_ICONS)[number];

export interface StatusBadgeMeta {
  readonly label: string;
  readonly tone: StatusTone;
  readonly icon: StatusIcon;
  readonly description: string;
}

/** Which enum a badge is rendering. */
export const STATUS_KINDS = [
  "inviteStatus",
  "deviceStatus",
  "workModeState",
  "policyStatus",
  "shiftStatus",
  "breakSessionStatus",
  "employeeInviteStatus",
  "integrationStatus",
  "role",
  "billingStatus",
] as const;
export type StatusKind = (typeof STATUS_KINDS)[number];

export interface StatusValueByKind {
  inviteStatus: InviteStatus;
  deviceStatus: DeviceStatusBadge;
  workModeState: WorkModeState;
  policyStatus: PolicyStatus;
  shiftStatus: ShiftStatus;
  breakSessionStatus: BreakSessionStatus;
  employeeInviteStatus: EmployeeInviteStatus;
  integrationStatus: IntegrationStatus;
  role: Role;
  billingStatus: BillingStatus;
}
export type StatusValue<K extends StatusKind> = StatusValueByKind[K];

/** Every enum value per kind, straight from `@workmode/shared/enums`. */
export const STATUS_ENUM_VALUES: { readonly [K in StatusKind]: readonly StatusValueByKind[K][] } = {
  inviteStatus: INVITE_STATUSES,
  deviceStatus: DEVICE_STATUS_BADGES,
  workModeState: WORK_MODE_STATES,
  policyStatus: POLICY_STATUSES,
  shiftStatus: SHIFT_STATUSES,
  breakSessionStatus: BREAK_SESSION_STATUSES,
  employeeInviteStatus: EMPLOYEE_INVITE_STATUSES,
  integrationStatus: INTEGRATION_STATUSES,
  role: ROLES,
  billingStatus: BILLING_STATUSES,
};

const INVITE_STATUS_ICONS: Record<InviteStatus, StatusIcon> = {
  NOT_INVITED: "circle-dashed",
  INVITED: "send",
  JOINED: "user-check",
  SETUP_INCOMPLETE: "triangle-alert",
  CONNECTED: "circle-check",
  DEACTIVATED: "ban",
};

const DEVICE_STATUS_ICONS: Record<DeviceStatusBadge, StatusIcon> = {
  READY: "circle-check",
  OFF_SHIFT: "circle",
  WORKING: "clock",
  WORK_MODE_ACTIVE: "shield-check",
  ON_BREAK: "coffee",
  PERMISSIONS_MISSING: "shield-alert",
  SYNC_DELAYED: "refresh",
  OFFLINE: "wifi-off",
  NEEDS_ATTENTION: "triangle-alert",
};

const WORK_MODE_STATE_ICONS: Record<WorkModeState, StatusIcon> = {
  OFF_SHIFT: "circle",
  SHIFT_STARTING_SOON: "hourglass",
  WORKING: "shield-check",
  ON_BREAK: "coffee",
  SHIFT_ENDING: "clock",
  MANAGER_OVERRIDE: "key",
  PERMISSION_ERROR: "shield-off",
  SYNC_ERROR: "refresh",
  UNKNOWN: "help",
};

function withIcons<V extends string>(
  copy: Record<
    V,
    { readonly label: string; readonly tone: StatusTone; readonly description: string }
  >,
  icons: Record<V, StatusIcon>,
): Record<V, StatusBadgeMeta> {
  const out = {} as Record<V, StatusBadgeMeta>;
  for (const key of Object.keys(copy) as V[]) {
    const entry = copy[key];
    out[key] = {
      label: entry.label,
      tone: entry.tone,
      description: entry.description,
      icon: icons[key],
    };
  }
  return out;
}

export const POLICY_STATUS_META: Record<PolicyStatus, StatusBadgeMeta> = {
  DRAFT: {
    label: "Draft",
    tone: "neutral",
    icon: "pencil",
    description: "Not published yet. Draft changes don't reach any device.",
  },
  ACTIVE: {
    label: "Active",
    tone: "success",
    icon: "shield-check",
    description: "Published. Devices it applies to use this policy during shifts.",
  },
  ARCHIVED: {
    label: "Archived",
    tone: "neutral",
    icon: "archive",
    description: "Retired. Kept for history and can no longer be assigned.",
  },
};

export const SHIFT_STATUS_META: Record<ShiftStatus, StatusBadgeMeta> = {
  SCHEDULED: {
    label: "Scheduled",
    tone: "info",
    icon: "clock",
    description: "Work Mode will switch on automatically when this shift starts.",
  },
  CANCELLED: {
    label: "Cancelled",
    tone: "neutral",
    icon: "circle-x",
    description: "This shift won't run and Work Mode won't switch on for it.",
  },
  COMPLETED: {
    label: "Completed",
    tone: "success",
    icon: "circle-check",
    description: "This shift has finished.",
  },
};

export const BREAK_SESSION_STATUS_META: Record<BreakSessionStatus, StatusBadgeMeta> = {
  ACTIVE: {
    label: "On break",
    tone: "info",
    icon: "coffee",
    description: "A break is in progress; restrictions are relaxed as the Break Rules allow.",
  },
  ENDED: {
    label: "Break ended",
    tone: "neutral",
    icon: "circle-pause",
    description: "The break has finished and Work Mode restrictions are back on.",
  },
};

export const EMPLOYEE_INVITE_STATUS_META: Record<EmployeeInviteStatus, StatusBadgeMeta> = {
  PENDING: {
    label: "Pending",
    tone: "neutral",
    icon: "circle-dashed",
    description: "The invite has been created but not sent yet.",
  },
  SENT: {
    label: "Sent",
    tone: "info",
    icon: "send",
    description: "The invite was sent. Waiting for the employee to join from the app.",
  },
  ACCEPTED: {
    label: "Accepted",
    tone: "success",
    icon: "user-check",
    description: "The employee used this invite to join.",
  },
  EXPIRED: {
    label: "Expired",
    tone: "warning",
    icon: "hourglass",
    description: "The invite expired before it was used. Send a new one.",
  },
  REVOKED: {
    label: "Revoked",
    tone: "neutral",
    icon: "ban",
    description: "The invite was cancelled and can no longer be used.",
  },
};

export const INTEGRATION_STATUS_META: Record<IntegrationStatus, StatusBadgeMeta> = {
  NOT_CONNECTED: {
    label: "Not connected",
    tone: "neutral",
    icon: "plug",
    description: "This integration hasn't been set up.",
  },
  CONNECTED: {
    label: "Connected",
    tone: "success",
    icon: "zap",
    description: "Shifts sync automatically from this provider.",
  },
  ERROR: {
    label: "Error",
    tone: "danger",
    icon: "triangle-alert",
    description: "The last sync failed. Reconnect or check the provider's settings.",
  },
  DISCONNECTED: {
    label: "Disconnected",
    tone: "warning",
    icon: "unplug",
    description: "The connection was removed. Shifts no longer sync from this provider.",
  },
};

export const ROLE_META: Record<Role, StatusBadgeMeta> = {
  OWNER: {
    label: "Owner",
    tone: "info",
    icon: "crown",
    description: "Full access, including billing and deleting the organisation.",
  },
  ADMIN: {
    label: "Admin",
    tone: "info",
    icon: "key",
    description: "Everything except billing and deleting the organisation.",
  },
  MANAGER: {
    label: "Manager",
    tone: "neutral",
    icon: "user",
    description: "Manages employees, schedules and overrides; can view policies.",
  },
};

export const BILLING_STATUS_META: Record<BillingStatus, StatusBadgeMeta> = {
  TRIAL: {
    label: "Trial",
    tone: "info",
    icon: "hourglass",
    description: "You're on a free trial. Every feature of your plan is available.",
  },
  ACTIVE: {
    label: "Active",
    tone: "success",
    icon: "circle-check",
    description: "Your subscription is active.",
  },
  PAST_DUE: {
    label: "Payment overdue",
    tone: "warning",
    icon: "triangle-alert",
    description: "The last payment failed. Update your payment details to avoid interruption.",
  },
  CANCELLED: {
    label: "Cancelled",
    tone: "neutral",
    icon: "ban",
    description: "The subscription has been cancelled.",
  },
};

export const STATUS_META: {
  readonly [K in StatusKind]: Readonly<Record<StatusValueByKind[K], StatusBadgeMeta>>;
} = {
  inviteStatus: withIcons(INVITE_STATUS_META, INVITE_STATUS_ICONS),
  deviceStatus: withIcons(STATUS_BADGE_META, DEVICE_STATUS_ICONS),
  workModeState: withIcons(WORK_MODE_STATE_META, WORK_MODE_STATE_ICONS),
  policyStatus: POLICY_STATUS_META,
  shiftStatus: SHIFT_STATUS_META,
  breakSessionStatus: BREAK_SESSION_STATUS_META,
  employeeInviteStatus: EMPLOYEE_INVITE_STATUS_META,
  integrationStatus: INTEGRATION_STATUS_META,
  role: ROLE_META,
  billingStatus: BILLING_STATUS_META,
};

function humanize(value: string): string {
  const words = value.replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Unknown";
}

/**
 * Meta for a value. Values the dashboard does not know yet (an API newer than the UI) degrade to a neutral
 * badge with a humanised label instead of crashing.
 */
export function getStatusMeta<K extends StatusKind>(
  kind: K,
  value: StatusValue<K> | string,
): StatusBadgeMeta {
  const table = STATUS_META[kind] as Readonly<Record<string, StatusBadgeMeta>>;
  const known = Object.prototype.hasOwnProperty.call(table, value) ? table[value] : undefined;
  return known ?? { label: humanize(value), tone: "neutral", icon: "help", description: "" };
}

/**
 * Tone → classes. Soft background + strong text keeps every combination at WCAG AA (≥ 4.5:1) in both themes.
 */
export const TONE_CLASSES: Record<StatusTone, string> = {
  neutral:
    "border-zinc-200 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800/80 dark:text-zinc-200",
  success:
    "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-300",
  info: "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/15 dark:text-sky-300",
  warning:
    "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300",
  danger:
    "border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-300",
};

/** Small dot colour per tone (used by compact badges and table cells). */
export const TONE_DOT_CLASSES: Record<StatusTone, string> = {
  neutral: "bg-zinc-400 dark:bg-zinc-500",
  success: "bg-emerald-500",
  info: "bg-sky-500",
  warning: "bg-amber-500",
  danger: "bg-red-500",
};
