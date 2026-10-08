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
  /** Workforce integrations (Planday): connection lifecycle and sync outcomes, organisation-level. */
  "INTEGRATION_CONNECTED",
  "INTEGRATION_DISCONNECTED",
  "INTEGRATION_SYNCED",
  /** An integration deactivated or reactivated an employee (Planday deactivation / reactivation). */
  "EMPLOYEE_DEACTIVATED",
  "EMPLOYEE_REACTIVATED",
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

/**
 * Activity types only a workforce integration records (Planday connect, disconnect and sync, and its employee
 * deactivations and reactivations; a manager's own deactivation records none). The dashboard leaves them out of
 * its type filters while Planday is switched off (`plandayEnabled` on `GET /api/auth/me`, plan §0).
 */
export const INTEGRATION_ACTIVITY_EVENT_TYPES = [
  "INTEGRATION_CONNECTED",
  "INTEGRATION_DISCONNECTED",
  "INTEGRATION_SYNCED",
  "EMPLOYEE_DEACTIVATED",
  "EMPLOYEE_REACTIVATED",
] as const satisfies readonly ActivityEventType[];

export function isIntegrationActivityEventType(type: string): boolean {
  return (INTEGRATION_ACTIVITY_EVENT_TYPES as readonly string[]).includes(type);
}

// ── Workforce integrations (Planday; docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §2.2) ─────────────

/** How the organisation schedules its team (onboarding question). Null until answered. */
export const ROTA_SOURCES = [
  "PLANDAY",
  "DEPUTY",
  "SEVENSHIFTS",
  "WHEN_I_WORK",
  "ROTAREADY",
  "HOMEBASE",
  "CSV",
  "MANUAL",
  "OTHER",
] as const;
export type RotaSource = (typeof ROTA_SOURCES)[number];

/** Provenance of an Employee / Location / Team row. Shift keeps its own ShiftSource. */
export const RECORD_SOURCES = ["MANUAL", "CSV_IMPORT", "INTEGRATION"] as const;
export type RecordSource = (typeof RECORD_SOURCES)[number];

/** How a Planday connection was made: A (OAuth), B (customer added ClockOff's App ID), C (customer's own app). */
export const INTEGRATION_AUTH_METHODS = [
  "OAUTH",
  "CUSTOMER_ADDED_APP_ID",
  "CUSTOMER_OWN_APP",
] as const;
export type IntegrationAuthMethod = (typeof INTEGRATION_AUTH_METHODS)[number];

/** Fine-grained connection state. `Integration.status` keeps the coarse IntegrationStatus. */
export const INTEGRATION_CONNECTION_STATUSES = [
  "CONNECTING",
  "CONNECTED",
  "SYNCING",
  "DEGRADED",
  "AUTH_ERROR",
  "DISCONNECTED",
] as const;
export type IntegrationConnectionStatus = (typeof INTEGRATION_CONNECTION_STATUSES)[number];

export const EXTERNAL_ENTITY_TYPES = [
  "EMPLOYEE",
  "LOCATION",
  "DEPARTMENT",
  "TEAM",
  "SHIFT",
] as const;
export type ExternalEntityType = (typeof EXTERNAL_ENTITY_TYPES)[number];

export const INTEGRATION_SYNC_TRIGGERS = ["INITIAL", "SCHEDULED", "MANUAL", "RECOVERY"] as const;
export type IntegrationSyncTrigger = (typeof INTEGRATION_SYNC_TRIGGERS)[number];

export const INTEGRATION_SYNC_RUN_STATUSES = ["RUNNING", "SUCCEEDED", "PARTIAL", "FAILED"] as const;
export type IntegrationSyncRunStatus = (typeof INTEGRATION_SYNC_RUN_STATUSES)[number];

/** What a sync run does (plan §7.2). SYNC is the ordinary full sync. */
export const INTEGRATION_SYNC_RUN_KINDS = [
  "STRUCTURE",
  "DIRECTORY",
  "IMPORT_EMPLOYEES",
  "SYNC",
  "CLOCK",
] as const;
export type IntegrationSyncRunKind = (typeof INTEGRATION_SYNC_RUN_KINDS)[number];

export const PENDING_EXTERNAL_EMPLOYEE_REASONS = [
  "ONBOARDING",
  "NEW_EMPLOYEE",
  "AMBIGUOUS_MATCH",
  /** One weak candidate (exact name only, or a raw CSV id nothing corroborates): the manager confirms. */
  "POSSIBLE_MATCH",
  "PLAN_LIMIT",
  /** A mapped employee Planday stopped returning without positive deactivation evidence for 24 h. */
  "MISSING_IN_PLANDAY",
] as const;
export type PendingExternalEmployeeReason = (typeof PENDING_EXTERNAL_EMPLOYEE_REASONS)[number];

export const ONBOARDING_SESSION_STATUSES = ["ACTIVE", "COMPLETED", "ABANDONED"] as const;
export type OnboardingSessionStatus = (typeof ONBOARDING_SESSION_STATUSES)[number];

/** The nine Planday wizard steps, in order (the page's `?step=` is the kebab-case spelling). */
export const INTEGRATION_WIZARD_STEPS = [
  "CONNECT",
  "CONFIRM_PORTAL",
  "LOCATIONS",
  "TEAMS",
  "EMPLOYEES",
  "SHIFT_PREVIEW",
  "POLICIES",
  "ACTIVATION",
  "FINISH",
] as const;
export type IntegrationWizardStep = (typeof INTEGRATION_WIZARD_STEPS)[number];

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
