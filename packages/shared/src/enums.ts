/**
 * Domain enums. These mirror the Prisma enums in packages/db/prisma/schema.prisma exactly (string values),
 * but are declared here so that pure domain logic, Zod schemas, the OpenAPI document and the iOS client can
 * share them without depending on the Prisma client. Keep both in sync — `enums.test.ts` guards this.
 */

export const BILLING_STATUSES = ["TRIAL", "ACTIVE", "PAST_DUE", "CANCELLED"] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];

export const PLANS = ["STARTER", "BUSINESS", "PRO", "ENTERPRISE"] as const;
export type Plan = (typeof PLANS)[number];

export const ROLES = ["OWNER", "ADMIN", "MANAGER"] as const;
export type Role = (typeof ROLES)[number];

export const DATE_FORMATS = ["DMY", "MDY", "YMD"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export const JOIN_CODE_STATUSES = ["ACTIVE", "REVOKED"] as const;
export type JoinCodeStatus = (typeof JOIN_CODE_STATUSES)[number];

export const INVITE_CHANNELS = ["LINK", "EMAIL", "SMS"] as const;
export type InviteChannel = (typeof INVITE_CHANNELS)[number];

export const EMPLOYEE_INVITE_STATUSES = [
  "PENDING",
  "SENT",
  "ACCEPTED",
  "EXPIRED",
  "REVOKED",
] as const;
export type EmployeeInviteStatus = (typeof EMPLOYEE_INVITE_STATUSES)[number];

export const EMPLOYMENT_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

/** Employee lifecycle shown to managers (§9). */
export const INVITE_STATUSES = [
  "NOT_INVITED",
  "INVITED",
  "JOINED",
  "SETUP_INCOMPLETE",
  "CONNECTED",
  "DEACTIVATED",
] as const;
export type InviteStatus = (typeof INVITE_STATUSES)[number];

export const PLATFORMS = ["IOS"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PERMISSION_STATES = [
  "NOT_DETERMINED",
  "APPROVED",
  "DENIED",
  "REVOKED",
  "UNKNOWN",
] as const;
export type PermissionState = (typeof PERMISSION_STATES)[number];

export const SELECTION_STATES = ["NONE", "CONFIGURED"] as const;
export type SelectionState = (typeof SELECTION_STATES)[number];

/** Work Mode state machine states (§6.2). */
export const WORK_MODE_STATES = [
  "OFF_SHIFT",
  "SHIFT_STARTING_SOON",
  "WORKING",
  "ON_BREAK",
  "SHIFT_ENDING",
  "MANAGER_OVERRIDE",
  "PERMISSION_ERROR",
  "SYNC_ERROR",
  "UNKNOWN",
] as const;
export type WorkModeState = (typeof WORK_MODE_STATES)[number];

export const EFFECTIVE_RESTRICTIONS = ["WORK", "BREAK_RELAXED", "NONE"] as const;
export type EffectiveRestriction = (typeof EFFECTIVE_RESTRICTIONS)[number];

export const POLICY_STATUSES = ["DRAFT", "ACTIVE", "ARCHIVED"] as const;
export type PolicyStatus = (typeof POLICY_STATUSES)[number];

export const ASSIGNMENT_SCOPE_TYPES = ["ORGANISATION", "LOCATION", "TEAM", "EMPLOYEE"] as const;
export type AssignmentScopeType = (typeof ASSIGNMENT_SCOPE_TYPES)[number];

export const BREAK_RESTRICTION_BEHAVIOURS = [
  "RELAX_ALL",
  "RELAX_CATEGORIES",
  "KEEP_RESTRICTIONS",
] as const;
export type BreakRestrictionBehaviour = (typeof BREAK_RESTRICTION_BEHAVIOURS)[number];

export const SHIFT_STATUSES = ["SCHEDULED", "CANCELLED", "COMPLETED"] as const;
export type ShiftStatus = (typeof SHIFT_STATUSES)[number];

export const SHIFT_SOURCES = ["MANUAL", "CSV_IMPORT", "INTEGRATION"] as const;
export type ShiftSource = (typeof SHIFT_SOURCES)[number];

export const BREAK_END_REASONS = [
  "EXPIRED",
  "EMPLOYEE_ENDED",
  "SHIFT_ENDED",
  "MANAGER_ENDED",
  "POLICY_CHANGED",
] as const;
export type BreakEndReason = (typeof BREAK_END_REASONS)[number];

export const BREAK_SESSION_STATUSES = ["ACTIVE", "ENDED"] as const;
export type BreakSessionStatus = (typeof BREAK_SESSION_STATUSES)[number];

export const WORK_STATE_SOURCES = ["DEVICE_REPORT", "SERVER_COMPUTED"] as const;
export type WorkStateSource = (typeof WORK_STATE_SOURCES)[number];

export const SHIFT_IMPORT_STATUSES = [
  "UPLOADED",
  "MAPPED",
  "VALIDATED",
  "IMPORTED",
  "FAILED",
] as const;
export type ShiftImportStatus = (typeof SHIFT_IMPORT_STATUSES)[number];

export const SHIFT_IMPORT_ROW_STATUSES = [
  "VALID",
  "WARNING",
  "ERROR",
  "IMPORTED",
  "SKIPPED",
] as const;
export type ShiftImportRowStatus = (typeof SHIFT_IMPORT_ROW_STATUSES)[number];

export const INTEGRATION_PROVIDERS = [
  "PLANDAY",
  "DEPUTY",
  "SEVENSHIFTS",
  "WHEN_I_WORK",
  "ROTAREADY",
  "HOMEBASE",
] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export const INTEGRATION_STATUSES = [
  "NOT_CONNECTED",
  "CONNECTED",
  "ERROR",
  "DISCONNECTED",
] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const ACTIVATION_MODES = ["SCHEDULED", "CLOCK_EVENT"] as const;
export type ActivationMode = (typeof ACTIVATION_MODES)[number];

export const CLOCK_EVENT_TYPES = ["CLOCK_IN", "CLOCK_OUT", "BREAK_START", "BREAK_END"] as const;
export type ClockEventType = (typeof CLOCK_EVENT_TYPES)[number];

export const OVERRIDE_TYPES = [
  "EXEMPT_TEMPORARILY",
  "END_WORK_MODE_EARLY",
  "TEMPORARY_EXCEPTION",
  "EMERGENCY_POLICY_OVERRIDE",
] as const;
export type OverrideType = (typeof OVERRIDE_TYPES)[number];

export const ACTOR_TYPES = ["EMPLOYEE_DEVICE", "MANAGER", "SYSTEM"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const ACTIVITY_EVENT_TYPES = [
  "EMPLOYEE_JOINED",
  "SETUP_COMPLETED",
  "PERMISSION_GRANTED",
  "PERMISSION_NEEDS_ATTENTION",
  "SELECTION_CONFIGURED",
  "WORK_MODE_STARTED",
  "WORK_MODE_ENDED",
  "BREAK_STARTED",
  "BREAK_ENDED",
  "BREAK_EXPIRED",
  "SCHEDULE_SYNCED",
  "POLICY_SYNCED",
  "DEVICE_SYNC_DELAYED",
  "POLICY_UPDATED",
  "SHIFT_CREATED",
  "SHIFT_UPDATED",
  "SHIFT_CANCELLED",
  "OVERRIDE_CREATED",
  "OVERRIDE_EXPIRED",
  "INTEGRATION_ERROR",
  "IMPORT_COMPLETED",
  /** §6.1: policy resolution was ambiguous (e.g. multiple team assignments) — operational warning only. */
  "POLICY_RESOLUTION_WARNING",
] as const;
export type ActivityEventType = (typeof ACTIVITY_EVENT_TYPES)[number];

/** Subset of ActivityEventType a device is allowed to report (§5 POST /events, §12). */
export const DEVICE_REPORTABLE_EVENT_TYPES = [
  "SETUP_COMPLETED",
  "PERMISSION_GRANTED",
  "PERMISSION_NEEDS_ATTENTION",
  "SELECTION_CONFIGURED",
  "WORK_MODE_STARTED",
  "WORK_MODE_ENDED",
  "BREAK_STARTED",
  "BREAK_ENDED",
  "BREAK_EXPIRED",
  "SCHEDULE_SYNCED",
  "POLICY_SYNCED",
] as const satisfies readonly ActivityEventType[];
export type DeviceReportableEventType = (typeof DEVICE_REPORTABLE_EVENT_TYPES)[number];

export const NOTIFICATION_RECIPIENT_TYPES = ["MANAGER_USER", "EMPLOYEE_DEVICE"] as const;
export type NotificationRecipientType = (typeof NOTIFICATION_RECIPIENT_TYPES)[number];

export const NOTIFICATION_CHANNELS = ["IN_APP", "PUSH", "EMAIL"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** App categories a Work Policy can restrict (§3 PolicyVersion.restriction_config). */
export const RESTRICTION_CATEGORIES = [
  "SOCIAL_MEDIA",
  "GAMES",
  "ENTERTAINMENT",
  "STREAMING",
  "VIDEO",
  "SHOPPING",
  "DATING",
  "OTHER_SELECTED",
] as const;
export type RestrictionCategory = (typeof RESTRICTION_CATEGORIES)[number];

export const RESTRICTION_CATEGORY_LABELS: Record<RestrictionCategory, string> = {
  SOCIAL_MEDIA: "Social Media",
  GAMES: "Games",
  ENTERTAINMENT: "Entertainment",
  STREAMING: "Streaming",
  VIDEO: "Video",
  SHOPPING: "Shopping",
  DATING: "Dating",
  OTHER_SELECTED: "Other selected apps",
};

/** Derived device/work status badge shown to managers (§9). Not stored — computed by `deriveDeviceStatus`. */
export const DEVICE_STATUS_BADGES = [
  "READY",
  "OFF_SHIFT",
  "WORKING",
  "WORK_MODE_ACTIVE",
  "ON_BREAK",
  "PERMISSIONS_MISSING",
  "SYNC_DELAYED",
  "OFFLINE",
  "NEEDS_ATTENTION",
] as const;
export type DeviceStatusBadge = (typeof DEVICE_STATUS_BADGES)[number];
