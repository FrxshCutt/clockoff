-- Planday integration, part 2 of 2 (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md sections 2.3 to 2.7):
-- new enums, new columns on existing tables, the integration tables (entity maps, mapping config, the sync-run
-- queue, pending employees, shift preview, onboarding sessions, OAuth states, connect links), indexes, partial
-- unique indexes, check constraints and backfills.
--
-- EXPAND-ONLY. Web's pre-deploy step applies this while the previous web (15 s overlap) and the draining worker
-- still run, and a Railway rollback redeploys an older image onto it, so: no dropped or renamed columns, and no
-- new NOT NULL column without a default. integration_connections keeps its physical column names
-- (token_expires_at, last_sync_at, last_error are reused under new Prisma field names), and
-- encrypted_credentials only becomes nullable; a later contract migration drops it after release.
--
-- Fail fast rather than queue live traffic. The ADD COLUMNs below take ACCESS EXCLUSIVE locks on employees,
-- locations, teams, shifts, organisations and integration_connections, held until the script commits (it runs as
-- one implicit transaction). Without a limit, a session holding a conflicting lock would make the migration wait
-- indefinitely while every new query on those tables queued behind it. With it, a lock not granted within 5 s
-- rolls the whole script back, web's pre-deploy step fails and Railway keeps the previous web deployment. Prisma
-- then records the migration as failed (P3009 on the next deploy): run `prisma migrate resolve --rolled-back
-- 20261008140100_planday_integration` and redeploy (docs/DATABASE.md). A session-level SET, so it applies however
-- the script is sent; the migrate connection closes when `prisma migrate deploy` exits.
SET lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "RotaSource" AS ENUM ('PLANDAY', 'DEPUTY', 'SEVENSHIFTS', 'WHEN_I_WORK', 'ROTAREADY', 'HOMEBASE', 'CSV', 'MANUAL', 'OTHER');

-- CreateEnum
CREATE TYPE "RecordSource" AS ENUM ('MANUAL', 'CSV_IMPORT', 'INTEGRATION');

-- CreateEnum
CREATE TYPE "IntegrationAuthMethod" AS ENUM ('OAUTH', 'CUSTOMER_ADDED_APP_ID', 'CUSTOMER_OWN_APP');

