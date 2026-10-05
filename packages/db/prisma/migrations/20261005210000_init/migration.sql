-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateEnum
CREATE TYPE "BillingStatus" AS ENUM ('TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('STARTER', 'BUSINESS', 'PRO', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'MANAGER');

-- CreateEnum
CREATE TYPE "DateFormat" AS ENUM ('DMY', 'MDY', 'YMD');

-- CreateEnum
CREATE TYPE "JoinCodeStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "InviteChannel" AS ENUM ('LINK', 'EMAIL', 'SMS');

-- CreateEnum
CREATE TYPE "EmployeeInviteStatus" AS ENUM ('PENDING', 'SENT', 'ACCEPTED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "EmploymentStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "InviteStatus" AS ENUM ('NOT_INVITED', 'INVITED', 'JOINED', 'SETUP_INCOMPLETE', 'CONNECTED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('IOS');

-- CreateEnum
CREATE TYPE "PermissionState" AS ENUM ('NOT_DETERMINED', 'APPROVED', 'DENIED', 'REVOKED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SelectionState" AS ENUM ('NONE', 'CONFIGURED');

-- CreateEnum
CREATE TYPE "WorkModeState" AS ENUM ('OFF_SHIFT', 'SHIFT_STARTING_SOON', 'WORKING', 'ON_BREAK', 'SHIFT_ENDING', 'MANAGER_OVERRIDE', 'PERMISSION_ERROR', 'SYNC_ERROR', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "EffectiveRestriction" AS ENUM ('WORK', 'BREAK_RELAXED', 'NONE');

-- CreateEnum
CREATE TYPE "PolicyStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AssignmentScopeType" AS ENUM ('ORGANISATION', 'LOCATION', 'TEAM', 'EMPLOYEE');

-- CreateEnum
CREATE TYPE "BreakRestrictionBehaviour" AS ENUM ('RELAX_ALL', 'RELAX_CATEGORIES', 'KEEP_RESTRICTIONS');

-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('SCHEDULED', 'CANCELLED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ShiftSource" AS ENUM ('MANUAL', 'CSV_IMPORT', 'INTEGRATION');

-- CreateEnum
CREATE TYPE "BreakEndReason" AS ENUM ('EXPIRED', 'EMPLOYEE_ENDED', 'SHIFT_ENDED', 'MANAGER_ENDED', 'POLICY_CHANGED');

-- CreateEnum
CREATE TYPE "BreakSessionStatus" AS ENUM ('ACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "WorkStateSource" AS ENUM ('DEVICE_REPORT', 'SERVER_COMPUTED');

-- CreateEnum
CREATE TYPE "ShiftImportStatus" AS ENUM ('UPLOADED', 'MAPPED', 'VALIDATED', 'IMPORTED', 'FAILED');

-- CreateEnum
CREATE TYPE "ShiftImportRowStatus" AS ENUM ('VALID', 'WARNING', 'ERROR', 'IMPORTED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('PLANDAY', 'DEPUTY', 'SEVENSHIFTS', 'WHEN_I_WORK', 'ROTAREADY', 'HOMEBASE');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('NOT_CONNECTED', 'CONNECTED', 'ERROR', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "ActivationMode" AS ENUM ('SCHEDULED', 'CLOCK_EVENT');

-- CreateEnum
CREATE TYPE "ClockEventType" AS ENUM ('CLOCK_IN', 'CLOCK_OUT', 'BREAK_START', 'BREAK_END');

-- CreateEnum
CREATE TYPE "OverrideType" AS ENUM ('EXEMPT_TEMPORARILY', 'END_WORK_MODE_EARLY', 'TEMPORARY_EXCEPTION', 'EMERGENCY_POLICY_OVERRIDE');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('EMPLOYEE_DEVICE', 'MANAGER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ActivityEventType" AS ENUM ('EMPLOYEE_JOINED', 'SETUP_COMPLETED', 'PERMISSION_GRANTED', 'PERMISSION_NEEDS_ATTENTION', 'SELECTION_CONFIGURED', 'WORK_MODE_STARTED', 'WORK_MODE_ENDED', 'BREAK_STARTED', 'BREAK_ENDED', 'BREAK_EXPIRED', 'SCHEDULE_SYNCED', 'POLICY_SYNCED', 'DEVICE_SYNC_DELAYED', 'POLICY_UPDATED', 'SHIFT_CREATED', 'SHIFT_UPDATED', 'SHIFT_CANCELLED', 'OVERRIDE_CREATED', 'OVERRIDE_EXPIRED', 'INTEGRATION_ERROR', 'IMPORT_COMPLETED');

-- CreateEnum
CREATE TYPE "NotificationRecipientType" AS ENUM ('MANAGER_USER', 'EMPLOYEE_DEVICE');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'PUSH', 'EMAIL');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" CITEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "email_verified_at" TIMESTAMPTZ(6),
    "name" TEXT NOT NULL,
    "last_login_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organisations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/London',
    "date_format" "DateFormat" NOT NULL DEFAULT 'DMY',
    "default_policy_id" UUID,
    "default_break_policy_id" UUID,
    "billing_status" "BillingStatus" NOT NULL DEFAULT 'TRIAL',
    "plan" "Plan" NOT NULL DEFAULT 'STARTER',
    "onboarding_state" JSONB NOT NULL DEFAULT '{}',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organisations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organisation_memberships" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MANAGER',
    "notification_preferences" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organisation_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manager_invites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MANAGER',
    "token_hash" TEXT NOT NULL,
    "invited_by_id" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "manager_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_join_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "status" "JoinCodeStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by_id" UUID,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "company_join_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT,
    "address" TEXT,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "location_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "email" CITEXT,
    "phone" TEXT,
    "external_employee_id" TEXT,
    "job_title" TEXT,
    "department_id" UUID,
    "primary_location_id" UUID,
    "employment_status" "EmploymentStatus" NOT NULL DEFAULT 'ACTIVE',
    "invite_status" "InviteStatus" NOT NULL DEFAULT 'NOT_INVITED',
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_teams" (
    "employee_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_teams_pkey" PRIMARY KEY ("employee_id","team_id")
);

-- CreateTable
CREATE TABLE "employee_locations" (
    "employee_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_locations_pkey" PRIMARY KEY ("employee_id","location_id")
);

-- CreateTable
CREATE TABLE "employee_invites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "channel" "InviteChannel" NOT NULL DEFAULT 'LINK',
    "status" "EmployeeInviteStatus" NOT NULL DEFAULT 'PENDING',
    "sent_at" TIMESTAMPTZ(6),
    "accepted_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "employee_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mobile_users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mobile_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_user_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "mobile_user_id" UUID NOT NULL,
    "linked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unlinked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "employee_user_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "mobile_user_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "platform" "Platform" NOT NULL DEFAULT 'IOS',
    "app_version" TEXT,
    "os_version" TEXT,
    "device_model" TEXT,
    "push_token_encrypted" BYTEA,
    "permission_state" "PermissionState" NOT NULL DEFAULT 'NOT_DETERMINED',
    "selection_state" "SelectionState" NOT NULL DEFAULT 'NONE',
    "selection_category_count" INTEGER NOT NULL DEFAULT 0,
    "selection_app_count" INTEGER NOT NULL DEFAULT 0,
    "selection_domain_count" INTEGER NOT NULL DEFAULT 0,
    "restriction_engine_state" "WorkModeState" NOT NULL DEFAULT 'UNKNOWN',
    "policy_version_id" UUID,
    "schedule_version" INTEGER NOT NULL DEFAULT 0,
    "timezone" TEXT,
    "last_device_sync_at" TIMESTAMPTZ(6),
    "last_policy_sync_at" TIMESTAMPTZ(6),
    "last_schedule_sync_at" TIMESTAMPTZ(6),
    "last_seen_at" TIMESTAMPTZ(6),
    "last_clock_skew_seconds" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "deactivated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "device_id" UUID NOT NULL,
    "family_id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "replaced_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "PolicyStatus" NOT NULL DEFAULT 'DRAFT',
    "current_version_id" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "policy_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "restriction_config" JSONB NOT NULL,
    "break_behaviour_default" JSONB NOT NULL DEFAULT '{"restrictionBehaviour":"RELAX_ALL","relaxedCategories":[]}',
    "created_by_id" UUID,
    "change_note" TEXT,
    "published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "policy_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "scope_type" "AssignmentScopeType" NOT NULL,
    "scope_id" UUID NOT NULL,
    "effective_from" TIMESTAMPTZ(6),
    "effective_to" TIMESTAMPTZ(6),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "policy_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "break_policies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "breaks_enabled" BOOLEAN NOT NULL DEFAULT true,
    "max_breaks_per_shift" INTEGER NOT NULL DEFAULT 2,
    "max_break_duration_minutes" INTEGER NOT NULL DEFAULT 15,
    "max_total_break_minutes" INTEGER NOT NULL DEFAULT 30,
    "min_gap_between_breaks_minutes" INTEGER NOT NULL DEFAULT 60,
    "min_minutes_after_shift_start" INTEGER NOT NULL DEFAULT 60,
    "employee_triggered_allowed" BOOLEAN NOT NULL DEFAULT true,
    "scheduled_breaks_allowed" BOOLEAN NOT NULL DEFAULT true,
    "restriction_behaviour" "BreakRestrictionBehaviour" NOT NULL DEFAULT 'RELAX_ALL',
    "relaxed_categories" JSONB NOT NULL DEFAULT '[]',
    "status" "PolicyStatus" NOT NULL DEFAULT 'ACTIVE',
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "break_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "break_policy_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "break_policy_id" UUID NOT NULL,
    "scope_type" "AssignmentScopeType" NOT NULL,
    "scope_id" UUID NOT NULL,
    "effective_from" TIMESTAMPTZ(6),
    "effective_to" TIMESTAMPTZ(6),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "break_policy_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shifts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "location_id" UUID,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "timezone" TEXT NOT NULL,
    "status" "ShiftStatus" NOT NULL DEFAULT 'SCHEDULED',
    "source" "ShiftSource" NOT NULL DEFAULT 'MANUAL',
    "external_shift_id" TEXT,
    "notes" TEXT,
    "recurrence_rule" TEXT,
    "parent_recurrence_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_breaks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shift_id" UUID NOT NULL,
    "offset_minutes_from_start" INTEGER NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "scheduled_breaks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "break_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "device_id" UUID,
    "break_policy_id" UUID,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "planned_ends_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "end_reason" "BreakEndReason",
    "status" "BreakSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "client_break_id" TEXT NOT NULL,
    "restriction_behaviour" "BreakRestrictionBehaviour" NOT NULL DEFAULT 'RELAX_ALL',
    "relaxed_categories" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "break_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_work_states" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "state" "WorkModeState" NOT NULL DEFAULT 'OFF_SHIFT',
    "state_since" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active_shift_id" UUID,
    "active_break_session_id" UUID,
    "breaks_taken_count" INTEGER NOT NULL DEFAULT 0,
    "break_minutes_used" INTEGER NOT NULL DEFAULT 0,
    "source" "WorkStateSource" NOT NULL DEFAULT 'SERVER_COMPUTED',
    "reported_state" "WorkModeState",
    "reported_at" TIMESTAMPTZ(6),
    "expected_state" "WorkModeState",
    "expected_restriction" "EffectiveRestriction",
    "expected_computed_at" TIMESTAMPTZ(6),
    "next_transition_at" TIMESTAMPTZ(6),
    "attention_reason" TEXT,
    "last_updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "employee_work_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_imports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "uploaded_by_id" UUID,
    "filename" TEXT NOT NULL,
    "file_size_bytes" INTEGER NOT NULL DEFAULT 0,
    "status" "ShiftImportStatus" NOT NULL DEFAULT 'UPLOADED',
    "column_mapping" JSONB NOT NULL DEFAULT '{}',
    "options" JSONB NOT NULL DEFAULT '{}',
    "headers" JSONB NOT NULL DEFAULT '[]',
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "valid_count" INTEGER NOT NULL DEFAULT 0,
    "warning_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "imported_count" INTEGER NOT NULL DEFAULT 0,
    "imported_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "shift_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_import_rows" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "import_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "parsed" JSONB,
    "status" "ShiftImportRowStatus" NOT NULL DEFAULT 'ERROR',
    "problems" JSONB NOT NULL DEFAULT '[]',
    "matched_employee_id" UUID,
    "created_shift_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "shift_import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integrations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "activation_mode" "ActivationMode" NOT NULL DEFAULT 'SCHEDULED',
    "notify_requested" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_connections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "integration_id" UUID NOT NULL,
    "encrypted_credentials" BYTEA NOT NULL,
    "token_expires_at" TIMESTAMPTZ(6),
    "last_sync_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clock_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "type" "ClockEventType" NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'INTEGRATION',
    "external_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "clock_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manager_overrides" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "employee_id" UUID,
    "type" "OverrideType" NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by_id" UUID,
    "starts_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "expired_event_emitted_at" TIMESTAMPTZ(6),
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "manager_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "employee_id" UUID,
    "device_id" UUID,
    "actor_type" "ActorType" NOT NULL,
    "actor_user_id" UUID,
    "type" "ActivityEventType" NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "client_event_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "recipient_type" "NotificationRecipientType" NOT NULL,
    "recipient_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "channel" "NotificationChannel" NOT NULL DEFAULT 'IN_APP',
    "read_at" TIMESTAMPTZ(6),
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "demo_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "email" CITEXT NOT NULL,
    "company" TEXT NOT NULL,
    "team_size" TEXT,
    "message" TEXT,
    "source" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "demo_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_tokens_token_hash_key" ON "email_verification_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "email_verification_tokens_user_id_idx" ON "email_verification_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "organisations_slug_key" ON "organisations"("slug");

-- CreateIndex
CREATE INDEX "organisation_memberships_organisation_id_idx" ON "organisation_memberships"("organisation_id");

-- CreateIndex
CREATE UNIQUE INDEX "organisation_memberships_user_id_organisation_id_key" ON "organisation_memberships"("user_id", "organisation_id");

-- CreateIndex
CREATE UNIQUE INDEX "manager_invites_token_hash_key" ON "manager_invites"("token_hash");

-- CreateIndex
CREATE INDEX "manager_invites_organisation_id_email_idx" ON "manager_invites"("organisation_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "company_join_codes_code_key" ON "company_join_codes"("code");

-- CreateIndex
CREATE INDEX "company_join_codes_organisation_id_status_idx" ON "company_join_codes"("organisation_id", "status");

-- CreateIndex
CREATE INDEX "locations_organisation_id_idx" ON "locations"("organisation_id");

-- CreateIndex
CREATE UNIQUE INDEX "departments_organisation_id_name_key" ON "departments"("organisation_id", "name");

-- CreateIndex
CREATE INDEX "teams_organisation_id_idx" ON "teams"("organisation_id");

-- CreateIndex
CREATE INDEX "teams_location_id_idx" ON "teams"("location_id");

-- CreateIndex
CREATE INDEX "employees_organisation_id_invite_status_idx" ON "employees"("organisation_id", "invite_status");

-- CreateIndex
CREATE INDEX "employees_organisation_id_email_idx" ON "employees"("organisation_id", "email");

-- CreateIndex
CREATE INDEX "employees_organisation_id_primary_location_id_idx" ON "employees"("organisation_id", "primary_location_id");

-- CreateIndex
CREATE INDEX "employees_organisation_id_department_id_idx" ON "employees"("organisation_id", "department_id");

-- CreateIndex
CREATE UNIQUE INDEX "employees_organisation_id_external_employee_id_key" ON "employees"("organisation_id", "external_employee_id");

-- CreateIndex
CREATE INDEX "employee_teams_team_id_idx" ON "employee_teams"("team_id");

-- CreateIndex
CREATE INDEX "employee_locations_location_id_idx" ON "employee_locations"("location_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_invites_code_key" ON "employee_invites"("code");

-- CreateIndex
CREATE UNIQUE INDEX "employee_invites_token_hash_key" ON "employee_invites"("token_hash");

-- CreateIndex
CREATE INDEX "employee_invites_organisation_id_employee_id_idx" ON "employee_invites"("organisation_id", "employee_id");

-- CreateIndex
CREATE INDEX "employee_invites_employee_id_status_idx" ON "employee_invites"("employee_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "employee_user_links_employee_id_key" ON "employee_user_links"("employee_id");

-- CreateIndex
CREATE INDEX "employee_user_links_mobile_user_id_idx" ON "employee_user_links"("mobile_user_id");

-- CreateIndex
CREATE INDEX "devices_organisation_id_is_active_idx" ON "devices"("organisation_id", "is_active");

-- CreateIndex
CREATE INDEX "devices_employee_id_idx" ON "devices"("employee_id");

-- CreateIndex
CREATE INDEX "devices_mobile_user_id_idx" ON "devices"("mobile_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_replaced_by_id_key" ON "refresh_tokens"("replaced_by_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_device_id_idx" ON "refresh_tokens"("device_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE UNIQUE INDEX "policies_current_version_id_key" ON "policies"("current_version_id");

-- CreateIndex
CREATE INDEX "policies_organisation_id_status_idx" ON "policies"("organisation_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "policy_versions_policy_id_version_number_key" ON "policy_versions"("policy_id", "version_number");

-- CreateIndex
CREATE INDEX "policy_assignments_organisation_id_scope_type_scope_id_idx" ON "policy_assignments"("organisation_id", "scope_type", "scope_id");

-- CreateIndex
CREATE INDEX "policy_assignments_policy_id_idx" ON "policy_assignments"("policy_id");

-- CreateIndex
CREATE INDEX "break_policies_organisation_id_status_idx" ON "break_policies"("organisation_id", "status");

-- CreateIndex
CREATE INDEX "break_policy_assignments_organisation_id_scope_type_scope_i_idx" ON "break_policy_assignments"("organisation_id", "scope_type", "scope_id");

-- CreateIndex
CREATE INDEX "break_policy_assignments_break_policy_id_idx" ON "break_policy_assignments"("break_policy_id");

-- CreateIndex
CREATE INDEX "shifts_organisation_id_employee_id_starts_at_idx" ON "shifts"("organisation_id", "employee_id", "starts_at");

-- CreateIndex
CREATE INDEX "shifts_organisation_id_starts_at_idx" ON "shifts"("organisation_id", "starts_at");

-- CreateIndex
CREATE INDEX "shifts_organisation_id_location_id_starts_at_idx" ON "shifts"("organisation_id", "location_id", "starts_at");

-- CreateIndex
CREATE INDEX "shifts_parent_recurrence_id_idx" ON "shifts"("parent_recurrence_id");

-- CreateIndex
CREATE UNIQUE INDEX "shifts_organisation_id_external_shift_id_key" ON "shifts"("organisation_id", "external_shift_id");

-- CreateIndex
CREATE INDEX "scheduled_breaks_shift_id_idx" ON "scheduled_breaks"("shift_id");

-- CreateIndex
CREATE UNIQUE INDEX "break_sessions_client_break_id_key" ON "break_sessions"("client_break_id");

-- CreateIndex
CREATE INDEX "break_sessions_organisation_id_employee_id_started_at_idx" ON "break_sessions"("organisation_id", "employee_id", "started_at");

-- CreateIndex
CREATE INDEX "break_sessions_shift_id_status_idx" ON "break_sessions"("shift_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "employee_work_states_employee_id_key" ON "employee_work_states"("employee_id");

-- CreateIndex
CREATE INDEX "employee_work_states_state_idx" ON "employee_work_states"("state");

-- CreateIndex
CREATE INDEX "shift_imports_organisation_id_created_at_idx" ON "shift_imports"("organisation_id", "created_at");

-- CreateIndex
CREATE INDEX "shift_import_rows_import_id_status_idx" ON "shift_import_rows"("import_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "shift_import_rows_import_id_row_number_key" ON "shift_import_rows"("import_id", "row_number");

-- CreateIndex
CREATE UNIQUE INDEX "integrations_organisation_id_provider_key" ON "integrations"("organisation_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connections_integration_id_key" ON "integration_connections"("integration_id");

-- CreateIndex
CREATE INDEX "clock_events_organisation_id_employee_id_occurred_at_idx" ON "clock_events"("organisation_id", "employee_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "clock_events_organisation_id_source_external_id_key" ON "clock_events"("organisation_id", "source", "external_id");

-- CreateIndex
CREATE INDEX "manager_overrides_organisation_id_employee_id_expires_at_idx" ON "manager_overrides"("organisation_id", "employee_id", "expires_at");

-- CreateIndex
CREATE INDEX "manager_overrides_organisation_id_expires_at_idx" ON "manager_overrides"("organisation_id", "expires_at");

-- CreateIndex
CREATE INDEX "activity_events_organisation_id_occurred_at_idx" ON "activity_events"("organisation_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "activity_events_organisation_id_employee_id_occurred_at_idx" ON "activity_events"("organisation_id", "employee_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "activity_events_organisation_id_type_occurred_at_idx" ON "activity_events"("organisation_id", "type", "occurred_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "activity_events_device_id_client_event_id_key" ON "activity_events"("device_id", "client_event_id");

-- CreateIndex
CREATE INDEX "notifications_organisation_id_recipient_type_recipient_id_c_idx" ON "notifications"("organisation_id", "recipient_type", "recipient_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_organisation_id_occurred_at_idx" ON "audit_logs"("organisation_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_organisation_id_entity_type_entity_id_idx" ON "audit_logs"("organisation_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "demo_requests_created_at_idx" ON "demo_requests"("created_at" DESC);

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_default_policy_id_fkey" FOREIGN KEY ("default_policy_id") REFERENCES "policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_default_break_policy_id_fkey" FOREIGN KEY ("default_break_policy_id") REFERENCES "break_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_memberships" ADD CONSTRAINT "organisation_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_memberships" ADD CONSTRAINT "organisation_memberships_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manager_invites" ADD CONSTRAINT "manager_invites_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manager_invites" ADD CONSTRAINT "manager_invites_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_join_codes" ADD CONSTRAINT "company_join_codes_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_join_codes" ADD CONSTRAINT "company_join_codes_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_primary_location_id_fkey" FOREIGN KEY ("primary_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_teams" ADD CONSTRAINT "employee_teams_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_teams" ADD CONSTRAINT "employee_teams_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_locations" ADD CONSTRAINT "employee_locations_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_locations" ADD CONSTRAINT "employee_locations_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_invites" ADD CONSTRAINT "employee_invites_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_invites" ADD CONSTRAINT "employee_invites_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_user_links" ADD CONSTRAINT "employee_user_links_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_user_links" ADD CONSTRAINT "employee_user_links_mobile_user_id_fkey" FOREIGN KEY ("mobile_user_id") REFERENCES "mobile_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_mobile_user_id_fkey" FOREIGN KEY ("mobile_user_id") REFERENCES "mobile_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_policy_version_id_fkey" FOREIGN KEY ("policy_version_id") REFERENCES "policy_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_replaced_by_id_fkey" FOREIGN KEY ("replaced_by_id") REFERENCES "refresh_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policies" ADD CONSTRAINT "policies_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policies" ADD CONSTRAINT "policies_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "policy_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_assignments" ADD CONSTRAINT "policy_assignments_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_assignments" ADD CONSTRAINT "policy_assignments_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_assignments" ADD CONSTRAINT "policy_assignments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "break_policies" ADD CONSTRAINT "break_policies_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "break_policy_assignments" ADD CONSTRAINT "break_policy_assignments_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "break_policy_assignments" ADD CONSTRAINT "break_policy_assignments_break_policy_id_fkey" FOREIGN KEY ("break_policy_id") REFERENCES "break_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "break_policy_assignments" ADD CONSTRAINT "break_policy_assignments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_parent_recurrence_id_fkey" FOREIGN KEY ("parent_recurrence_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_breaks" ADD CONSTRAINT "scheduled_breaks_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "break_sessions" ADD CONSTRAINT "break_sessions_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "break_sessions" ADD CONSTRAINT "break_sessions_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "break_sessions" ADD CONSTRAINT "break_sessions_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "break_sessions" ADD CONSTRAINT "break_sessions_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "break_sessions" ADD CONSTRAINT "break_sessions_break_policy_id_fkey" FOREIGN KEY ("break_policy_id") REFERENCES "break_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_work_states" ADD CONSTRAINT "employee_work_states_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_work_states" ADD CONSTRAINT "employee_work_states_active_shift_id_fkey" FOREIGN KEY ("active_shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_work_states" ADD CONSTRAINT "employee_work_states_active_break_session_id_fkey" FOREIGN KEY ("active_break_session_id") REFERENCES "break_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_imports" ADD CONSTRAINT "shift_imports_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_imports" ADD CONSTRAINT "shift_imports_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_import_rows" ADD CONSTRAINT "shift_import_rows_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "shift_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_import_rows" ADD CONSTRAINT "shift_import_rows_matched_employee_id_fkey" FOREIGN KEY ("matched_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_import_rows" ADD CONSTRAINT "shift_import_rows_created_shift_id_fkey" FOREIGN KEY ("created_shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clock_events" ADD CONSTRAINT "clock_events_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clock_events" ADD CONSTRAINT "clock_events_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manager_overrides" ADD CONSTRAINT "manager_overrides_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manager_overrides" ADD CONSTRAINT "manager_overrides_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manager_overrides" ADD CONSTRAINT "manager_overrides_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────────────────────
-- Hand-written constraints Prisma's schema language cannot express (keep in sync with schema comments).
-- ─────────────────────────────────────────────────────────────────────────────

-- Shifts must end after they start (overnight shifts simply end on the next calendar day).
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_ends_after_starts" CHECK ("ends_at" > "starts_at");

-- Break sessions must plan to end after they start.
ALTER TABLE "break_sessions" ADD CONSTRAINT "break_sessions_planned_end_after_start" CHECK ("planned_ends_at" > "started_at");

-- Scheduled breaks have positive duration and non-negative offset.
ALTER TABLE "scheduled_breaks" ADD CONSTRAINT "scheduled_breaks_duration_positive" CHECK ("duration_minutes" > 0 AND "offset_minutes_from_start" >= 0);

-- Case-insensitive employee name lookup used by mobile join + CSV matching.
CREATE INDEX "employees_org_lower_name_idx" ON "employees" ("organisation_id", lower("first_name"), lower("last_name"));

-- Only one ACTIVE join code per organisation at a time (history retained as REVOKED rows).
CREATE UNIQUE INDEX "company_join_codes_one_active_per_org" ON "company_join_codes" ("organisation_id") WHERE "status" = 'ACTIVE';

-- One active policy / break-policy assignment per scope target.
CREATE UNIQUE INDEX "policy_assignments_active_scope_unique" ON "policy_assignments" ("scope_type", "scope_id") WHERE "effective_to" IS NULL;
CREATE UNIQUE INDEX "break_policy_assignments_active_scope_unique" ON "break_policy_assignments" ("scope_type", "scope_id") WHERE "effective_to" IS NULL;

-- Only one ACTIVE break session per shift.
CREATE UNIQUE INDEX "break_sessions_one_active_per_shift" ON "break_sessions" ("shift_id") WHERE "status" = 'ACTIVE';

-- Only one active (not unlinked) link per mobile user to an employee is already guaranteed by employee_id UNIQUE;
-- additionally prevent two active links for the same mobile user.
CREATE UNIQUE INDEX "employee_user_links_one_active_per_mobile_user" ON "employee_user_links" ("mobile_user_id") WHERE "unlinked_at" IS NULL;

-- Manager overrides must expire after they start.
ALTER TABLE "manager_overrides" ADD CONSTRAINT "manager_overrides_expires_after_starts" CHECK ("expires_at" > "starts_at");
