import { z } from "zod";
import {
  ACTIVATION_MODES,
  ACTIVITY_EVENT_TYPES,
  ACTOR_TYPES,
  ASSIGNMENT_SCOPE_TYPES,
  BILLING_STATUSES,
  BREAK_END_REASONS,
  BREAK_RESTRICTION_BEHAVIOURS,
  BREAK_SESSION_STATUSES,
  CLOCK_EVENT_TYPES,
  DATE_FORMATS,
  DEVICE_REPORTABLE_EVENT_TYPES,
  DEVICE_STATUS_BADGES,
  EFFECTIVE_RESTRICTIONS,
  EMPLOYEE_INVITE_STATUSES,
  EMPLOYMENT_STATUSES,
  EXTERNAL_ENTITY_TYPES,
  INTEGRATION_AUTH_METHODS,
  INTEGRATION_CONNECTION_STATUSES,
  INTEGRATION_PROVIDERS,
  INTEGRATION_STATUSES,
  INTEGRATION_SYNC_RUN_KINDS,
  INTEGRATION_SYNC_RUN_STATUSES,
  INTEGRATION_SYNC_TRIGGERS,
  INTEGRATION_WIZARD_STEPS,
  INVITE_CHANNELS,
  INVITE_STATUSES,
  JOIN_CODE_STATUSES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_RECIPIENT_TYPES,
  ONBOARDING_SESSION_STATUSES,
  OVERRIDE_TYPES,
  PENDING_EXTERNAL_EMPLOYEE_REASONS,
  PERMISSION_STATES,
  PLANS,
  PLATFORMS,
  POLICY_STATUSES,
  RECORD_SOURCES,
  RESTRICTION_CATEGORIES,
  ROLES,
  ROTA_SOURCES,
  SELECTION_STATES,
  SHIFT_IMPORT_ROW_STATUSES,
  SHIFT_IMPORT_STATUSES,
  SHIFT_SOURCES,
  SHIFT_STATUSES,
  WORK_MODE_STATES,
  WORK_STATE_SOURCES,
} from "@clockoff/shared/enums";
import { API_ERROR_CODES } from "@clockoff/shared/errors";
import { PERMISSIONS } from "@clockoff/shared/permissions";

/**
 * Zod schemas for every domain enum. Each carries a `meta.id` so the OpenAPI generator emits one named
 * component per enum (the iOS client gets a Swift enum per type instead of inline string unions).
 */
export const billingStatusSchema = z.enum(BILLING_STATUSES).meta({ id: "BillingStatus" });
export const planSchema = z.enum(PLANS).meta({ id: "Plan" });
export const roleSchema = z.enum(ROLES).meta({ id: "Role" });
export const dateFormatSchema = z.enum(DATE_FORMATS).meta({ id: "DateFormat" });
export const joinCodeStatusSchema = z.enum(JOIN_CODE_STATUSES).meta({ id: "JoinCodeStatus" });
export const inviteChannelSchema = z.enum(INVITE_CHANNELS).meta({ id: "InviteChannel" });
export const employeeInviteStatusSchema = z
  .enum(EMPLOYEE_INVITE_STATUSES)
  .meta({ id: "EmployeeInviteStatus" });
export const employmentStatusSchema = z.enum(EMPLOYMENT_STATUSES).meta({ id: "EmploymentStatus" });
export const inviteStatusSchema = z.enum(INVITE_STATUSES).meta({ id: "InviteStatus" });
export const platformSchema = z.enum(PLATFORMS).meta({ id: "Platform" });
export const permissionStateSchema = z.enum(PERMISSION_STATES).meta({ id: "PermissionState" });
export const selectionStateSchema = z.enum(SELECTION_STATES).meta({ id: "SelectionState" });
export const workModeStateSchema = z.enum(WORK_MODE_STATES).meta({ id: "WorkModeState" });
export const effectiveRestrictionSchema = z
  .enum(EFFECTIVE_RESTRICTIONS)
  .meta({ id: "EffectiveRestriction" });
export const policyStatusSchema = z.enum(POLICY_STATUSES).meta({ id: "PolicyStatus" });
export const assignmentScopeTypeSchema = z
  .enum(ASSIGNMENT_SCOPE_TYPES)
  .meta({ id: "AssignmentScopeType" });
export const breakRestrictionBehaviourSchema = z
  .enum(BREAK_RESTRICTION_BEHAVIOURS)
  .meta({ id: "BreakRestrictionBehaviour" });