-- CreateEnum
CREATE TYPE "IntegrationConnectionStatus" AS ENUM ('CONNECTING', 'CONNECTED', 'SYNCING', 'DEGRADED', 'AUTH_ERROR', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "ExternalEntityType" AS ENUM ('EMPLOYEE', 'LOCATION', 'DEPARTMENT', 'TEAM', 'SHIFT');

-- CreateEnum
CREATE TYPE "IntegrationSyncTrigger" AS ENUM ('INITIAL', 'SCHEDULED', 'MANUAL', 'RECOVERY');

-- CreateEnum
CREATE TYPE "IntegrationSyncRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "IntegrationSyncRunKind" AS ENUM ('STRUCTURE', 'DIRECTORY', 'IMPORT_EMPLOYEES', 'SYNC', 'CLOCK');

-- CreateEnum
CREATE TYPE "PendingExternalEmployeeReason" AS ENUM ('ONBOARDING', 'NEW_EMPLOYEE', 'AMBIGUOUS_MATCH', 'POSSIBLE_MATCH', 'PLAN_LIMIT', 'MISSING_IN_PLANDAY');

-- CreateEnum
CREATE TYPE "OnboardingSessionStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "IntegrationWizardStep" AS ENUM ('CONNECT', 'CONFIRM_PORTAL', 'LOCATIONS', 'TEAMS', 'EMPLOYEES', 'SHIFT_PREVIEW', 'POLICIES', 'ACTIVATION', 'FINISH');

-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "managed_by_integration_id" UUID,
ADD COLUMN     "source" "RecordSource" NOT NULL DEFAULT 'MANUAL';

-- AlterTable
ALTER TABLE "integration_connections" ADD COLUMN     "auth_error_notified_at" TIMESTAMPTZ(6),
ADD COLUMN     "auth_method" "IntegrationAuthMethod",
ADD COLUMN     "auth_probe_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "connected_at" TIMESTAMPTZ(6),
ADD COLUMN     "connected_by_user_id" UUID,
ADD COLUMN     "consecutive_failure_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "credential_hint" VARCHAR(4),
ADD COLUMN     "credential_version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deactivation_checked_at" TIMESTAMPTZ(6),
ADD COLUMN     "degraded_email_sent_at" TIMESTAMPTZ(6),
ADD COLUMN     "degraded_notified_at" TIMESTAMPTZ(6),
ADD COLUMN     "deleted_shifts_checked_at" TIMESTAMPTZ(6),
ADD COLUMN     "disconnected_at" TIMESTAMPTZ(6),
ADD COLUMN     "encrypted_access_token" BYTEA,
ADD COLUMN     "encrypted_client_id" BYTEA,
ADD COLUMN     "encrypted_refresh_token" BYTEA,
ADD COLUMN     "external_portal_id" TEXT,
ADD COLUMN     "external_portal_name" TEXT,
ADD COLUMN     "external_portal_timezone" TEXT,
ADD COLUMN     "is_mock" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "last_error_code" TEXT,
ADD COLUMN     "next_sync_at" TIMESTAMPTZ(6),
ADD COLUMN     "pending_run_kind" "IntegrationSyncRunKind",
ADD COLUMN     "pending_run_requested_at" TIMESTAMPTZ(6),
ADD COLUMN     "pending_run_requested_by_user_id" UUID,
ADD COLUMN     "pending_run_retry_auth" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pending_run_trigger" "IntegrationSyncTrigger",
ADD COLUMN     "refresh_token_rotated_at" TIMESTAMPTZ(6),
ADD COLUMN     "scopes_granted" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "status" "IntegrationConnectionStatus" NOT NULL DEFAULT 'CONNECTING',
ADD COLUMN     "status_changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "sync_lease_expires_at" TIMESTAMPTZ(6),
ADD COLUMN     "sync_lease_id" UUID,
ALTER COLUMN "encrypted_credentials" DROP NOT NULL;

-- AlterTable
ALTER TABLE "locations" ADD COLUMN     "managed_by_integration_id" UUID,
ADD COLUMN     "source" "RecordSource" NOT NULL DEFAULT 'MANUAL';

-- AlterTable
ALTER TABLE "organisations" ADD COLUMN     "rota_source" "RotaSource",
ADD COLUMN     "rota_source_other_text" VARCHAR(200);

-- AlterTable
ALTER TABLE "shifts" ADD COLUMN     "managed_by_integration_id" UUID;

-- AlterTable
ALTER TABLE "teams" ADD COLUMN     "managed_by_integration_id" UUID,
ADD COLUMN     "source" "RecordSource" NOT NULL DEFAULT 'MANUAL';

-- CreateTable
CREATE TABLE "external_entity_maps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "entity_type" "ExternalEntityType" NOT NULL,
    "external_id" TEXT NOT NULL,
    "internal_id" UUID NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "last_hash" TEXT,
    "upstream_removed_at" TIMESTAMPTZ(6),
    "upstream_missing_since" TIMESTAMPTZ(6),
    "review_dismissed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "external_entity_maps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_mapping_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "included_department_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "department_mappings" JSONB NOT NULL DEFAULT '{}',
    "group_mappings" JSONB NOT NULL DEFAULT '{}',
    "excluded_employee_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "auto_include_new_employees" BOOLEAN NOT NULL DEFAULT true,
    "import_emails" BOOLEAN NOT NULL DEFAULT true,
    "sync_window_days" INTEGER NOT NULL DEFAULT 28,
    "respect_hidden_days" BOOLEAN NOT NULL DEFAULT false,
    "catalog" JSONB NOT NULL DEFAULT '{}',
    "mapping_version" INTEGER NOT NULL DEFAULT 1,
    "onboarding_completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "integration_mapping_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_sync_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "trigger" "IntegrationSyncTrigger" NOT NULL,
    "kind" "IntegrationSyncRunKind" NOT NULL DEFAULT 'SYNC',
    "status" "IntegrationSyncRunStatus" NOT NULL DEFAULT 'RUNNING',
    "phase" TEXT NOT NULL DEFAULT 'START',
    "cursor" JSONB NOT NULL DEFAULT '{}',
    "progress" JSONB NOT NULL DEFAULT '{}',
    "counts" JSONB NOT NULL DEFAULT '{}',
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "request_count" INTEGER NOT NULL DEFAULT 0,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "resume_after" TIMESTAMPTZ(6),
    "heartbeat_at" TIMESTAMPTZ(6),
    "priority" SMALLINT NOT NULL DEFAULT 3,
    "mapping_version" INTEGER NOT NULL DEFAULT 1,
    "retry_auth" BOOLEAN NOT NULL DEFAULT false,
    "replace_shift_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "first_claimed_at" TIMESTAMPTZ(6),
    "last_slice_at" TIMESTAMPTZ(6),
    "claimed_by" VARCHAR(128),
    "requested_by_user_id" UUID,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "integration_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_external_employees" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "external_id" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "work_email" CITEXT,
    "has_email" BOOLEAN NOT NULL DEFAULT false,
    "external_department_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "primary_external_department_id" TEXT,
    "external_group_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reason" "PendingExternalEmployeeReason" NOT NULL,
    "matched_employee_id" UUID,
    "match_signal" TEXT,
    "candidate_employee_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pending_external_employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_preview_shifts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "sync_run_id" UUID NOT NULL,
    "external_shift_id" TEXT NOT NULL,
    "external_employee_id" TEXT NOT NULL,
    "external_department_id" TEXT,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "timezone" TEXT NOT NULL,
    "is_overnight" BOOLEAN NOT NULL,
    "time_warning" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_preview_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_onboarding_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "status" "OnboardingSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "current_step" "IntegrationWizardStep" NOT NULL DEFAULT 'CONNECT',
    "completed_steps" "IntegrationWizardStep"[] DEFAULT ARRAY[]::"IntegrationWizardStep"[],
    "state" JSONB NOT NULL DEFAULT '{}',
    "structure_run_id" UUID,
    "directory_run_id" UUID,
    "import_run_id" UUID,
    "final_run_id" UUID,
    "started_by_user_id" UUID,
    "last_activity_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "integration_onboarding_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_oauth_states" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "user_id" UUID NOT NULL,
    "state_hash" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "encrypted_code_verifier" BYTEA,
    "return_to" TEXT NOT NULL,
    "allow_portal_switch" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_connect_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organisation_id" UUID NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "created_by_user_id" UUID,
    "token_hash" TEXT NOT NULL,
    "manager_invite_id" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "last_used_at" TIMESTAMPTZ(6),
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "integration_connect_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "external_entity_maps_integration_id_entity_type_internal_id_idx" ON "external_entity_maps"("integration_id", "entity_type", "internal_id");

-- CreateIndex
CREATE INDEX "external_entity_maps_integration_id_entity_type_last_seen_a_idx" ON "external_entity_maps"("integration_id", "entity_type", "last_seen_at");

-- CreateIndex
CREATE INDEX "external_entity_maps_organisation_id_entity_type_internal_i_idx" ON "external_entity_maps"("organisation_id", "entity_type", "internal_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_entity_maps_integration_id_entity_type_external_id_key" ON "external_entity_maps"("integration_id", "entity_type", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_mapping_configs_integration_id_key" ON "integration_mapping_configs"("integration_id");

-- CreateIndex
CREATE INDEX "integration_sync_runs_integration_id_started_at_idx" ON "integration_sync_runs"("integration_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "integration_sync_runs_status_resume_after_idx" ON "integration_sync_runs"("status", "resume_after");

-- CreateIndex
CREATE INDEX "integration_sync_runs_organisation_id_started_at_idx" ON "integration_sync_runs"("organisation_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "pending_external_employees_organisation_id_integration_id_r_idx" ON "pending_external_employees"("organisation_id", "integration_id", "reason");

-- CreateIndex
CREATE UNIQUE INDEX "pending_external_employees_integration_id_external_id_key" ON "pending_external_employees"("integration_id", "external_id");

-- CreateIndex
CREATE INDEX "integration_preview_shifts_integration_id_starts_at_idx" ON "integration_preview_shifts"("integration_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "integration_preview_shifts_integration_id_external_shift_id_key" ON "integration_preview_shifts"("integration_id", "external_shift_id");

-- CreateIndex
CREATE INDEX "integration_onboarding_sessions_organisation_id_provider_st_idx" ON "integration_onboarding_sessions"("organisation_id", "provider", "status");

-- CreateIndex
CREATE UNIQUE INDEX "integration_oauth_states_state_hash_key" ON "integration_oauth_states"("state_hash");

-- CreateIndex
CREATE INDEX "integration_oauth_states_expires_at_idx" ON "integration_oauth_states"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connect_links_token_hash_key" ON "integration_connect_links"("token_hash");

-- CreateIndex
CREATE INDEX "integration_connect_links_organisation_id_provider_idx" ON "integration_connect_links"("organisation_id", "provider");

-- CreateIndex
CREATE INDEX "employees_organisation_id_managed_by_integration_id_idx" ON "employees"("organisation_id", "managed_by_integration_id");

-- CreateIndex
CREATE INDEX "integration_connections_status_next_sync_at_idx" ON "integration_connections"("status", "next_sync_at");

-- CreateIndex
CREATE INDEX "locations_organisation_id_managed_by_integration_id_idx" ON "locations"("organisation_id", "managed_by_integration_id");

-- CreateIndex
CREATE INDEX "shifts_organisation_id_managed_by_integration_id_starts_at_idx" ON "shifts"("organisation_id", "managed_by_integration_id", "starts_at");

-- CreateIndex
CREATE INDEX "teams_organisation_id_managed_by_integration_id_idx" ON "teams"("organisation_id", "managed_by_integration_id");

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_managed_by_integration_id_fkey" FOREIGN KEY ("managed_by_integration_id") REFERENCES "integrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_managed_by_integration_id_fkey" FOREIGN KEY ("managed_by_integration_id") REFERENCES "integrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_managed_by_integration_id_fkey" FOREIGN KEY ("managed_by_integration_id") REFERENCES "integrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_managed_by_integration_id_fkey" FOREIGN KEY ("managed_by_integration_id") REFERENCES "integrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_connected_by_user_id_fkey" FOREIGN KEY ("connected_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_entity_maps" ADD CONSTRAINT "external_entity_maps_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_entity_maps" ADD CONSTRAINT "external_entity_maps_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_mapping_configs" ADD CONSTRAINT "integration_mapping_configs_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_mapping_configs" ADD CONSTRAINT "integration_mapping_configs_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_sync_runs" ADD CONSTRAINT "integration_sync_runs_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_sync_runs" ADD CONSTRAINT "integration_sync_runs_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_sync_runs" ADD CONSTRAINT "integration_sync_runs_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_external_employees" ADD CONSTRAINT "pending_external_employees_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_external_employees" ADD CONSTRAINT "pending_external_employees_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_external_employees" ADD CONSTRAINT "pending_external_employees_matched_employee_id_fkey" FOREIGN KEY ("matched_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_preview_shifts" ADD CONSTRAINT "integration_preview_shifts_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_preview_shifts" ADD CONSTRAINT "integration_preview_shifts_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_preview_shifts" ADD CONSTRAINT "integration_preview_shifts_sync_run_id_fkey" FOREIGN KEY ("sync_run_id") REFERENCES "integration_sync_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_onboarding_sessions" ADD CONSTRAINT "integration_onboarding_sessions_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_onboarding_sessions" ADD CONSTRAINT "integration_onboarding_sessions_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_onboarding_sessions" ADD CONSTRAINT "integration_onboarding_sessions_started_by_user_id_fkey" FOREIGN KEY ("started_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_oauth_states" ADD CONSTRAINT "integration_oauth_states_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_oauth_states" ADD CONSTRAINT "integration_oauth_states_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_oauth_states" ADD CONSTRAINT "integration_oauth_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_connect_links" ADD CONSTRAINT "integration_connect_links_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_connect_links" ADD CONSTRAINT "integration_connect_links_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_connect_links" ADD CONSTRAINT "integration_connect_links_manager_invite_id_fkey" FOREIGN KEY ("manager_invite_id") REFERENCES "manager_invites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Hand-written: partial unique indexes and check constraints Prisma's schema language cannot express
-- (keep in sync with the schema comments), then backfills.
-- ─────────────────────────────────────────────────────────────────────────────

-- One active (RUNNING: queued or started) run per integration: the run queue. enqueueRun inserts with
-- ON CONFLICT ("integration_id") WHERE "status" = 'RUNNING' DO NOTHING, inferring this index.
CREATE UNIQUE INDEX "integration_sync_runs_one_running"
  ON "integration_sync_runs" ("integration_id") WHERE "status" = 'RUNNING';

-- One ClockOff employee / shift per external record and vice versa.
CREATE UNIQUE INDEX "external_entity_maps_internal_unique"
  ON "external_entity_maps" ("integration_id", "entity_type", "internal_id")
  WHERE "entity_type" IN ('EMPLOYEE', 'SHIFT');

-- One ACTIVE wizard per organisation and provider.
CREATE UNIQUE INDEX "integration_onboarding_sessions_one_active"
  ON "integration_onboarding_sessions" ("organisation_id", "provider") WHERE "status" = 'ACTIVE';

-- One live, non-mock connection per Planday portal across all organisations (D-054). Planday is the only
-- provider with connections; a second provider adds its provider to this key in its own migration. A connect
-- that hits it (P2002) answers INTEGRATION_PORTAL_IN_USE.
CREATE UNIQUE INDEX "integration_connections_one_live_portal"
  ON "integration_connections" ("external_portal_id")
  WHERE "external_portal_id" IS NOT NULL AND "status" <> 'DISCONNECTED' AND "is_mock" = false;

-- Sync window between one and eight weeks.
ALTER TABLE "integration_mapping_configs"
  ADD CONSTRAINT "integration_mapping_configs_sync_window_days_check"
  CHECK ("sync_window_days" BETWEEN 7 AND 56);

-- Free text only with the OTHER answer. Null-safe: a null rota_source with text set is rejected too
-- (a plain "rota_source = 'OTHER'" would evaluate to NULL there, which a CHECK lets through).
ALTER TABLE "organisations"
  ADD CONSTRAINT "organisations_rota_source_other_text_check"
  CHECK ("rota_source_other_text" IS NULL OR "rota_source" IS NOT DISTINCT FROM 'OTHER');

-- The hint is the last four characters of the refresh token, nothing more.
ALTER TABLE "integration_connections"
  ADD CONSTRAINT "integration_connections_credential_hint_check"
  CHECK ("credential_hint" IS NULL OR char_length("credential_hint") <= 4);

-- Queue priorities: 0 interactive, 1 clock, 2 recovery, 3 scheduled.
ALTER TABLE "integration_sync_runs"
  ADD CONSTRAINT "integration_sync_runs_priority_check"
  CHECK ("priority" BETWEEN 0 AND 3);

-- Backfills (section 2.7). employees / locations / teams.source take their MANUAL default (CSV-created
-- employees cannot be told apart reliably), managed_by_integration_id stays null (no provider was ever
-- connected) and organisations.rota_source stays null (existing organisations are asked on the overview).
-- Any pre-existing integration_connections row predates the Planday connection model: it is marked
-- DISCONNECTED (production has none; the guard only reports the count).
DO $$
DECLARE
  existing_rows integer;
BEGIN
  SELECT count(*) INTO existing_rows FROM "integration_connections";
  IF existing_rows > 0 THEN
    RAISE NOTICE 'planday_integration: marking % pre-existing integration_connections row(s) DISCONNECTED',
      existing_rows;
  END IF;
END
$$;
UPDATE "integration_connections" SET "status" = 'DISCONNECTED';