export const shiftStatusSchema = z.enum(SHIFT_STATUSES).meta({ id: "ShiftStatus" });
export const shiftSourceSchema = z.enum(SHIFT_SOURCES).meta({ id: "ShiftSource" });
export const breakEndReasonSchema = z.enum(BREAK_END_REASONS).meta({ id: "BreakEndReason" });
export const breakSessionStatusSchema = z
  .enum(BREAK_SESSION_STATUSES)
  .meta({ id: "BreakSessionStatus" });
export const workStateSourceSchema = z.enum(WORK_STATE_SOURCES).meta({ id: "WorkStateSource" });
export const shiftImportStatusSchema = z
  .enum(SHIFT_IMPORT_STATUSES)
  .meta({ id: "ShiftImportStatus" });
export const shiftImportRowStatusSchema = z
  .enum(SHIFT_IMPORT_ROW_STATUSES)
  .meta({ id: "ShiftImportRowStatus" });
export const integrationProviderSchema = z
  .enum(INTEGRATION_PROVIDERS)
  .meta({ id: "IntegrationProvider" });
export const integrationStatusSchema = z
  .enum(INTEGRATION_STATUSES)
  .meta({ id: "IntegrationStatus" });
export const activationModeSchema = z.enum(ACTIVATION_MODES).meta({ id: "ActivationMode" });
export const clockEventTypeSchema = z.enum(CLOCK_EVENT_TYPES).meta({ id: "ClockEventType" });
export const overrideTypeSchema = z.enum(OVERRIDE_TYPES).meta({ id: "OverrideType" });
export const actorTypeSchema = z.enum(ACTOR_TYPES).meta({ id: "ActorType" });
export const activityEventTypeSchema = z
  .enum(ACTIVITY_EVENT_TYPES)
  .meta({ id: "ActivityEventType" });
export const deviceReportableEventTypeSchema = z.enum(DEVICE_REPORTABLE_EVENT_TYPES).meta({
  id: "DeviceReportableEventType",
  description: "Subset of ActivityEventType a device may report.",
});
export const notificationRecipientTypeSchema = z
  .enum(NOTIFICATION_RECIPIENT_TYPES)
  .meta({ id: "NotificationRecipientType" });
export const notificationChannelSchema = z
  .enum(NOTIFICATION_CHANNELS)
  .meta({ id: "NotificationChannel" });
export const restrictionCategorySchema = z
  .enum(RESTRICTION_CATEGORIES)
  .meta({ id: "RestrictionCategory" });
export const deviceStatusBadgeSchema = z
  .enum(DEVICE_STATUS_BADGES)
  .meta({ id: "DeviceStatusBadge" });
// ── Workforce integrations (Planday; docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §2.2) ─────────────
export const rotaSourceSchema = z.enum(ROTA_SOURCES).meta({ id: "RotaSource" });
export const recordSourceSchema = z.enum(RECORD_SOURCES).meta({ id: "RecordSource" });
export const integrationAuthMethodSchema = z
  .enum(INTEGRATION_AUTH_METHODS)
  .meta({ id: "IntegrationAuthMethod" });
export const integrationConnectionStatusSchema = z
  .enum(INTEGRATION_CONNECTION_STATUSES)
  .meta({ id: "IntegrationConnectionStatus" });
export const externalEntityTypeSchema = z
  .enum(EXTERNAL_ENTITY_TYPES)
  .meta({ id: "ExternalEntityType" });
export const integrationSyncTriggerSchema = z
  .enum(INTEGRATION_SYNC_TRIGGERS)
  .meta({ id: "IntegrationSyncTrigger" });
export const integrationSyncRunStatusSchema = z
  .enum(INTEGRATION_SYNC_RUN_STATUSES)
  .meta({ id: "IntegrationSyncRunStatus" });
export const integrationSyncRunKindSchema = z
  .enum(INTEGRATION_SYNC_RUN_KINDS)
  .meta({ id: "IntegrationSyncRunKind" });
export const pendingExternalEmployeeReasonSchema = z
  .enum(PENDING_EXTERNAL_EMPLOYEE_REASONS)
  .meta({ id: "PendingExternalEmployeeReason" });
export const onboardingSessionStatusSchema = z
  .enum(ONBOARDING_SESSION_STATUSES)
  .meta({ id: "OnboardingSessionStatus" });
export const integrationWizardStepSchema = z
  .enum(INTEGRATION_WIZARD_STEPS)
  .meta({ id: "IntegrationWizardStep" });

export const apiErrorCodeSchema = z.enum(API_ERROR_CODES).meta({ id: "ApiErrorCode" });
export const permissionSchema = z.enum(PERMISSIONS).meta({ id: "Permission" });
