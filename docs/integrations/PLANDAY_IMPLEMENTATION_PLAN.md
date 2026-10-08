# Planday integration: implementation plan

Status: plan. Written 2026-10-07 for Netlify and revised for Railway on 2026-10-08 (summary in the next section).
This revision also writes section 16 and appendices A to C, which the earlier text referred to but the file did not
contain. A second revision on 2026-10-08 applies the first review (42 findings, correctness and
platform/security/UX lenses); the [Review log](#review-log) at the end lists each finding and what changed. Build
workflows follow the plan file by file.

## Changes for Railway (2026-10-08)

Production moved from Netlify to Railway on 2026-10-08: `web` (Next.js standalone, runs no jobs), `worker` (always
on: per-minute jobs under Postgres advisory locks and minute-slot claims, heartbeat, push-bridge leader, and a
15-minute `integrations-sync` slot that was a documented no-op) and `www`. What this revision changes:

- **Execution.** Every sync runs in the worker. Web only inserts an `IntegrationSyncRun` queue row (in the same
  transaction as the change that asked for it) and announces it on the Postgres event bus; the worker's new
  integration runner (`src/worker/integrationRunner.ts`) claims it within seconds (bus wake-up, 10 s poll as the
  fallback) and executes it in resumable slices under a per-portal lease. The Netlify background function, the
  `integrations-tick` scheduled function, `POST /api/jobs/integrations/{tick,run-chunk}`, `auth: "cron"`,
  `CRON_SECRET` and `INTEGRATION_EXECUTOR` are gone (section 7).
- **Scheduling.** The existing `integrations-sync` job calls a rewritten `runScheduledIntegrationSyncs()` that
  enqueues the quarter-hour `SCHEDULED` runs (7.8). A new per-minute `integrations-upkeep` job (lock key 6)
  evaluates health and enqueues recovery, clock and catch-up runs (7.9).
- **Time limits.** No 30 s request cut and no frozen Lambdas: the 20 s chunks become slices of up to 120 s that
  yield between steps. The binding constraint is now SIGTERM with `SHUTDOWN_GRACE_MS` ≤ 25 s inside the worker's
  60 s draining, met by aborting in-flight API reads (never token requests), resumable cursors, and never holding a
  database transaction across a Planday call (4.3, 7.6, 7.7).
- **Progress.** The runner publishes `integration.sync.progress` on `PostgresEventBus`; dashboards receive it over
  SSE and refetch the run, with polling as the fallback (7.11). The `flushPushBridge()` and
  `ensureOrganisationBridged()` calls are dropped: the push bridge runs in the worker's elected leader.
- **Migrations** are renamed to sort after `20261008090000_worker_runtime` (2.1). Web's pre-deploy step applies
  them, and they stay expand-only because the previous web (15 s overlap), the draining worker and Railway
  rollbacks run against the new schema. All Planday schema, including the run-queue columns, lands in stage 1.
- **Deploys are cheap.** All eight stages end with green gates and a push to `main` (Gate D, section 15). A new
  flag, `PLANDAY_ENABLED` (false in production until stage 8), keeps Planday dark until release and stays as the
  kill switch (appendix A).
- **Mock Planday** is also served over HTTP (`apps/web/scripts/mock-planday.mts`) in development and Playwright, so
  web and worker share one mock state (12.1).
- **Build plumbing.** Both Dockerfiles copy `packages/integrations/package.json` before `pnpm install`; the new
  variable names go into `.railway/railway.ts`; `src/deploy/processBoundaries.test.ts` gains the new run entry
  points.
- **Decision numbers** move to D-030 to D-049 (appendix C): D-023 to D-029 now record the Railway move itself. The
  review revision adds D-050 to D-056 and turns D-040 and D-042 into owner decisions.
- **Unchanged:** the data model's meaning, the three connection methods, every client rule taken from the notes,
  the sync rules, health monitoring, the wizard, the Integrations page, the security model and data minimisation.

Inputs, in order of authority:

1. The owner's specification (Planday integration and rota-source onboarding, 2026-10-07), referred to as
   "spec §n".
2. [`PLANDAY_API_NOTES.md`](PLANDAY_API_NOTES.md), referred to as "notes §n". Every endpoint, header, scope,
   field, limit and token rule in this plan comes from the notes. Where the notes list an open question, this
   plan names the safe behaviour the code adopts without the answer (section 16).
3. The existing code, read for this plan: `packages/db/prisma/schema.prisma`, `packages/db/src/migrations.ts`,
   `packages/shared/src/providers/*`, `apps/web/src/server/integrations/*` (including `scheduledSync.ts`),
   `apps/web/src/worker/*` (`jobs.ts`, `scheduler.ts`, `advisoryLock.ts`, `jobRuns.ts`, `lockKeys.ts`,
   `shutdown.ts`, `cli.ts`), `apps/web/src/server/jobs/types.ts`, `apps/web/src/server/events/*`,
   `apps/web/src/server/realtime/{sse,pushBridge}.ts`, `apps/web/src/components/realtime/realtime-model.ts`,
   `apps/web/src/deploy/{processBoundaries,railwayConfig}.test.ts`, `docker/{web,worker}/Dockerfile`,
   `railway/*.json`, `.railway/railway.ts`, `apps/web/src/lib/{crypto,env}.ts`, `apps/web/src/server/shifts/*`,
   `apps/web/src/server/imports/*`, `apps/web/src/server/organisations/*`,
   `apps/web/src/server/workState/workStateJob.ts`, `apps/web/src/server/notifications/*`,
   `apps/web/src/server/email/*`, `apps/web/src/server/audit/audit.ts`, `apps/web/src/server/sync/scheduleVersion.ts`,
   `apps/web/src/components/integrations/*`, `apps/web/src/components/overview/*`,
   `apps/web/src/components/auth/create-organisation-form.tsx`, `apps/web/playwright.config.ts`.

Platform facts this plan is built around (checked 2026-10-08 in the code and the Railway migration notes): Railway
EU West (Amsterdam) with Neon Postgres in London. `web` is Next.js standalone (15 s deploy overlap, 30 s draining)
and runs no jobs (`src/deploy/processBoundaries.test.ts`). `worker` is one always-on replica (256 MiB with a 160 MiB
heap cap, 1 vCPU, 60 s draining, no overlap): per-minute jobs under session advisory locks on `DIRECT_URL` plus
minute-slot claims in `worker_job_runs`, the heartbeat, push-bridge leadership and the 15-minute
`integrations-sync` slot (lock key 4, lane `integrations`, not watched by the watchdog). SIGTERM gives jobs
`SHUTDOWN_GRACE_MS` (default 20 s, maximum 25 s) before a fixed 20.5 s of shutdown steps. Realtime events cross
processes through `PostgresEventBus` (LISTEN/NOTIFY on `clockoff_events`, never replayed); dashboard SSE streams end
after 5 minutes with a planned reconnect, and the client polls every 30 s while disconnected. Pushing `main`
deploys web and worker; web's pre-deploy step runs `prisma migrate deploy`; production variables are listed by
name in `.railway/railway.ts` (a name missing there is deleted by the next apply).

Words used below: **MUST** is binding for builders. **Decision** marks a choice to record in
`docs/DECISIONS.md` (appendix C lists them). "Org" is a ClockOff `Organisation`; "portal" is a Planday portal.

## 0. Ground rules for every build stage

- Work on a local branch `feat/planday-integration` created from `main`. Commit at the end of every stage.
  **Stage paths explicitly** (`git add <paths>`); never `git add -A` or `git commit -a`. Another session has
  uncommitted iOS design work in this checkout (`apps/ios/**`, `docs/DESIGN_SYSTEM.md`,
  `docs/design-tokens.json`, `awesome-design-md/`, `apps/ios/Scripts/generate-design-tokens.py`). No stage
  reads, edits, formats or stages those paths.
- Every stage ends with Gate G and then Gate D (section 15): fast-forward `main` to the branch and push (Railway
  deploys web and worker; web's pre-deploy step applies migrations), then run the stage's post-deploy checks. A red
  gate never ships; a failed post-deploy check is rolled back in Railway and fixed forward.
- Planday stays dark in production until stage 8: every user-visible surface, route and worker activity checks
  `PLANDAY_ENABLED` (appendix A), which is `false` in production until the owner turns it on.
- The web process never executes sync work. No route, server action or `runAfterResponse` task calls
  `runSyncSlice`, `runScheduledIntegrationSyncs` or `runIntegrationsUpkeep` (`src/deploy/processBoundaries.test.ts`
  enforces it), and no HTTP endpoint exists for jobs. The only Planday calls web makes are the connect proof
  (≤ `SHUTDOWN_GRACE_MS − 2 s`, 18 s by default, section 5.6) and the best-effort token revocations on disconnect
  and reconnect (≤ 5 s each, sections 5.7 and 5.8).
- No interactive database transaction spans a Planday HTTP call (sections 4.3 and 7.6).
- Never open `.env` or `.env.deploy`. New variables are documented in `.env.example`,
  `apps/web/.env.production.example` and `docs/ENVIRONMENT.md`, and their **names** are added to
  `.railway/railway.ts` in the same change (a name missing there is deleted by the next `railway config apply`).
  Local runs pass values on the command line (`dotenv-cli` does not override variables that are already set), for
  example `PLANDAY_MODE=mock pnpm --filter @clockoff/web dev`.
- Migrations: `prisma migrate dev --create-only`, hand-edit the SQL, then apply. Never `prisma db push`, never
  `migrate reset` against anything but the `_test` database (the integration global setup resets that one).
- Do not rename the shift-state vocabulary: "Work Mode", `WORK_MODE_*`, `WorkModeState`, `runWorkModeTick`,
  `work-mode-tick` keep their names (D-021).
- Do not use `Monitor` or long polls inside a workflow (they restart in-flight subagents). Use foreground
  commands with timeouts, including when waiting for a deploy.
- Format every touched file with `pnpm exec prettier --write <files>`; `pnpm format:check` is a gate.

## 1. Goals, non-goals and the Definition of Done

### 1.1 Goals

- `PlandayProvider` is a real `WorkforceProvider` (effective registry status `AVAILABLE` once registered, 3.4),
  reached through three connection methods that all store the same credential shape (spec §1, §4).
- A resumable, idempotent sync engine that writes Planday departments, employee groups, employees and
  published shifts into ClockOff's own `Location`, `Team`, `Employee` and `Shift` rows through the existing
  services, so `Shift.version`, `scheduleVersion`, silent pushes and activity stay correct (spec §0, §5).
- Syncs executed by the always-on worker: initial, every 15 minutes, manual (at most once a minute) and recovery
  runs, each an `IntegrationSyncRun` queued by web or by the worker's jobs and executed in resumable slices by the
  worker's integration runner, with live progress over the Postgres event bus (spec §5, §7).
- Connection health with banners, emails, notifications and a compliance flag (spec §6).
- A "How do you schedule your team?" onboarding question and a nine-step, resumable Planday wizard (spec §7).
- An Integrations page card with settings, history, a pending-employee queue and disconnect options (spec §9).
- A mock Planday that cannot run in production, used by unit, integration and Playwright tests (spec §11).
- Data minimisation: only the spec §8 fields are persisted, enforced by allow-list parsing and a test (spec §8).

### 1.2 Non-goals

- Writing anything to Planday. ClockOff only issues the `GET` calls in notes §9 plus the token and revocation
  calls on `id.planday.com`.
- Importing scheduled breaks. Planday's shift `GET` model has no break fields and the Payroll API is out of
  scope (notes §10.4). `ScheduledBreak` rows are not created by the sync; breaks keep following ClockOff Break
  Rules. The mapper keeps a typed `scheduledBreaks: []` slot so a future source can fill it.
- Webhooks (none exist, notes §11). Change detection is polling.
- Deriving Work Mode purely from clock events. `CLOCK_EVENT` is a Beta behind `PLANDAY_CLOCK_MODE_ENABLED`
  (default `false`) with the narrow semantics in section 6.8; scheduled activation remains the default and the
  fallback.
- Deputy, 7shifts, When I Work, Rotaready and Homebase stay `COMING_SOON`.
- A new Railway service or any HTTP endpoint that runs a job. The existing worker executes every sync.
- Any change under `apps/ios/**`. Devices keep enforcing their cached schedule (spec §6) and need no change:
  they already re-sync on `scheduleVersion`.

### 1.3 Definition of Done mapping (spec §15)

| Spec §15 clause                                                                                                                                                                                                          | Where it is built                                                         | What proves it                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A new org answers Planday, connects via method C against the mock, maps departments, selects employees, previews shifts, assigns policies, reaches Finish; the dashboard shows the right employees, locations and shifts | Sections 5.4, 9 (stages 5 and 6)                                          | `apps/web/e2e/planday-onboarding.spec.ts`; `apps/web/test/integration/planday/onboardingWizard.test.ts`                                                                                                                                                                                      |
| A and B work where configured and are hidden otherwise                                                                                                                                                                   | Sections 5.1 to 5.3 (stage 5)                                             | `test/integration/planday/connectMethods.test.ts` (env matrix); `components/onboarding/planday/connect-step.test.tsx` (render with and without env)                                                                                                                                          |
| A shift edited in the mock is updated within one sync and its version bump reaches device sync                                                                                                                           | Sections 6.6, 6.9 (stage 3)                                               | `test/integration/planday/syncShifts.test.ts` › "edit reaches GET /api/mobile/v1/sync"; e2e step "edit in mock → Sync now"                                                                                                                                                                   |
| A revoked refresh token gives the red banner, an email and a Notification within one sync cycle                                                                                                                          | Sections 4.3 (forced refresh at every SYNC's `PORTAL_CHECK`), 8 (stage 4) | `test/integration/planday/health.test.ts` › "revoked refresh token" and "refresh revoked, access tokens still valid"; e2e step "revoke in mock → banner → reconnect"                                                                                                                         |
| Nothing outside §8 persisted                                                                                                                                                                                             | Sections 4.7, 6 (stages 2 and 3)                                          | `test/integration/planday/dataMinimisation.test.ts` (database-wide sentinel scan plus log capture)                                                                                                                                                                                           |
| Sync twice changes nothing                                                                                                                                                                                               | Section 6.2 (stage 3)                                                     | `test/integration/planday/idempotency.test.ts`                                                                                                                                                                                                                                               |
| All tests pass, build clean, deployed                                                                                                                                                                                    | Section 15 gates; Gate D after every stage; stage 8 release               | Stage 8 gate log; release checks (`/api/health` `migrations: "up_to_date"`, `worker.jobs: "ok"`, `worker.integrations: "ok"`; worker logs show `integrations-sync` enqueuing and `integration slice finished` lines; the demo-portal gate recorded in the notes; a live method C connection) |
| `STATUS.md` states exactly what is needed to switch from mock to live                                                                                                                                                    | Section 14 (stage 8)                                                      | `docs/STATUS.md` › "Planday: switching from mock to live" (checklist content fixed in section 14)                                                                                                                                                                                            |

## 2. Data model

### 2.1 Migration strategy

Railway applies migrations in web's pre-deploy step (`/app/migrate.sh`: `prisma migrate deploy` over `DIRECT_URL`)
before the new web takes traffic. Until the new deployments are live, the previous web (15 s overlap) and the
previous worker (draining for up to 60 s) keep running against the new schema, and a Railway rollback redeploys an
older image onto it (migrations are forward-only). The migrations therefore MUST be **expand-only**: no dropped or
renamed columns, no new `NOT NULL` without a default, so older code keeps working against the new schema. The new
worker's migration gate waits for `up_to_date` against the new `LATEST_MIGRATION` before it runs jobs or the
integration runner.

- `IntegrationConnection`'s existing columns are reused under new Prisma field names with `@map`
  (`token_expires_at` → `accessTokenExpiresAt`, `last_sync_at` → `lastSuccessfulSyncAt`, `last_error` →
  `lastErrorMessage`). The physical names stay; older deployed code still reads them.
- `encrypted_credentials` becomes nullable and unused (Prisma field `legacyEncryptedCredentials`). Production has
  no `integration_connections` rows (every provider answered `COMING_SOON`), but the column is only dropped by a
  later contract migration after release (section 16.3).
- Enum values are added in their own migration (PostgreSQL cannot use a value added by `ALTER TYPE … ADD VALUE`
  in the same transaction).
- All Planday schema lands in stage 1, including the run-queue columns (section 7.3). A later stage that finds a
  gap adds its own expand-only migration that sorts after these and bumps `LATEST_MIGRATION`.

Migrations, in order. The names sort after `20261008090000_worker_runtime`, the latest migration on `main` on
2026-10-08; if another migration lands on `main` first, rename both folders (and `LATEST_MIGRATION`) so they sort
after it, before applying them anywhere:

| Migration                                | Content                                                                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `20261008140000_integration_enum_values` | `ALTER TYPE "ActivityEventType" ADD VALUE IF NOT EXISTS` for the five values in 2.2.                                               |
| `20261008140100_planday_integration`     | New enums, new columns on existing tables, new tables, indexes, partial unique indexes, check constraints, backfills (2.3 to 2.6). |

`packages/db/src/migrations.ts` `LATEST_MIGRATION` becomes `"20261008140100_planday_integration"`
(`migrations.test.ts` enforces it).

### 2.2 Enums

New enums (Prisma, mirrored in `packages/shared/src/enums.ts` and the `MIRROR` table of `enums.test.ts`, and in
`packages/validation/src/enumSchemas.ts`):

```prisma
/// How the organisation schedules its team (onboarding question, spec §7). Null until answered.
enum RotaSource {
  PLANDAY
  DEPUTY
  SEVENSHIFTS
  WHEN_I_WORK
  ROTAREADY
  HOMEBASE
  CSV
  MANUAL
  OTHER
}

/// Provenance of an Employee / Location / Team row. Shift keeps its own ShiftSource.
enum RecordSource {
  MANUAL
  CSV_IMPORT
  INTEGRATION
}

enum IntegrationAuthMethod {
  OAUTH
  CUSTOMER_ADDED_APP_ID
  CUSTOMER_OWN_APP
}

/// Fine-grained connection state (spec §2). Integration.status keeps the coarse state (2.3).
enum IntegrationConnectionStatus {
  CONNECTING
  CONNECTED
  SYNCING
  DEGRADED
  AUTH_ERROR
  DISCONNECTED
}

enum ExternalEntityType {
  EMPLOYEE
  LOCATION
  DEPARTMENT
  TEAM
  SHIFT
}

enum IntegrationSyncTrigger {
  INITIAL
  SCHEDULED
  MANUAL
  RECOVERY
}

enum IntegrationSyncRunStatus {
  RUNNING
  SUCCEEDED
  PARTIAL
  FAILED
}

/// What a run does (section 7.2). SYNC is the ordinary full sync.
enum IntegrationSyncRunKind {
  STRUCTURE
  DIRECTORY
  IMPORT_EMPLOYEES
  SYNC
  CLOCK
}

enum PendingExternalEmployeeReason {
  ONBOARDING
  NEW_EMPLOYEE
  AMBIGUOUS_MATCH
  /// One candidate, but the evidence is weak: an exact name only (after onboarding) or a raw CSV id that
  /// neither the email nor the name corroborates (6.5). The manager confirms; never auto-linked.
  POSSIBLE_MATCH
  PLAN_LIMIT
  /// A mapped employee Planday stopped returning without positive deactivation evidence for 24 h (6.5).
  MISSING_IN_PLANDAY
}

enum OnboardingSessionStatus {
  ACTIVE
  COMPLETED
  ABANDONED
}

enum IntegrationWizardStep {
  CONNECT
  CONFIRM_PORTAL
  LOCATIONS
  TEAMS
  EMPLOYEES
  SHIFT_PREVIEW
  POLICIES
  ACTIVATION
  FINISH
}
```

Values added to the existing `ActivityEventType` (first migration): `INTEGRATION_CONNECTED`,
`INTEGRATION_DISCONNECTED`, `INTEGRATION_SYNCED`, `EMPLOYEE_DEACTIVATED`, `EMPLOYEE_REACTIVATED`. Mirror them in
`ACTIVITY_EVENT_TYPES` (`packages/shared/src/enums.ts`) and give each copy in the activity feed model
(`apps/web/src/components/employees/activity-feed-model.ts` and the activity page columns).

`IntegrationStatus` (`NOT_CONNECTED`, `CONNECTED`, `ERROR`, `DISCONNECTED`) is unchanged and stays the coarse
status in `GET /api/integrations`. One function, `setConnectionStatus()` in
`apps/web/src/server/integrations/status.ts`, writes both statuses in one transaction. It is a compare-and-set:
`setConnectionStatus(tx, integrationId, next, { from: Status[], credentialVersion?, lastSyncAt? })` updates only
`WHERE status = ANY(from)` (plus the optional `credential_version` and `last_sync_at` guards) and returns whether a
row changed; a caller that loses the race does nothing else (no notification, no email). `DISCONNECTED` is only
ever left by a connect proof (5.6, 8.1).

| `IntegrationConnection.status`     | `Integration.status` |
| ---------------------------------- | -------------------- |
| `CONNECTING`                       | `NOT_CONNECTED`      |
| `CONNECTED`, `SYNCING`, `DEGRADED` | `CONNECTED`          |
| `AUTH_ERROR`                       | `ERROR`              |
| `DISCONNECTED`                     | `DISCONNECTED`       |

### 2.3 Changes to existing models

```prisma
model Organisation {
  // … existing fields …
  /// Spec §7 onboarding answer; null until answered.
  rotaSource          RotaSource? @map("rota_source")
  /// Free text when rotaSource = OTHER (≤ 200 chars, trimmed).
  rotaSourceOtherText String?     @map("rota_source_other_text") @db.VarChar(200)
  // relations added: externalEntityMaps, integrationMappingConfigs, integrationSyncRuns,
  // pendingExternalEmployees, integrationPreviewShifts, integrationOnboardingSessions,
  // integrationOAuthStates, integrationConnectLinks
}

model Employee {
  // … existing fields …
  source                 RecordSource @default(MANUAL)
  /// Set while a connected integration owns this row's managed fields (name, email, primary location).
  managedByIntegrationId String?      @map("managed_by_integration_id") @db.Uuid
  managedByIntegration   Integration? @relation("EmployeeManagedBy", fields: [managedByIntegrationId], references: [id], onDelete: SetNull)

  @@index([organisationId, managedByIntegrationId])
}

model Location {
  // … existing fields …
  source                 RecordSource @default(MANUAL)
  managedByIntegrationId String?      @map("managed_by_integration_id") @db.Uuid
  managedByIntegration   Integration? @relation("LocationManagedBy", fields: [managedByIntegrationId], references: [id], onDelete: SetNull)

  @@index([organisationId, managedByIntegrationId])
}

model Team {
  // … existing fields …
  source                 RecordSource @default(MANUAL)
  managedByIntegrationId String?      @map("managed_by_integration_id") @db.Uuid
  managedByIntegration   Integration? @relation("TeamManagedBy", fields: [managedByIntegrationId], references: [id], onDelete: SetNull)

  @@index([organisationId, managedByIntegrationId])
}

model Shift {
  // … existing fields (source ShiftSource already exists) …
  managedByIntegrationId String?      @map("managed_by_integration_id") @db.Uuid
  managedByIntegration   Integration? @relation("ShiftManagedBy", fields: [managedByIntegrationId], references: [id], onDelete: SetNull)

  @@index([organisationId, managedByIntegrationId, startsAt])
}

model Integration {
  // … existing fields (status, settings, activationMode, notifyRequested) unchanged …
  /// Activation mode for the integration's staff (spec §2 IntegrationMappingConfig.activation_mode lives here;
  /// Decision D-035). CLOCK_EVENT is accepted only when PLANDAY_CLOCK_MODE_ENABLED=true.
  // activationMode ActivationMode (existing)
  mappingConfig      IntegrationMappingConfig?
  syncRuns           IntegrationSyncRun[]
  entityMaps         ExternalEntityMap[]
  pendingEmployees   PendingExternalEmployee[]
  previewShifts      IntegrationPreviewShift[]
  onboardingSessions IntegrationOnboardingSession[]
  oauthStates        IntegrationOAuthState[]
  managedEmployees   Employee[] @relation("EmployeeManagedBy")
  managedLocations   Location[] @relation("LocationManagedBy")
  managedTeams       Team[]     @relation("TeamManagedBy")
  managedShifts      Shift[]    @relation("ShiftManagedBy")
}

model IntegrationConnection {
  id                         String                      @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  integrationId              String                      @unique @map("integration_id") @db.Uuid
  status                     IntegrationConnectionStatus @default(CONNECTING)
  statusChangedAt            DateTime                    @default(now()) @map("status_changed_at") @db.Timestamptz(6)
  authMethod                 IntegrationAuthMethod?      @map("auth_method")
  /// True when made against Mock Planday (PLANDAY_MODE=mock). A mock connection never reaches live Planday.
  isMock                     Boolean                     @default(false) @map("is_mock")
  /// Deprecated and unused (pre-Planday blob). Nullable now; dropped by a later contract migration.
  legacyEncryptedCredentials Bytes?                      @map("encrypted_credentials")
  /// AES-256-GCM (iv | tag | data), AAD "integration:<integrationId>:client_id". Stored for every method:
  /// a token is bound to the App ID that issued it (ClockOff's for A/B, the customer's for C).
  encryptedClientId          Bytes?                      @map("encrypted_client_id")
  /// AAD "integration:<integrationId>:refresh_token".
  encryptedRefreshToken      Bytes?                      @map("encrypted_refresh_token")
  /// Cached access token, AAD "integration:<integrationId>:access_token". Never logged.
  encryptedAccessToken       Bytes?                      @map("encrypted_access_token")
  accessTokenExpiresAt       DateTime?                   @map("token_expires_at") @db.Timestamptz(6)
  /// Last four characters of the refresh token, for "ending ••••4f2a". Nothing else is ever shown.
  credentialHint             String?                     @map("credential_hint") @db.VarChar(4)
  /// Incremented on every credential write (connect, refresh, rotation, wipe).
  credentialVersion          Int                         @default(0) @map("credential_version")
  refreshTokenRotatedAt      DateTime?                   @map("refresh_token_rotated_at") @db.Timestamptz(6)
  externalPortalId           String?                     @map("external_portal_id")
  externalPortalName         String?                     @map("external_portal_name")
  externalPortalTimezone     String?                     @map("external_portal_timezone")
  scopesGranted              String[]                    @default([]) @map("scopes_granted")
  connectedByUserId          String?                     @map("connected_by_user_id") @db.Uuid
  connectedAt                DateTime?                   @map("connected_at") @db.Timestamptz(6)
  disconnectedAt             DateTime?                   @map("disconnected_at") @db.Timestamptz(6)
  lastSuccessfulSyncAt       DateTime?                   @map("last_sync_at") @db.Timestamptz(6)
  /// Next quarter-hour slot (display) or, while consecutiveFailureCount > 0, when the recovery run is due (7.9).
  nextSyncAt                 DateTime?                   @map("next_sync_at") @db.Timestamptz(6)
  consecutiveFailureCount    Int                         @default(0) @map("consecutive_failure_count")
  lastErrorCode              String?                     @map("last_error_code")
  /// Sanitised: built from ClockOff's own message table, never from Planday response bodies. ≤ 300 chars.
  lastErrorMessage           String?                     @map("last_error")
  authErrorNotifiedAt        DateTime?                   @map("auth_error_notified_at") @db.Timestamptz(6)
  degradedNotifiedAt         DateTime?                   @map("degraded_notified_at") @db.Timestamptz(6)
  degradedEmailSentAt        DateTime?                   @map("degraded_email_sent_at") @db.Timestamptz(6)
  /// Lease that serialises every Planday request stream for this portal across web and worker (section 7.4).
  /// sync_lease_id is the holder's uuid and doubles as the fencing token checked in every write.
  syncLeaseId                String?                     @map("sync_lease_id") @db.Uuid
  syncLeaseExpiresAt         DateTime?                   @map("sync_lease_expires_at") @db.Timestamptz(6)
  /// High-water mark for GET /hr/v1.0/employees/deactivated?deactivatedFrom= (section 6.5).
  deactivationCheckedAt      DateTime?                   @map("deactivation_checked_at") @db.Timestamptz(6)
  /// High-water mark for GET /scheduling/v1.0/shifts/deleted?deletedFrom=; moved only when DELETED_SHIFTS
  /// completes (section 6.6).
  deletedShiftsCheckedAt     DateTime?                   @map("deleted_shifts_checked_at") @db.Timestamptz(6)
  /// "Next run" slot (section 7.3): a request for a run of another kind (or a fresh SYNC) made while a run is
  /// active. Drained by the active run's terminal write, in the same transaction.
  pendingRunKind             IntegrationSyncRunKind?     @map("pending_run_kind")
  pendingRunTrigger          IntegrationSyncTrigger?     @map("pending_run_trigger")
  pendingRunRetryAuth        Boolean                     @default(false) @map("pending_run_retry_auth")
  pendingRunRequestedByUserId String?                    @map("pending_run_requested_by_user_id") @db.Uuid
  pendingRunRequestedAt      DateTime?                   @map("pending_run_requested_at") @db.Timestamptz(6)
  /// Automatic auth probes made since the connection entered AUTH_ERROR (section 7.9 step 3).
  authProbeAttempts          Int                         @default(0) @map("auth_probe_attempts")
  createdAt                  DateTime                    @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt                  DateTime                    @updatedAt @map("updated_at") @db.Timestamptz(6)

  integration     Integration @relation(fields: [integrationId], references: [id], onDelete: Cascade)
  connectedByUser User?       @relation("IntegrationConnectedBy", fields: [connectedByUserId], references: [id], onDelete: SetNull)

  @@index([status, nextSyncAt])
  @@map("integration_connections")
}
```

`disconnect` no longer deletes the `IntegrationConnection` row: it wipes the three encrypted columns and the
hint, sets `DISCONNECTED`, and keeps `externalPortalId` so a reconnect can be checked against the same portal
(section 5.7). The existing test `apps/web/test/integration/integrations.test.ts` (asserts the row count is 0
after disconnect, and creates rows with `encryptedCredentials`) is updated in stage 1.

`externalPortalId` holds the bare Planday portal id (`"4100001"`). A partial unique index (2.5) allows one live,
non-mock connection per portal across all organisations (Decision D-054), which is what makes the per-connection
lease (7.4) a per-portal lease.

### 2.4 New models

```prisma
/// Planday id ↔ ClockOff id for every synced entity. Makes syncs idempotent (spec §2).
model ExternalEntityMap {
  id                String              @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  organisationId    String              @map("organisation_id") @db.Uuid
  integrationId     String              @map("integration_id") @db.Uuid
  provider          IntegrationProvider
  entityType        ExternalEntityType  @map("entity_type")
  /// The provider's id as a decimal string (Planday int64 ids; ids are unique only within the portal).
  externalId        String              @map("external_id")
  /// Employee / Location / Department / Team / Shift id, by entityType. Polymorphic: no FK.
  internalId        String              @map("internal_id") @db.Uuid
  lastSeenAt        DateTime            @map("last_seen_at") @db.Timestamptz(6)
  /// HMAC-SHA256 (key derived from INTEGRATION_ENCRYPTION_KEY) of the decision inputs (section 6.2): the
  /// canonical mapped record, its classification and its resolved ClockOff targets. Null = re-decide.
  lastHash          String?             @map("last_hash")
  /// The integration removed or cancelled the entity (shift cancelled by a sync or by a CANCEL_FUTURE_SHIFTS
  /// disconnect, employee deactivated, department missing). Marks the entity as eligible for REINSTATE /
  /// reactivation; a manager action never sets it.
  upstreamRemovedAt DateTime?           @map("upstream_removed_at") @db.Timestamptz(6)
  /// EMPLOYEE only: first run in which Planday stopped returning a mapped employee without positive
  /// deactivation evidence (section 6.5). Cleared when the employee is seen again.
  upstreamMissingSince DateTime?        @map("upstream_missing_since") @db.Timestamptz(6)
  /// EMPLOYEE only: the manager chose "Keep" on the MISSING_IN_PLANDAY review; no new review until seen again.
  reviewDismissedAt DateTime?           @map("review_dismissed_at") @db.Timestamptz(6)
  createdAt         DateTime            @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt         DateTime            @updatedAt @map("updated_at") @db.Timestamptz(6)

  organisation Organisation @relation(fields: [organisationId], references: [id], onDelete: Cascade)
  integration  Integration  @relation(fields: [integrationId], references: [id], onDelete: Cascade)

  @@unique([integrationId, entityType, externalId])
  @@index([integrationId, entityType, internalId])
  @@index([integrationId, entityType, lastSeenAt])
  @@index([organisationId, entityType, internalId])
  @@map("external_entity_maps")
}

model IntegrationMappingConfig {
  id                      String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  organisationId          String    @map("organisation_id") @db.Uuid
  integrationId           String    @unique @map("integration_id") @db.Uuid
  /// Planday department ids (decimal strings) whose employees and shifts are synced. Source of truth for
  /// inclusion; a department not listed is excluded. The pseudo-id "none" stands for "not in any department"
  /// (employees with an empty departments[], shifts with departmentId null; section 6.3).
  includedDepartmentIds   String[]  @default([]) @map("included_department_ids")
  /// { "<deptId>": { "target": "LOCATION", "locationId": uuid } | { "target": "DEPARTMENT", "departmentId": uuid } }
  /// for included departments only. Validated by departmentMappingsSchema (@clockoff/validation/planday).
  departmentMappings      Json      @default("{}") @map("department_mappings")
  /// { "<groupId>": { "target": "TEAM", "teamId": uuid } }; a group not listed is not mapped to a team.
  groupMappings           Json      @default("{}") @map("group_mappings")
  /// Planday employee ids the manager left unticked (step 5) or dismissed from the pending queue.
  excludedEmployeeIds     String[]  @default([]) @map("excluded_employee_ids")
  autoIncludeNewEmployees Boolean   @default(true) @map("auto_include_new_employees")
  /// Persist Planday's `email` on employees (step 5 toggle, settings). Off: the address is used in memory for
  /// matching only and never stored; email is then not a managed field. Default pending owner decision D-042.
  importEmails            Boolean   @default(true) @map("import_emails")
  syncWindowDays          Int       @default(28) @map("sync_window_days")
  /// Skip published shifts on days Planday hides from employees (scheduleDay.isVisible = false). Off by default
  /// until the owner signs off notes §10.1 rule 3 (Decision D-040, owner decision).
  respectHiddenDays       Boolean   @default(false) @map("respect_hidden_days")
  /// Department and employee-group catalogue from the last structure read (names, numbers, employee counts).
  /// Not personal data. Validated by plandayCatalogSchema.
  catalog                 Json      @default("{}")
  /// Incremented on every mapping or settings change. Not part of lastHash (6.2); a run compares its snapshot
  /// at FINALISE and queues a follow-up of its own kind when it moved (7.2).
  mappingVersion          Int       @default(1) @map("mapping_version")
  /// Set at wizard Finish. SYNC and CLOCK runs, scheduled syncs, recovery, auth probes and health monitoring
  /// require it (7.3); before it only the wizard's STRUCTURE, DIRECTORY and IMPORT_EMPLOYEES runs exist.
  onboardingCompletedAt   DateTime? @map("onboarding_completed_at") @db.Timestamptz(6)
  createdAt               DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt               DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)

  organisation Organisation @relation(fields: [organisationId], references: [id], onDelete: Cascade)
  integration  Integration  @relation(fields: [integrationId], references: [id], onDelete: Cascade)

  @@map("integration_mapping_configs")
}

model IntegrationSyncRun {
  id                String                   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  organisationId    String                   @map("organisation_id") @db.Uuid
  integrationId     String                   @map("integration_id") @db.Uuid
  trigger           IntegrationSyncTrigger
  kind              IntegrationSyncRunKind   @default(SYNC)
  status            IntegrationSyncRunStatus @default(RUNNING)
  /// Current phase name (section 7.2) and its resumable cursor.
  phase             String                   @default("START")
  cursor            Json                     @default("{}")
  /// { completedPhases: string[], totalPhases: number, label: string, pagesRead: number } for the wizard (7.11).
  progress          Json                     @default("{}")
  /// Per entity type: { employees: { created, updated, cancelled, skipped }, locations, teams, shifts, clockEvents,
  /// pending, excluded: { drafts, open, hiddenDays, unknownStatus, outOfScope } }.
  counts            Json                     @default("{}")
  /// Record-level problems, at most 100: [{ code, message, externalId }]. No personal data in message.
  warnings          Json                     @default("[]")
  requestCount      Int                      @default(0) @map("request_count")
  attempt           Int                      @default(0)
  /// Not claimable before this instant: scheduled jitter, rate-limit park, retry backoff (7.3, 7.10).
  resumeAfter       DateTime?                @map("resume_after") @db.Timestamptz(6)
  /// Last committed step (written by the step transaction's fence, 7.6).
  heartbeatAt       DateTime?                @map("heartbeat_at") @db.Timestamptz(6)
  /// Queue order, lower first: 0 interactive (wizard, manual, settings), 1 clock, 2 recovery, 3 scheduled (7.3).
  /// Applies to a run's first slice; a started run competes at max(priority, 3) (7.3).
  priority          Int                      @default(3) @db.SmallInt
  /// IntegrationMappingConfig.mappingVersion when the run was queued; FINALISE enqueues a follow-up if it moved.
  mappingVersion    Int                      @default(1) @map("mapping_version")
  /// Manual auth retry or automatic auth probe: the only runs allowed to start on AUTH_ERROR (7.10).
  retryAuth         Boolean                  @default(false) @map("retry_auth")
  /// INITIAL SYNC only: manual/CSV shifts the manager ticked at wizard step 6, cancelled one by one in the
  /// transaction that creates their Planday replacement (6.6 Overlaps).
  replaceShiftIds   String[]                 @default([]) @map("replace_shift_ids") @db.Uuid
  /// First time a worker claimed the run; null = still queued ("Waiting to start").
  firstClaimedAt    DateTime?                @map("first_claimed_at") @db.Timestamptz(6)
  /// End of the last slice; runs of equal priority are claimed round-robin by it.
  lastSliceAt       DateTime?                @map("last_slice_at") @db.Timestamptz(6)
  /// Worker instance id executing the run (diagnostics only; the connection lease is authoritative).
  claimedBy         String?                  @map("claimed_by") @db.VarChar(128)
  requestedByUserId String?                  @map("requested_by_user_id") @db.Uuid
  startedAt         DateTime                 @default(now()) @map("started_at") @db.Timestamptz(6)
  finishedAt        DateTime?                @map("finished_at") @db.Timestamptz(6)
  errorCode         String?                  @map("error_code")
  errorMessage      String?                  @map("error_message")
  createdAt         DateTime                 @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt         DateTime                 @updatedAt @map("updated_at") @db.Timestamptz(6)

  organisation  Organisation              @relation(fields: [organisationId], references: [id], onDelete: Cascade)
  integration   Integration               @relation(fields: [integrationId], references: [id], onDelete: Cascade)
  requestedBy   User?                     @relation("IntegrationSyncRunRequestedBy", fields: [requestedByUserId], references: [id], onDelete: SetNull)
  previewShifts IntegrationPreviewShift[]

  @@index([integrationId, startedAt(sort: Desc)])
  @@index([status, resumeAfter])
  @@index([organisationId, startedAt(sort: Desc)])
  @@map("integration_sync_runs")
}

/// A Planday employee waiting for a manager: wizard candidates (ONBOARDING), new employees when
/// autoIncludeNewEmployees is off, ambiguous and possible matches, plan-limit overflow, and mapped employees
/// missing from Planday (MISSING_IN_PLANDAY: names copied from the ClockOff employee, matchedEmployeeId = it).
/// A row exists only while pending; resolving it (import, link, dismiss, deactivate, keep) deletes it in the
/// same transaction (data minimisation).
model PendingExternalEmployee {
  id                          String                        @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  organisationId              String                        @map("organisation_id") @db.Uuid
  integrationId               String                        @map("integration_id") @db.Uuid
  provider                    IntegrationProvider
  externalId                  String                        @map("external_id")
  firstName                   String                        @map("first_name")
  lastName                    String                        @map("last_name")
  /// Planday `email` while the row is pending (D-042, owner decision). Null when Planday has none, and after
  /// onboarding also when importEmails is off (hasEmail keeps the "missing email" flag).
  workEmail                   String?                       @map("work_email") @db.Citext
  hasEmail                    Boolean                       @default(false) @map("has_email")
  externalDepartmentIds       String[]                      @default([]) @map("external_department_ids")
  primaryExternalDepartmentId String?                       @map("primary_external_department_id")
  externalGroupIds            String[]                      @default([]) @map("external_group_ids")
  reason                      PendingExternalEmployeeReason
  /// Existing ClockOff employee matched by external id or email (wizard "matched" flag), the single candidate
  /// of a POSSIBLE_MATCH, or the mapped employee of a MISSING_IN_PLANDAY row.
  matchedEmployeeId           String?                       @map("matched_employee_id") @db.Uuid
  /// EXTERNAL_ID | EXTERNAL_ID_RAW | EMAIL | NAME (section 6.5).
  matchSignal                 String?                       @map("match_signal")
  /// ClockOff employees sharing the exact full name when the match is ambiguous.
  candidateEmployeeIds        String[]                      @default([]) @map("candidate_employee_ids") @db.Uuid
  firstSeenAt                 DateTime                      @default(now()) @map("first_seen_at") @db.Timestamptz(6)
  lastSeenAt                  DateTime                      @default(now()) @map("last_seen_at") @db.Timestamptz(6)
  createdAt                   DateTime                      @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt                   DateTime                      @updatedAt @map("updated_at") @db.Timestamptz(6)

  organisation    Organisation @relation(fields: [organisationId], references: [id], onDelete: Cascade)
  integration     Integration  @relation(fields: [integrationId], references: [id], onDelete: Cascade)
  matchedEmployee Employee?    @relation("PendingExternalEmployeeMatch", fields: [matchedEmployeeId], references: [id], onDelete: SetNull)

  @@unique([integrationId, externalId])
  @@index([organisationId, integrationId, reason])
  @@map("pending_external_employees")
}

/// Shift preview for wizard step 6 (next 14 days). Spec §8 shift fields only; purged at Finish, abandon and
/// disconnect.
model IntegrationPreviewShift {
  id                   String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  organisationId       String   @map("organisation_id") @db.Uuid
  integrationId        String   @map("integration_id") @db.Uuid
  syncRunId            String   @map("sync_run_id") @db.Uuid
  externalShiftId      String   @map("external_shift_id")
  externalEmployeeId   String   @map("external_employee_id")
  externalDepartmentId String?  @map("external_department_id")
  startsAt             DateTime @map("starts_at") @db.Timestamptz(6)
  endsAt               DateTime @map("ends_at") @db.Timestamptz(6)
  timezone             String
  isOvernight          Boolean  @map("is_overnight")
  /// DST warning from the shared resolver, e.g. AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE.
  timeWarning          String?  @map("time_warning")
  createdAt            DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  organisation Organisation       @relation(fields: [organisationId], references: [id], onDelete: Cascade)
  integration  Integration        @relation(fields: [integrationId], references: [id], onDelete: Cascade)
  syncRun      IntegrationSyncRun @relation(fields: [syncRunId], references: [id], onDelete: Cascade)

  @@unique([integrationId, externalShiftId])
  @@index([integrationId, startsAt])
  @@map("integration_preview_shifts")
}

/// Resumable wizard (spec §7). At most one ACTIVE session per organisation and provider (partial unique index).
model IntegrationOnboardingSession {
  id              String                  @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  organisationId  String                  @map("organisation_id") @db.Uuid
  integrationId   String                  @map("integration_id") @db.Uuid
  provider        IntegrationProvider
  status          OnboardingSessionStatus @default(ACTIVE)
  currentStep     IntegrationWizardStep   @default(CONNECT) @map("current_step")
  completedSteps  IntegrationWizardStep[] @default([]) @map("completed_steps")
  /// Step drafts and choices; validated by plandayOnboardingStateSchema (section 9.3).
  state           Json                    @default("{}")
  structureRunId  String?                 @map("structure_run_id") @db.Uuid
  directoryRunId  String?                 @map("directory_run_id") @db.Uuid
  importRunId     String?                 @map("import_run_id") @db.Uuid
  finalRunId      String?                 @map("final_run_id") @db.Uuid
  startedByUserId String?                 @map("started_by_user_id") @db.Uuid
  lastActivityAt  DateTime                @default(now()) @map("last_activity_at") @db.Timestamptz(6)
  completedAt     DateTime?               @map("completed_at") @db.Timestamptz(6)
  createdAt       DateTime                @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt       DateTime                @updatedAt @map("updated_at") @db.Timestamptz(6)

  organisation Organisation @relation(fields: [organisationId], references: [id], onDelete: Cascade)
  integration  Integration  @relation(fields: [integrationId], references: [id], onDelete: Cascade)
  startedBy    User?        @relation("OnboardingSessionStartedBy", fields: [startedByUserId], references: [id], onDelete: SetNull)

  @@index([organisationId, provider, status])
  @@map("integration_onboarding_sessions")
}

/// OAuth `state` for method A: signed, single-use, 10-minute expiry, bound to organisation + user (spec §1A).
model IntegrationOAuthState {
  id                    String              @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  organisationId        String              @map("organisation_id") @db.Uuid
  integrationId         String              @map("integration_id") @db.Uuid
  provider              IntegrationProvider
  userId                String              @map("user_id") @db.Uuid
  /// sha256 hex of the full state token.
  stateHash             String              @unique @map("state_hash")
  redirectUri           String              @map("redirect_uri")
  /// PKCE verifier (only when PLANDAY_OAUTH_PKCE=true), AES-256-GCM with AAD "oauth_state:<id>".
  encryptedCodeVerifier Bytes?              @map("encrypted_code_verifier")
  /// Allow-listed in-app path to return to: "/onboarding/planday" or "/integrations".
  returnTo              String              @map("return_to")
  /// The manager confirmed "Use a different portal" (5.7); honoured only while the connection is DISCONNECTED.
  allowPortalSwitch     Boolean             @default(false) @map("allow_portal_switch")
  expiresAt             DateTime            @map("expires_at") @db.Timestamptz(6)
  consumedAt            DateTime?           @map("consumed_at") @db.Timestamptz(6)
  createdAt             DateTime            @default(now()) @map("created_at") @db.Timestamptz(6)

  organisation Organisation @relation(fields: [organisationId], references: [id], onDelete: Cascade)
  integration  Integration  @relation(fields: [integrationId], references: [id], onDelete: Cascade)
  user         User         @relation("IntegrationOAuthStateUser", fields: [userId], references: [id], onDelete: Cascade)

  @@index([expiresAt])
  @@map("integration_oauth_states")
}

/// Shareable "connect Planday" link (spec §7). Opens the wizard for an authenticated OWNER/ADMIN of this org.
model IntegrationConnectLink {
  id              String              @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  organisationId  String              @map("organisation_id") @db.Uuid
  provider        IntegrationProvider
  createdByUserId String?             @map("created_by_user_id") @db.Uuid
  /// sha256 hex of the random token in the URL.
  tokenHash       String              @unique @map("token_hash")
  /// Set when the link was sent with an ADMIN invite to someone not yet in the organisation (section 9.7).
  managerInviteId String?             @map("manager_invite_id") @db.Uuid
  expiresAt       DateTime            @map("expires_at") @db.Timestamptz(6)
  revokedAt       DateTime?           @map("revoked_at") @db.Timestamptz(6)
  lastUsedAt      DateTime?           @map("last_used_at") @db.Timestamptz(6)
  useCount        Int                 @default(0) @map("use_count")
  createdAt       DateTime            @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt       DateTime            @updatedAt @map("updated_at") @db.Timestamptz(6)

  organisation  Organisation   @relation(fields: [organisationId], references: [id], onDelete: Cascade)
  createdBy     User?          @relation("IntegrationConnectLinkCreatedBy", fields: [createdByUserId], references: [id], onDelete: SetNull)
  managerInvite ManagerInvite? @relation(fields: [managerInviteId], references: [id], onDelete: SetNull)

  @@index([organisationId, provider])
  @@map("integration_connect_links")
}
```

`User` gains the back-relations named above (`IntegrationConnectedBy`, `IntegrationSyncRunRequestedBy`,
`OnboardingSessionStartedBy`, `IntegrationOAuthStateUser`, `IntegrationConnectLinkCreatedBy`); `Employee` gains
`pendingMatches PendingExternalEmployee[] @relation("PendingExternalEmployeeMatch")`; `ManagerInvite` gains
`connectLinks IntegrationConnectLink[]`.

### 2.5 Hand-written SQL in `20261008140100_planday_integration`

Generated by `prisma migrate dev --create-only --name planday_integration`, then edited to:

1. Make `integration_connections.encrypted_credentials` nullable (`ALTER COLUMN … DROP NOT NULL`). Prisma
   would otherwise propose dropping and re-adding renamed fields; the `@map` names above avoid that, and the
   builder MUST check the generated SQL contains no `DROP COLUMN` and no `RENAME`.
2. Partial unique indexes Prisma cannot express:

   ```sql
   -- One active (RUNNING: queued or started) run per integration: the run queue (section 7.3).
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
   -- provider with connections; a second provider adds its provider to this key in its own migration.
   CREATE UNIQUE INDEX "integration_connections_one_live_portal"
     ON "integration_connections" ("external_portal_id")
     WHERE "external_portal_id" IS NOT NULL AND "status" <> 'DISCONNECTED' AND "is_mock" = false;
   ```

   A connect transaction that hits this index (P2002 on `integration_connections_one_live_portal`) answers
   `INTEGRATION_PORTAL_IN_USE` (409: "This Planday portal is already connected to another ClockOff
   organisation. Disconnect it there first, or contact support."); nothing about the other organisation is
   revealed.

3. Check constraints:

   ```sql
   ALTER TABLE "integration_mapping_configs"
     ADD CONSTRAINT "integration_mapping_configs_sync_window_days_check"
     CHECK ("sync_window_days" BETWEEN 7 AND 56);
   ALTER TABLE "organisations"
     ADD CONSTRAINT "organisations_rota_source_other_text_check"
     CHECK ("rota_source" = 'OTHER' OR "rota_source_other_text" IS NULL);
   ALTER TABLE "integration_connections"
     ADD CONSTRAINT "integration_connections_credential_hint_check"
     CHECK ("credential_hint" IS NULL OR char_length("credential_hint") <= 4);
   ALTER TABLE "integration_sync_runs"
     ADD CONSTRAINT "integration_sync_runs_priority_check"
     CHECK ("priority" BETWEEN 0 AND 3);
   ```

4. Backfills (2.7).

### 2.6 Reuse versus extend

| Existing object                          | Treatment                                                                                                                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Integration` (one per org and provider) | Reused as the anchor for everything Planday. `status` stays coarse; `activationMode` is the activation mode; `settings` JSON is no longer written for Planday (portal data lives on the connection).                |
| `IntegrationConnection`                  | Extended (2.3). One row per integration for its lifetime; secrets wiped on disconnect, row kept.                                                                                                                    |
| `ClockEvent`                             | Reused unchanged: `source = "PLANDAY"`, `externalId = "<portalId>:<punchClockShiftId>:in"` / `":out"` / `"<portalId>:<breakId>:start"` / `":end"`; unique `(organisationId, source, externalId)` gives idempotency. |
| `Employee.externalEmployeeId`            | Set to `PLANDAY:<portalId>:<employeeId>` when it is null; left untouched when a CSV import already set it (the CSV value may be the raw Planday id; section 6.5).                                                   |
| `Shift.externalShiftId`, `Shift.source`  | `PLANDAY:<portalId>:<shiftId>` and `INTEGRATION` for every synced shift.                                                                                                                                            |

**Portal-qualified external ids (Decision D-050).** Planday ids are unique only within a portal (notes §2), and
`externalEmployeeId`, `externalShiftId` and `ClockEvent.externalId` are unique per organisation. Every value the
sync writes therefore carries the portal id, so an organisation that switches portals (5.7) can never collide with
the old portal's rows (no cross-link, no `P2002`). `ExternalEntityMap.externalId` stays the bare Planday id: map
rows belong to one integration, and `resetIntegrationMappings` deletes them on a portal switch.
`packages/integrations/src/planday/constants.ts` exports `plandayEmployeeExternalId(portalId, id)`,
`plandayShiftExternalId(portalId, id)` and `plandayClockEventExternalId(portalId, id, suffix)`; nothing else
formats these strings.
| `Integration.settings.locationMap` | Not used. `docs/INTEGRATIONS.md`'s interim JSON maps are replaced by `ExternalEntityMap`; the doc is updated in stage 8. |

### 2.7 Backfill rules

- `employees.source`, `locations.source`, `teams.source`: default `MANUAL` for every existing row. CSV-created
  employees cannot be told apart reliably (they are created through `createEmployee` during import corrections),
  so they stay `MANUAL`. Documented in `docs/DATABASE.md`.
- `managed_by_integration_id`: null everywhere (no provider was ever connected).
- `integration_connections`: `status = 'DISCONNECTED'` for any existing row, `CONNECTING` default otherwise. The
  migration contains a guard that only logs (`RAISE NOTICE`) the number of rows; production has none.
- `organisations.rota_source`: null (existing orgs are asked on the overview, section 9.4).

### 2.8 Mirrors and constants to update with the schema (stage 1)

`packages/shared/src/enums.ts` (+ `enums.test.ts` `MIRROR`), `packages/validation/src/enumSchemas.ts`,
`packages/db/src/migrations.ts` (`LATEST_MIGRATION`), `apps/web/src/server/integrations/integrations.repository.ts`
(`integrationInclude` field names), `apps/web/src/server/compliance/compliance.repository.ts` and
`compliance.service.ts` (`lastSyncAt` → `lastSuccessfulSyncAt`, `lastError` → `lastErrorMessage`; API field names
stay `lastSyncAt` / `lastError`), `apps/web/test/integration/integrations.test.ts`, `docs/DATABASE.md`.

## 3. Module layout

### 3.1 Tree

```text
packages/integrations/                         @clockoff/integrations (new workspace package)
  package.json                                 deps: @clockoff/shared, zod 4.6.5 (no Prisma, no Next, no pino)
  tsconfig.json  eslint.config.js  vitest.config.ts
  src/index.ts                                 barrel: createPlandayProvider, types, core (never the mock)
  src/core/                                    provider-agnostic, pure, no I/O
    deadline.ts                                Deadline (remainingMs, expired(minMs)): the connect proof's bound
    backoff.ts                                 fullJitterBackoff(attempt, { baseMs, capMs }, random)
    rateLimiter.ts                             TokenBucket, SlidingWindowBudget, KeyedSerialQueue
    hash.ts                                    canonicalJson(value), RecordHasher type (HMAC injected by caller)
    window.ts                                  syncWindow(now, timezone, days) → { from, to, queryFrom, queryTo }
    shiftDecisions.ts                          decideShiftAction() (section 6.6 table)
    employeeDecisions.ts                       matchExternalEmployee(), decideEmployeeAction() (section 6.5)
    locationDecisions.ts                       decideDepartmentAction(), decideGroupAction() (sections 6.3, 6.4)
    index.ts
  src/planday/
    constants.ts                               base URLs, paths, PLANDAY_OAUTH_SCOPES, REQUIRED_SCOPES, page limits,
                                               KNOWN_PUBLISHED_STATUSES, EXCLUDED_STATUSES
    errors.ts                                  PlandayError, PlandayErrorCode, toProviderError()
    schemas.ts                                 Zod response schemas (allow-list; unknown keys stripped)
    mappers.ts                                 allow-list mappers raw → External* records
    time.ts                                    parsePlandayDateTime(), toShiftInstants()
    tokens.ts                                  exchangeCode(), refreshToken(), revokeToken(); TokenResponse schema
    http.ts                                    PlandayHttp: request(), headers, retries, 429, timeouts, logging
    pagination.ts                              paginate() / fetchPage()
    client.ts                                  PlandayClient: one method per notes §9 endpoint + probeScopes()
    authorizeUrl.ts                            buildAuthorizeUrl({ clientId, redirectUri, state, codeChallenge? })
    phases.ts                                  phase step functions per run kind (section 7.2)
    provider.ts                                PlandayProvider implements ResumableWorkforceProvider
    logging.ts                                 PlandayLogger interface, pathTemplate(), describeZodIssues()
    index.ts
    mock/                                      exported only as "@clockoff/integrations/planday/mock"
      index.ts  server.ts  routes.ts  oauth.ts  fixture.ts  controls.ts  guard.ts
      httpServer.ts                            startMockPlandayHttpServer(): the same handler over HTTP (12.1)
apps/web/src/server/integrations/              existing folder, extended
  integrations.service.ts                      generic list / notify-me; delegates PLANDAY connect/disconnect/sync
  integrations.repository.ts                   updated field names
  providers.ts                                 ensureProvidersRegistered(): registers Planday when PLANDAY_ENABLED
  transport.ts                                 getPlandayTransport(): live fetch, mock server (PLANDAY_MOCK_URL) or test
  credentials.ts                               PrismaCredentialStore: lease-guarded refresh (4.3), AAD encryption
  status.ts                                    setConnectionStatus(), coarseStatus()
  health.ts                                    evaluateIntegrationHealth(), enterAuthError(), reconnectHref(), banners (section 8)
  notifications.ts                             auth-error, degraded and new-employee notifications and emails (8.4)
  hasher.ts                                    recordHasher(): HMAC-SHA256 keyed from INTEGRATION_ENCRYPTION_KEY
  scheduledSync.ts                             runScheduledIntegrationSyncs(): the 15-minute slot (7.8)
  upkeep.ts                                    runIntegrationsUpkeep(): the per-minute upkeep job (7.9)
  runs/constants.ts                            LEASE_TTL_MS, SLICE_MAX_MS, RUNNER_POLL_MS, RUN_PRIORITY, runnerConcurrency()
  runs/runs.repository.ts                      claimDueRuns, acquire/renew/releaseLease, persistStep, finish/fail/parkRun
  runs/enqueue.ts                              enqueueRun() (onboarding gate, pending slot), announceRunQueued(),
                                               recoveryBackoffMs(), probeBackoffMs()
  runs/executor.ts                             runSyncSlice() (7.6)
  runs/progress.ts                             publishRunProgress(): throttled bus events (7.11)
  sink/applySink.ts                            applies batches to ClockOff entities (section 6)
  sink/stagingSink.ts                          catalogue, PendingExternalEmployee and preview rows
  sink/entityMaps.repository.ts                ExternalEntityMap reads/writes, batched
  planday/planday.service.ts                   connect A/B/C, callback, reconnect, disconnect, sync now
  planday/settings.service.ts                  GET / PATCH settings (10.2)
  planday/oauthState.ts                        createOAuthState(), consumeOAuthState()
  planday/connectLinks.ts                      create / list / revoke / resolve
  planday/pendingEmployees.service.ts          list / resolve
  planday/onboarding.service.ts                wizard session and steps 2 to 9
  planday/preview.service.ts                   step 6 preview and conflicts
  planday/starterPolicies.ts                   "Standard Staff" / "Standard Break"
  planday/dto.ts                               row → @clockoff/validation/planday DTOs
apps/web/src/server/shifts/shifts.internal.ts  helpers extracted from shifts.service.ts (ShiftActor-based)
apps/web/src/server/shifts/shifts.integration.ts   createIntegrationShifts / reschedule / cancel / reinstate
apps/web/src/server/employees/employees.integration.ts   import, link, update managed fields, deactivate, reactivate
apps/web/src/server/locations/locations.integration.ts   create / rename managed locations
apps/web/src/server/teams/teams.integration.ts           create / rename managed teams, sync memberships
apps/web/src/worker/                           worker process (never imported by web)
  integrationRunner.ts                         createIntegrationRunner(): wake-ups, claims, concurrency, halt/drain (7.5)
  jobs.ts                                      + integrations-upkeep; integrations-sync reports `enqueued`
  lockKeys.ts                                  + integrationsUpkeep (key 6)
  cli.ts, shutdown.ts                          runner wiring: start after the migration gate, halt and drain (7.7)
apps/web/scripts/mock-planday.mts              development and Playwright: the shared mock server (refuses production)
docker/web/Dockerfile, docker/worker/Dockerfile   COPY packages/integrations/package.json before pnpm install
.railway/railway.ts                            PLANDAY_* variable names (appendix A)
```

`next.config.ts` `transpilePackages` gains `"@clockoff/integrations"`; `apps/web/package.json` gains
`"@clockoff/integrations": "workspace:*"`. Package exports: `"."`, `"./core"`, `"./planday"`,
`"./planday/mock"`.

### 3.2 Dependency direction

```text
@clockoff/shared  ←  @clockoff/integrations  ←  apps/web/src/server/integrations/**  ←  API routes / jobs
        ↑                                                  │ writes through
        │                                                  ▼
  Work Mode engine (shared/workMode, web server/workState, server/sync, server/breaks) reads Shift rows only
```

Rules, enforced in stage 1 and tested:

- `packages/shared/**` and `packages/validation/**` never import `@clockoff/integrations`. ESLint
  `no-restricted-imports` in `packages/shared/eslint.config.js` and `packages/validation/eslint.config.js`.
- `packages/integrations/**` never imports `@clockoff/db`, `next`, `pino` or `apps/web` (its `package.json` has no
  such dependency; ESLint rule as a second line).
- In `apps/web`, only `src/server/integrations/**`, `src/app/api/integrations/**`, `src/app/api/dev/mock-planday/**`
  and `scripts/mock-planday.mts` may import `@clockoff/integrations`; the worker reaches it only through
  `src/server/integrations/**`. Test:
  `apps/web/src/server/integrations/dependencyDirection.test.ts` scans import specifiers under
  `src/server/{workState,sync,breaks,shifts,employees}` and `packages/shared/src/workMode` and fails on any
  `@clockoff/integrations` or `server/integrations` import. (The shifts and employees modules expose
  integration writers but never import integration code.)

### 3.3 Public interfaces (additions to `packages/shared/src/providers`)

All additions are additive; `ComingSoonProvider` keeps compiling.

```ts
// workforceProvider.ts
export const SYNC_ERROR_CODES = [/* existing */ "INVALID_RESPONSE"] as const; // new code, not retryable

export interface ProviderContext {
  // … existing fields …
  /** Credential persistence with an atomic refresh hook (section 4.3). Required by sync and refresh. */
  readonly credentialStore?: CredentialStore;
  /** The connect proof's bound in web (5.6): providers start no request they cannot finish before it. */
  readonly deadline?: { remainingMs(): number };
  /**
   * Worker shutdown or a lost lease (7.7): checked before every request and combined with each API request's
   * timeout. Token, code-exchange and revocation requests ignore it.
   */
  readonly signal?: AbortSignal;
  readonly log?: ProviderLogger;
}

// credentialStore.ts (new)
export interface StoredCredentials {
  readonly clientId: string;
  readonly refreshToken: string;
  readonly accessToken: string | null;
  readonly accessTokenExpiresAt: Date | null;
}
export interface CredentialStore {
  read(): Promise<StoredCredentials>;
  /**
   * Runs under the caller's per-portal sync lease (7.4). If the stored access token is still valid for
   * `minValidityMs`, resolves with it and never calls `exchange`. Otherwise calls `exchange(current)` with no
   * database connection held, then persists `next` (access and refresh token) in one UPDATE guarded by
   * `credential_version` and the lease, and resolves only after it committed. Rejects with
   * CredentialPersistError when that UPDATE fails or matches no row, and with LeaseLostError when the lease is gone.
   */
  refreshAtomically(
    exchange: (current: StoredCredentials) => Promise<StoredCredentials>,
    options: {
      minValidityMs: number;
      /** sha256 of the access token Planday just answered 401 to: if the stored token is still that one, it is
       *  treated as invalid whatever its expiry (forced refresh); if another process already replaced it, the
       *  replacement is returned without a token request. */
      rejectAccessTokenHash?: string;
      /** Always run the refresh grant (SYNC PORTAL_CHECK and retryAuth runs, 4.3). */
      force?: boolean;
    },
  ): Promise<StoredCredentials>;
  /** credential_version last read or written by this store (fences the slice's status writes, 7.6). */
  knownVersion(): number;
}
export class CredentialPersistError extends Error {}
/** The connection was disconnected (credentials wiped) while the caller ran; stop without side effects. */
export class CredentialsWipedError extends Error {}

// resumable.ts (new)
export type SyncPhase =
  | "PORTAL_CHECK"
  | "DEPARTMENTS"
  | "EMPLOYEE_GROUPS"
  | "EMPLOYEE_COUNTS"
  | "EMPLOYEES"
  | "MATCH_EMPLOYEES"
  | "DEACTIVATED_EMPLOYEES"
  | "ABSENT_EMPLOYEES"
  | "REACTIVATIONS"
  | "SCHEDULE_DAYS"
  | "PREVIEW_SHIFTS"
  | "SHIFTS"
  | "DELETED_SHIFTS"
  | "ABSENT_SHIFTS"
  | "APPLY_EMPLOYEES"
  | "CLOCK_EVENTS"
  | "FINALISE";
/** Phases that make no Planday call: the executor runs them against the sink (7.2), never the provider. */
export const DATABASE_ONLY_PHASES = [
  "MATCH_EMPLOYEES",
  "REACTIVATIONS",
  "APPLY_EMPLOYEES",
] as const;

export type SyncBatch =
  | { kind: "PORTAL"; portal: ExternalPortal }
  | { kind: "LOCATIONS"; records: ExternalLocation[]; complete: boolean }
  | { kind: "TEAMS"; records: ExternalTeam[]; complete: boolean }
  | {
      kind: "EMPLOYEE_COUNTS";
      byDepartment: Record<string, number>;
      byGroup: Record<string, number>;
    }
  | { kind: "EMPLOYEES"; records: ExternalEmployee[] }
  | {
      kind: "EMPLOYEE_STATUS";
      records: Array<{ externalId: string; status: "DEACTIVATED" | "REMOVED" | "ACTIVE" }>;
    }
  | { kind: "HIDDEN_DAYS"; days: Array<{ externalDepartmentId: string; date: string }> }
  | { kind: "SHIFTS"; records: ExternalShift[]; window: SyncRange }
  | { kind: "SHIFT_REMOVALS"; records: Array<{ externalId: string; reason: ShiftRemovalReason }> }
  | { kind: "CLOCK_EVENTS"; records: ExternalClockEvent[] };

export interface PhaseStepResult {
  readonly done: boolean; // phase finished
  readonly cursor: Readonly<Record<string, unknown>>; // JSON-serialisable, persisted by the executor
  readonly batch?: SyncBatch;
  readonly requests: number; // Planday requests made in this step
  readonly warnings?: readonly SyncError[];
}

export interface PhaseInputs {
  /** Ids the sink asked the provider to re-check (absent employees / shifts), read by ABSENT_* phases. */
  readonly recheckExternalIds?: readonly string[];
  readonly window?: SyncRange;
  readonly deactivatedSince?: Date;
}

export interface ResumableWorkforceProvider extends WorkforceProvider {
  phasesFor(
    kind: "STRUCTURE" | "DIRECTORY" | "IMPORT_EMPLOYEES" | "SYNC" | "CLOCK",
    options: { clockEvents: boolean; hiddenDays: boolean },
  ): readonly SyncPhase[];
  runPhaseStep(
    ctx: ProviderContext,
    phase: SyncPhase,
    cursor: Readonly<Record<string, unknown>>,
    inputs: PhaseInputs,
  ): Promise<PhaseStepResult>;
}
export function isResumableProvider(p: WorkforceProvider): p is ResumableWorkforceProvider;

// syncSink.ts additions
export interface ExternalPortal {
  readonly externalId: string;
  readonly name: string;
  readonly timezone: string | null;
  readonly childPortalCount: number;
}
export interface ExternalEmployee {
  // … existing fields …
  readonly primaryExternalLocationId?: string | null; // Planday primaryDepartmentId
}
export type ShiftRemovalReason =
  "DELETED" | "NOT_FOUND" | "DRAFT" | "UNASSIGNED" | "OUT_OF_SCOPE" | "HIDDEN_DAY";
export interface ExternalShift {
  // … existing fields …
  readonly removalReason?: ShiftRemovalReason | null; // set together with cancelled: true
  readonly timeWarning?: string | null;
}
```

The existing `syncEmployees` / `syncShifts` / … methods are implemented on top of `runPhaseStep`: they loop a
phase to completion and push each record through `ctx.sink.upsert*`. Unit tests and simple callers use them;
the run executor uses `runPhaseStep` so it can persist cursors between steps.

**`PlandayProvider.connect()` contract.** It implements `WorkforceProvider.connect` but accepts only Planday's own
parameter shape in `ConnectParams.credentials`, built by `planday.service.ts`:

```ts
// packages/integrations/src/planday/provider.ts
declare const verified: unique symbol;
/** Produced only by consumeOAuthState() in apps/web (5.2); the generic connect route cannot build one. */
export type VerifiedAuthorizationCode = {
  code: string;
  redirectUri: string;
  codeVerifier?: string;
} & {
  readonly [verified]: true;
};
export type PlandayConnectCredentials =
  | { method: "OAUTH"; clientId: string; authorization: VerifiedAuthorizationCode }
  | {
      method: "CUSTOMER_ADDED_APP_ID" | "CUSTOMER_OWN_APP";
      clientId: string;
      refreshToken: string;
    };
```

It never returns `REDIRECT_REQUIRED` (web builds the authorize URL with `buildAuthorizeUrl`, 5.2) and rejects
`ConnectParams.authorizationCode` / `state` (the generic fields) with `PlandayError` `PLANDAY_AUTH_FAILED`
("use the Planday connect endpoints"). The generic `POST /api/integrations/:provider/connect` route answers 404
`CONNECT_METHOD_UNAVAILABLE` for `PLANDAY` before reaching the provider (5, 11).

### 3.4 Registration

`apps/web/src/server/integrations/providers.ts` exports `ensureProvidersRegistered()`, idempotent against the
registry itself (it registers when `isResumableProvider(getProvider("PLANDAY"))` is false, so a fresh module graph
or an HMR-reloaded registry gets Planday again; no `globalThis` flag that could outlive the registry it guards),
called at the top of `listIntegrations`, every Planday service function, `runSyncSlice`,
`runScheduledIntegrationSyncs`, `runIntegrationsUpkeep` and the runner's `start()`. When `PLANDAY_ENABLED` is true it
calls `registerProvider(createPlandayProvider({ transport: getPlandayTransport(), logger, config }))`; when false it
registers nothing, so Planday's effective availability stays `COMING_SOON` in web and worker alike (the registry
already prefers a registered implementation's status over the static table). `PROVIDERS.PLANDAY.status` in
`packages/shared/src/providers/registry.ts` therefore stays `COMING_SOON` as the fallback; stage 8 rewrites its
description (no "Will sync"). The other five stay `COMING_SOON`.

## 4. Planday client

### 4.1 Configuration and transport

`createPlandayClient({ transport, credentialStore, portalKey, clientIdKey, logger, budget, now })` in
`packages/integrations/src/planday/client.ts`.

- `transport.fetch` is `globalThis.fetch` in live mode (`apps/web/src/server/integrations/transport.ts`,
  `getPlandayTransport()`). In mock mode it rewrites `https://openapi.planday.com/…` to
  `${PLANDAY_MOCK_URL}/openapi/…` and `https://id.planday.com/…` to `${PLANDAY_MOCK_URL}/id/…` (the shared mock
  server, 12.1) and throws for any other host; tests inject the in-process mock's fetch instead
  (`setPlandayTransportForTesting`). The client's base URLs never change: `https://openapi.planday.com` and
  `https://id.planday.com` (notes §2).
- Paths are the spec paths exactly (`/portal/v1.0/info`, `/hr/v1.0/departments`, …; notes §2 rule, never the
  getting-started `v1/Departments` spelling).
- `transport.authorizeBaseUrl` is `https://id.planday.com/connect/authorize` live, and
  `${APP_URL}/api/dev/mock-planday/authorize` in mock mode.
- API requests use `AbortSignal.any([AbortSignal.timeout(t), ctx.signal])` with `t = 10_000`. During the connect
  proof `t = min(10_000, deadline.remainingMs())` and a request starts only while `t ≥ CONNECT_MIN_REQUEST_MS`
  (3 s), so the timeout adapts to the time left instead of a fixed start cut-off (5.6). Token, code-exchange and
  revocation requests use only their own timeout (10 s, during the proof `min(10 s, remaining)` with the same 3 s
  floor; 5 s for revocation), so a worker shutdown never cuts a token exchange whose answer may carry a rotated
  refresh token (7.7). Web never passes the HTTP request's abort signal: a connect proof finishes even if the
  browser leaves.

### 4.2 Headers

API requests (notes §4):

```http
GET https://openapi.planday.com/hr/v1.0/employees?limit=50&offset=0
Authorization: Bearer <access token>
X-ClientId: <App ID that issued the token>
Accept: application/json
User-Agent: ClockOff/1.0 (+https://clockoff.online)
```

- `X-ClientId` is ClockOff's App ID for methods A and B and the customer's App ID for C, always read from the
  connection's `encryptedClientId` (not from the environment at request time).
- Never sent: `X-OpenAPI-Region` (retired), a request body, `special`, `searchQuery`, `includeSecurityGroups`,
  `managedEmployeesOnly`, `departmentId[]` / `employeeId[]` array filters (array serialisation undocumented;
  filtering is client-side). The mock records every request and its tests assert none of these appear.
- Token, code-exchange and revocation requests: `POST` with `Content-Type: application/x-www-form-urlencoded`,
  body built with `URLSearchParams`, no `X-ClientId` (notes §4), no `client_secret` (notes §3.4).

### 4.3 Tokens

Calls in `tokens.ts` (notes §3):

| Function                                                       | Body                                                                                                    | Success parsing (`tokenResponseSchema`)                                                                                                                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exchangeCode({ clientId, code, redirectUri, codeVerifier? })` | `client_id`, `grant_type=authorization_code`, `code`, `redirect_uri` (+ `code_verifier` only with PKCE) | `access_token` (required string), `refresh_token` (required here), `expires_in` (optional int, default 3600), `scope` (optional string), `token_type`; `id_token` is ignored and never stored or logged |
| `refreshToken({ clientId, refreshToken })`                     | `client_id`, `grant_type=refresh_token`, `refresh_token`                                                | `access_token` required; `refresh_token`, `expires_in` (default 3600) and `scope` optional (notes §3.3)                                                                                                 |
| `revokeToken({ clientId, refreshToken })`                      | `client_id`, `token`                                                                                    | Any 2xx is success; the body is ignored (format undocumented)                                                                                                                                           |

Error mapping is by status only (bodies undocumented, notes §3.3): 400 or 401 → `PLANDAY_AUTH_FAILED`;
429 → `PLANDAY_RATE_LIMITED` (identity server limits undocumented; same wait rule as 4.5); 5xx, network
failure or timeout → `PLANDAY_UNAVAILABLE`; 2xx with an invalid body → `PLANDAY_INVALID_RESPONSE`.

**Proactive refresh.** `PlandayClient.accessToken()` reads the store; if the cached token is missing or expires
within 5 minutes (`REFRESH_MARGIN_MS = 300_000`), it calls `credentialStore.refreshAtomically(exchange,
{ minValidityMs: 300_000 })`. A 401 from the API triggers exactly one forced refresh
(`rejectAccessTokenHash = sha256(token that got the 401)`) and one retry of that request; a second 401 →
`PLANDAY_AUTH_FAILED` (notes §8).

**Forced refresh at the start of every SYNC run.** Whether Planday's Revoke button (or the revocation endpoint)
also invalidates access tokens already issued is undocumented (notes §3.6, §12 Q5). So the `PORTAL_CHECK` phase of
every `SYNC` run, and every `retryAuth` run, calls `refreshAtomically(exchange, { minValidityMs: 0, force: true })`
(`force` treats the cached token as invalid) before `GET /portal/v1.0/info`. A revoked refresh token is therefore
detected by the first SYNC after the revocation (at most one 15-minute cycle) whatever the answer to Q5, at the cost
of one token request per portal per SYNC run (4 per hour). `CLOCK` runs use the ordinary proactive rule.
`CredentialStore.refreshAtomically`'s options gain `force?: boolean`.

**Atomic rotation persistence** (`apps/web/src/server/integrations/credentials.ts`, `PrismaCredentialStore`,
constructed with the integration id and the caller's lease holder):

```text
refreshAtomically(exchange, { minValidityMs, rejectAccessTokenHash })
  row = SELECT encrypted_*, token_expires_at, credential_version, sync_lease_id, sync_lease_expires_at, status
          FROM integration_connections WHERE integration_id = $1       // plain read: no lock, no transaction
  if row.status = 'DISCONNECTED' or row.encrypted_refresh_token IS NULL → throw CredentialsWipedError
  if row.sync_lease_id ≠ holder or row.sync_lease_expires_at ≤ now() → throw LeaseLostError
  current = decrypt(row)                                               // AAD-bound, see 4.3.1
  if !force && current.accessToken && current.expiresAt > now + minValidityMs
     && sha256(current.accessToken) ≠ rejectAccessTokenHash → return current
  next = await exchange(current)            // one HTTP call to id.planday.com, 10 s timeout, no database
                                            // connection held, never aborted by a worker shutdown
  for attempt in 1..3 (≤ 5 s in total, only on transient database errors P1001/P1008/P2024/P2028/P2034
                       or a dropped connection; the SAME in-memory `next` is written every time):
    UPDATE integration_connections SET      // one statement, so one transaction
      encrypted_access_token = enc(next.accessToken), token_expires_at = next.expiresAt,
      encrypted_refresh_token = enc(next.refreshToken)  -- only when it differs (rotation)
      credential_hint = last4(next.refreshToken), refresh_token_rotated_at = now()  -- only on rotation
      credential_version = credential_version + 1
    WHERE integration_id = $1 AND credential_version = row.credential_version
      AND sync_lease_id = holder AND sync_lease_expires_at > now() AND status <> 'DISCONNECTED'
    updated 1 row → knownVersion = row.credential_version + 1; return next   // only after the commit
    updated 0 rows → re-read: wiped → CredentialsWipedError; lease gone → LeaseLostError;
                     else CredentialPersistError                              // a 0-row answer is never retried
  transient errors on all 3 attempts → throw CredentialPersistError
```

`PrismaCredentialStore.knownVersion()` exposes the `credential_version` the store last read or wrote; the slice
uses it to fence its connection-status writes (7.6), so a disconnect or reconnect (each bumps the version) makes
every later status write of that slice a no-op.

- Every refresh runs under the per-portal lease (runner slices and web's connect proof, 7.4), which serialises
  refreshes across processes; inside one process the client also keeps a single in-flight refresh promise per
  integration. The version and lease guards catch a holder that lost its lease meanwhile.
- No transaction spans the HTTP call. The 2026-10-07 design held `SELECT … FOR UPDATE` inside an interactive
  transaction across the token request; in the always-on worker that pins a pooled connection and a row lock for
  up to 10 s in the Prisma pool the per-minute Work Mode jobs share (Decision D-043).
- If Planday returns a new `refresh_token`, it is written in the same statement as the access token, before the
  access token is returned to any caller (spec §3, notes §3.3). The new access token is never used if the write
  fails.
- During the connect proof (5.6) nothing is stored yet: the tokens from the first exchange stay in memory and the
  connect transaction writes them (5.5). If Planday rotated a pasted token and that transaction fails, the manager
  authorises again, the same outcome as the failure path below.
- **Failure path.** A transient database error on the `UPDATE` is retried with the same in-memory credentials
  (above), so a short database blip does not throw away a rotated token. If all attempts fail, or the `UPDATE`
  matches no row for a reason other than a wipe or a lost lease: the store throws `CredentialPersistError`; the
  client maps it to an internal `CREDENTIAL_PERSIST_FAILED` (retryable, `ProviderError` code `PROVIDER_ERROR`);
  the run records `errorCode = "CREDENTIAL_PERSIST_FAILED"`; an `error`-level log line carries only
  `{ integrationId, credentialVersion, rotated: boolean }`. The unpersisted access token is never used. If Planday
  had rotated the token, the stored (old) refresh token may now be dead: the run's retry refreshes with it, gets
  400 → `PLANDAY_AUTH_FAILED` → `AUTH_ERROR` → the manager reconnects. That is the documented, safe outcome.
  `CredentialsWipedError` (disconnect) and `LeaseLostError` stop the slice without touching the run or the
  connection (7.6).
- Test: `apps/web/test/integration/planday/tokenRefresh.test.ts` injects store faults and asserts the real final
  states: (1) one transient `P1001` then success → the rotated token is persisted, the refresh succeeds, one token
  request was made; (2) the `UPDATE` throws on every attempt with a **rotating** mock → the call rejects with
  `CREDENTIAL_PERSIST_FAILED`, the mock's request log has no API request bearing the unpersisted access token,
  the stored ciphertexts and `credential_version` are unchanged, and the run ends `FAILED` with the connection in
  `AUTH_ERROR` (its retry refreshed with the now-dead stored token); (3) the same with a **non-rotating** mock →
  the run is parked, then `FAILED` with `CREDENTIAL_PERSIST_FAILED` after its retries and the connection stays
  `CONNECTED`; (4) the lease taken over → `LeaseLostError`, nothing written; (5) credentials wiped → the slice
  stops, the connection stays `DISCONNECTED`.

#### 4.3.1 Encryption with associated data

`apps/web/src/lib/crypto.ts` gains an optional `aad?: string` parameter on `encrypt` and `decrypt`
(`cipher.setAAD(Buffer.from(aad))`), backward compatible. Every Planday ciphertext uses
`integration:<integrationId>:<column>` as AAD, so a ciphertext copied into another org's row fails to decrypt.
Tests added to `crypto.test.ts`.

### 4.4 Pagination

`pagination.ts`, following notes §7 exactly:

- Always send an explicit `limit`: 50 for HR lists and `/scheduling/v1.0/scheduleDay`, 100 for
  `/scheduling/v1.0/shifts` and `/scheduling/v1.0/shifts/deleted` (documented maxima 5000 and 1000; 100 keeps every
  page's apply transaction to at most 100 records, section 7.6), 50 for `/punchclock/v1.0/punchclockshifts`.
- `offset += data.length` (never `+= limit`; the server may lower the limit). Stop when `data` is empty, or when
  `paging` is present and `offset >= paging.total` (notes §7 rule 3). The requested limit is never a stop
  condition: with `paging: null` the loop continues until an empty page, and a short page with `paging` present
  is compared with `paging.total` only (a server-lowered `paging.limit` is not an end).
- A page is one step of a phase; the cursor `{ offset }` is persisted after the page's records are written
  (section 7.6), so a crash or a shutdown resumes at the next page and re-processing a page is idempotent.
- Sort order is undocumented: duplicate ids across pages are de-duplicated per run (upsert by id).

### 4.5 Serialisation, budgets, 429 and retries

| Mechanism                   | Rule                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One stream per portal       | Across processes: the per-portal lease (section 7.4), held by runner slices and by web's connect proof. Inside a process: `KeyedSerialQueue` keyed by portal id (integration id before the portal is known) so requests are strictly sequential.                                                                                                                                                   |
| Per-portal budget           | `TokenBucket` 10 requests/s (notes §6: the page says 20 and 10; budget the lower) and `SlidingWindowBudget` 600 requests/60 s (below the documented 750).                                                                                                                                                                                                                                          |
| Per-client-id budget        | Methods A and B share ClockOff's App ID across every customer (100/s, 2000/min). Process-local bucket 50/s and 1500/min keyed by client id, plus header feedback below. Nearly all requests come from the single worker replica; cross-process enforcement is a documented risk (section 16.2).                                                                                                    |
| Header feedback             | After every response read `x-ratelimit-remaining` and `x-ratelimit-reset`; if remaining ≤ 2, wait `reset` seconds before the next request on that key.                                                                                                                                                                                                                                             |
| 429                         | Wait `x-ratelimit-reset` seconds (notes §6); if an undocumented `Retry-After` is also present, the longer of the two; neither → 60 s; plus 0–1 s jitter. Waits up to `MAX_INLINE_WAIT_MS` (30 s) are slept in the slice (abortable by shutdown), at most 3 per request; a longer wait throws `PlandayRateLimitedError(retryAt)` and the run is parked with `resumeAfter = retryAt` (section 7.10). |
| 5xx, network error, timeout | Full-jitter exponential backoff (base 500 ms, factor 2, cap 8 s), at most 3 attempts per request, then `PLANDAY_UNAVAILABLE` (retryable at run level, 7.10).                                                                                                                                                                                                                                       |
| Run request budget          | At most 2 000 Planday requests per run (slices are bounded by time, not by count). Exceeding it ends the run `PARTIAL` with warning `REQUEST_BUDGET_EXHAUSTED`; the next scheduled run continues.                                                                                                                                                                                                  |
| Deadline                    | Connect proof only (web, `CONNECT_BUDGET_MS`, 5.6): each request's timeout is `min(its normal timeout, remaining)` and it starts only while that is at least 3 s. Worker slices have no per-request deadline; they yield between steps (7.6).                                                                                                                                                      |

### 4.6 Typed errors

`PlandayError extends Error { code; status?; retryable; retryAt?; missingScopes?; pathTemplate? }`:

| `PlandayErrorCode`         | Raised when                                                                                                                                             | `ProviderError` code | Retryable | Connection effect                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `PLANDAY_AUTH_FAILED`      | Token endpoint 400/401; API 401 after one forced refresh                                                                                                | `AUTH_EXPIRED`       | no        | `AUTH_ERROR` immediately                                                                                                        |
| `PLANDAY_SCOPE_MISSING`    | API 403 (notes §8), or the OAuth `scope` lacks a required scope; carries `missingScopes`                                                                | `AUTH_EXPIRED`       | no        | `AUTH_ERROR` (connect: rejected)                                                                                                |
| `PLANDAY_RATE_LIMITED`     | 429 after the inline waits, or a wait longer than 30 s                                                                                                  | `RATE_LIMITED`       | yes       | none (run parked)                                                                                                               |
| `PLANDAY_UNAVAILABLE`      | 5xx, 409 on GET, network, timeout                                                                                                                       | `PROVIDER_ERROR`     | yes       | failure count +1                                                                                                                |
| `PLANDAY_NOT_FOUND`        | 404 on a by-id read; 400 on `GET /hr/v1.0/employees/{id}` (notes §8: record-level, skip the record)                                                     | record level only    | n/a       | none. Shift by id: removal `NOT_FOUND` (6.6). Employee by id: warning `EMPLOYEE_NOT_VISIBLE`, never a deactivation (6.5, D-045) |
| `PLANDAY_INVALID_RESPONSE` | 2xx body fails Zod, unsafe integer id, non-JSON body; shift `date` disagrees with the parsed local start date (`reason: "TIME_ENCODING_MISMATCH"`, 4.8) | `INVALID_RESPONSE`   | no        | run `FAILED` (that page unwritten); next schedule retries                                                                       |

The API layer maps them to new `AppError` codes in `packages/shared/src/errors.ts`:
`INTEGRATION_AUTH_FAILED` (422), `INTEGRATION_SCOPE_MISSING` (422), `INTEGRATION_UNAVAILABLE` (503),
`INTEGRATION_INVALID_RESPONSE` (502), `INTEGRATION_PORTAL_MISMATCH` (409), `INTEGRATION_PORTAL_IN_USE` (409),
`INTEGRATION_MANAGED` (409), `INTEGRATION_NOT_CONNECTED` (409), `INTEGRATION_ONBOARDING_INCOMPLETE` (409),
`OAUTH_STATE_INVALID` (400), `CONNECT_METHOD_UNAVAILABLE` (404); the existing `RATE_LIMITED` (429) is reused.
Copy for each in `apps/web/src/lib/errorMessages.ts`. A connect request while web is draining for a deploy answers
`INTEGRATION_UNAVAILABLE` with "ClockOff is updating. Try again in a minute." (5.6).

### 4.7 Zod schemas and allow-list mapping

`schemas.ts` defines one schema per endpoint with **only** the fields in the notes' "Uses" column; Zod 4
`z.object` strips every other key at parse time, and `mappers.ts` then builds new objects field by field
(allow-list mapping, never `delete`). Planday int64 ids are accepted as JSON numbers that pass
`Number.isSafeInteger` (else `PLANDAY_INVALID_RESPONSE`) and converted to decimal strings.

| Endpoint (notes §9)                                        | Fields parsed                                                                                                          | Fields stored                                                                    |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `GET /portal/v1.0/info`                                    | `data.id`, `data.name`, `data.timeZone`, `data.portals[].id` (count only)                                              | portal id, name, time zone (connection)                                          |
| `GET /hr/v1.0/departments`                                 | `id`, `name`, `number`                                                                                                 | catalogue; managed location name                                                 |
| `GET /hr/v1.0/employeegroups`                              | `id`, `name`                                                                                                           | catalogue; managed team name                                                     |
| `GET /hr/v1.0/employees`                                   | `id`, `firstName`, `lastName`, `email`, `departments[]`, `primaryDepartmentId`, `employeeGroups[]`, `deactivationDate` | Employee first/last name, email; department → location; groups → teams (spec §8) |
| `GET /hr/v1.0/employees/deactivated`                       | `id`, `deactivationDate`                                                                                               | nothing beyond the deactivation it causes                                        |
| `GET /hr/v1.0/employees/{employeeId}` (absent check only)  | `isDeactivated`                                                                                                        | nothing                                                                          |
| `GET /scheduling/v1.0/shifts`                              | `id`, `departmentId`, `employeeId`, `employeeGroupId`, `date`, `startDateTime`, `endDateTime`, `timeZone`, `status`    | Shift start, end, employee, department → location, time zone (spec §8)           |
| `GET /scheduling/v1.0/shifts/{shiftId}`                    | as `/shifts`                                                                                                           | as `/shifts`                                                                     |
| `GET /scheduling/v1.0/shifts/deleted`                      | `id`, `dateTimeDeleted`                                                                                                | nothing beyond the cancellation it causes                                        |
| `GET /scheduling/v1.0/scheduleDay`                         | `date`, `departmentId`, `isVisible`                                                                                    | nothing (in-memory filter)                                                       |
| `GET /punchclock/v1.0/punchclockshifts` (Beta)             | `id`, `shiftId`, `departmentId`, `employeeId`, `startDateTime`, `endDateTime`, `isApproved`                            | `ClockEvent` rows                                                                |
| `GET /punchclock/v1.0/punchclockshifts/{id}/breaks` (Beta) | `id`, `startDateTime`, `endDateTime`                                                                                   | `ClockEvent` `BREAK_START` / `BREAK_END`                                         |

Never parsed, therefore never stored or logged: every strip-set E and E+ field (notes §9.2: `userName`, phones,
address, `hiredDate`, `salaryIdentifier`, termination fields, `ssn`, `bankAccount`, `birthDate`, `gender`,
`workHours`, `custom_*`, …), shift `comment`, `deletedBy`, punch `description`, `scheduleDay.description`,
`portal.aliases`, `companyName`. `Shift.notes` is always null for synced shifts. Status values are parsed as
strings and classified (section 6.6), so a new Planday status value cannot fail a whole sync.

### 4.8 Time conversion (`time.ts`)

`parsePlandayDateTime(value: string, zone: string): { instant: Date; warning?: LocalTimeWarning }`:

1. If `value` ends in `Z` or `±hh:mm`, it is an instant (`Date.parse`).
2. Otherwise it must match `YYYY-MM-DDTHH:mm(:ss(.fff)?)?`; it is wall-clock time in `zone`, resolved with
   `resolveWallClock` from `@clockoff/shared/time/zone` (spring-forward gap → shifted forward with
   `NONEXISTENT_LOCAL_TIME_SHIFTED`; fall-back overlap → first occurrence with
   `AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE`). Same rules as manual and CSV shifts (D-017).
3. `zone` is the shift's `timeZone`, else the portal `timeZone`; it must pass `isValidTimeZone` (IANA). A
   Windows zone id is not mapped (notes §10.3 rule 3): the record is skipped with `INVALID_TIME`.

`toShiftInstants(raw, portalZone)`: both instants required; `end > start`; `end - start ≤ 25 h` (24 h of wall
clock plus one DST hour, notes §10.3 rule 4); `isOvernight` = local start date ≠ local end date in the shift
zone. Shorter than 15 minutes → skipped `INVALID_TIME` (the existing integration rule).

**Encoding cross-check.** The shift's documented `date` field refers to its start (notes §10.3). When `date` is
present, it must equal the local date of the parsed start instant in the shift's zone. A mismatch means the
date-time encoding assumption (notes §12 Q27) is wrong for this portal: the page fails with
`PLANDAY_INVALID_RESPONSE` `reason: "TIME_ENCODING_MISMATCH"` before anything of it is written (the run fails, the
card shows "Planday's shift times could not be read reliably. Contact support."). It catches, for example, UTC
times sent without `Z` for every shift that starts within the UTC offset of midnight. The check is provisional
like the rules it guards, and the stage 8 demo-portal gate (section 15) confirms what `date` contains before any
customer goes live.

### 4.9 Logging and redaction

`PlandayLogger` is an interface (`debug | info | warn | error (obj, msg)`); the web layer passes a pino child
logger. Events and their only fields:

| Event                      | Fields                                                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `planday.request`          | `method`, `pathTemplate` (ids replaced: `/hr/v1.0/employees/{id}`), `status`, `durationMs`, `attempt`, `rateLimitRemaining`, `integrationId`, `runId` |
| `planday.rate_limited`     | `pathTemplate`, `waitMs`, `source` (`retry-after` / `x-ratelimit-reset` / `default`)                                                                  |
| `planday.token.refreshed`  | `integrationId`, `rotated`, `expiresInS`                                                                                                              |
| `planday.invalid_response` | `pathTemplate`, `issues: [{ path, code }]` (Zod issue paths and codes, never values)                                                                  |
| `planday.error`            | `code`, `status`, `pathTemplate`                                                                                                                      |

Never logged: bodies, headers, query strings with ids, tokens, client ids, codes, state values, names, emails.
`apps/web/src/lib/logger.ts` `SENSITIVE_KEYS` gains `access_token`, `refresh_token`, `id_token`,
`authorizationCode`, `codeVerifier`, `clientId`, `appId`, `workEmail` as a second line of defence. The
data-minimisation test captures logger output and searches it for tokens and PII sentinels.

## 5. Connection methods

All Planday endpoints live under the existing dynamic segment `apps/web/src/app/api/integrations/[provider]/…`
(a static `planday` folder beside `[provider]` would shadow it). Each route validates
`integrationParamsSchema` and calls `requirePlanday(params.provider)`, which answers 404 `NOT_FOUND` for any
other provider. `/api/integrations/planday/callback` is therefore `[provider]/callback/route.ts`.

The existing generic `POST /api/integrations/:provider/connect` (`[provider]/connect/route.ts`,
`connectIntegration` in `integrations.service.ts`) passes a browser-supplied `code` and `state` straight to
`provider.connect()` and stores the result in the legacy `encrypted_credentials` column. For `PLANDAY` it answers
404 `CONNECT_METHOD_UNAVAILABLE` before anything else (stage 5A changes the route and the service; the OpenAPI entry
documents that Planday uses `connect/oauth`, `connect/token` and `callback`). Planday connections are created only
by `planday.service.ts`, which verifies the OAuth state first (5.2) and hands the provider a
`VerifiedAuthorizationCode` (3.3). `connectMethods.test.ts` posts `{ code, state }` to
`/api/integrations/planday/connect` and asserts 404 and that nothing is stored.

### 5.1 Availability (`availableConnectMethods(env)` in `planday.service.ts`)

| Method                    | Shown and accepted when    | Client id used                 |
| ------------------------- | -------------------------- | ------------------------------ |
| A `OAUTH`                 | `PLANDAY_CLIENT_ID` is set | `PLANDAY_CLIENT_ID`            |
| B `CUSTOMER_ADDED_APP_ID` | `PLANDAY_APP_ID` is set    | `PLANDAY_APP_ID`               |
| C `CUSTOMER_OWN_APP`      | always                     | the App ID the customer pastes |

`GET /api/integrations/planday/connect-methods` (manager) → `{ methods: [{ method, available }], recommended,
isMock, clockModeEnabled, requiredScopes, clockOffAppId }` where `recommended` is A, else B, else C, and
`clockOffAppId` is `PLANDAY_APP_ID` (only when B is available; an App ID is not a secret). The server rejects a
connect request for an unavailable method with `CONNECT_METHOD_UNAVAILABLE`, so hiding is not only cosmetic.

### 5.2 Method A: authorization code ("Connect with Planday")

1. `POST /api/integrations/planday/connect/oauth` (`integrations:write`, rate limit `integrations:connect`,
   body `{ returnTo: "WIZARD" | "SETTINGS", allowPortalSwitch?: boolean }`; `allowPortalSwitch` is stored on the
   state row and honoured only from `DISCONNECTED`, 5.7) → `createOAuthState()`:
   - token = `<nonce>.<sig>`: `nonce` = 32 random bytes base64url; `sig` = HMAC-SHA256 (key =
     HMAC(`SESSION_SECRET`, `"planday-oauth-state:v1"`)) over `nonce|organisationId|userId|expiresAtEpochSeconds`,
     base64url. Length < 120 chars.
   - Row `IntegrationOAuthState { stateHash: sha256(token), organisationId: ctx.organisation.id,
userId: ctx.user.id, integrationId, redirectUri, returnTo, expiresAt: now + 10 min }`.
   - With `PLANDAY_OAUTH_PKCE=true` only: `code_verifier` 64 random bytes base64url, stored encrypted;
     `code_challenge = base64url(sha256(verifier))`, `code_challenge_method=S256`. Default `false`: PKCE is not
     documented for API apps (notes §3.2); turned on only after the demo-portal check.
   - Response `{ authorizationUrl }`:
     `https://id.planday.com/connect/authorize?client_id=<PLANDAY_CLIENT_ID>&response_type=code&redirect_uri=<urlencoded ${APP_URL}/api/integrations/planday/callback>&scope=<urlencoded "openid offline_access department:read employeegroup:read employee:read shift:read punchclockshift:read">&state=<token>`.
     The scope string is the app's full scope list plus `openid offline_access`, as the notes require
     (notes §5.2); production `APP_URL` gives exactly `https://app.clockoff.online/api/integrations/planday/callback`.
2. The browser goes to Planday, the admin picks the portal and approves.
3. `GET /api/integrations/planday/callback?code&state` (`auth: "user"`; the session cookie is `SameSite=Lax`, so
   it is sent on this top-level navigation). `consumeOAuthState(token, ctx.user)`:
   - Parse; recompute and constant-time compare the HMAC; reject if `expiresAt < now`.
   - `UPDATE integration_oauth_states SET consumed_at = now() WHERE state_hash = $1 AND consumed_at IS NULL AND
expires_at > now() RETURNING …`; zero rows → replay or expiry → `OAUTH_STATE_INVALID`.
   - The row's `userId` must equal the session user, and that user must still be `OWNER` or `ADMIN` of the
     row's `organisationId`. The organisation comes from the signed state row, never from the query string or the
     org cookie.
   - `error=access_denied` (or any `error`) from Planday: consume the state, redirect to
     `<returnTo>?step=connect&connectError=DENIED`.
4. `exchangeCode` → check that the returned `scope` contains `department:read employeegroup:read employee:read
shift:read` (and `punchclockshift:read` when clock mode is enabled) else `PLANDAY_SCOPE_MISSING`; discard
   `id_token`.
5. `consumeOAuthState` returns the `VerifiedAuthorizationCode` (3.3) for `{ code, redirectUri, codeVerifier }`;
   only it can build one. Proof of connection (5.6), persist (5.5), set the org cookie to the state's organisation
   (so the user lands in the right org), audit, redirect to `/onboarding/planday?step=confirm-portal` (wizard) or
   `/integrations?planday=connected` (settings, the reconnect panel of 10.1). Every error redirects with
   `connectError=<AppError code>` only to the same `returnTo` page; no token, code or message from Planday ever
   appears in a URL.

### 5.3 Method B: customer adds ClockOff's App ID

UI (connect step): numbered instructions with screenshot slots `/help/planday/b-1-api-access.png` …
`b-4-copy-token.png`, ClockOff's App ID shown with a copy button, one paste field for the token.
`POST /api/integrations/planday/connect/token` (`integrations:write`) with
`{ method: "CUSTOMER_ADDED_APP_ID", refreshToken, allowPortalSwitch? }`. Steps for the admin (notes §3.2 B):

1. Planday → Settings → Integrations → API Access (Administrators only).
2. "Connect App", enter ClockOff's App ID, Save.
3. "Authorize" next to the app, approve the consent screen.
4. Copy the value in the "Token" column and paste it into ClockOff.

### 5.4 Method C: customer creates their own API app (guaranteed fallback)

UI: numbered instructions with slots `/help/planday/c-1-api-access.png` … `c-5-copy-ids.png`, the exact scopes
to tick, and two paste fields (App ID, Token). Same endpoint with
`{ method: "CUSTOMER_OWN_APP", appId, refreshToken }`. Steps:

1. Planday → Settings → Integrations → API Access.
2. "Create App". Name it "ClockOff". In Scopes tick **READ** only for: Department, Employee group, Employee,
   Shift (and Punch clock only if your ClockOff account has clock-in mode). Tick nothing else, in particular
   nothing under pay, payroll, salary, bank account, birth date, SSN, absence, revenue or contract rules. Save.
   (The scope grid's exact row labels are verified on the demo portal and captured in the screenshots, section
   16.)
3. "Authorize" next to the new app, approve.
4. Copy the App ID (App Id column) and the Token (Token column) into ClockOff.

Input validation (`connectPlandayTokenSchema`, `packages/validation/src/planday.ts`): whitespace and line breaks
stripped; `appId` a UUID; `refreshToken` 10–512 printable characters without spaces. Rate limits: the route's
`RateLimitRule` `integrations:connect-token` (10 per 15 min per IP, per process) plus a database check that holds across restarts and processes: more
than 10 `integration.connect_failed` audit rows for the org in the last hour → `RATE_LIMITED`.

### 5.5 What is stored (identical shape for A, B and C)

| Column                                                 | A                       | B                        | C                        |
| ------------------------------------------------------ | ----------------------- | ------------------------ | ------------------------ |
| `authMethod`                                           | `OAUTH`                 | `CUSTOMER_ADDED_APP_ID`  | `CUSTOMER_OWN_APP`       |
| `encryptedClientId`                                    | `PLANDAY_CLIENT_ID`     | `PLANDAY_APP_ID`         | pasted App ID            |
| `encryptedRefreshToken`, `credentialHint`              | from code exchange      | pasted                   | pasted                   |
| `encryptedAccessToken`, `accessTokenExpiresAt`         | from code exchange      | from first refresh grant | from first refresh grant |
| `scopesGranted`                                        | token response `scope`  | probed scopes            | probed scopes            |
| `externalPortalId/Name/Timezone`                       | `GET /portal/v1.0/info` | same                     | same                     |
| `connectedByUserId`, `connectedAt`, `isMock`, `status` | set                     | set                      | set                      |

`connectMethods.test.ts` asserts the three rows are equal apart from `authMethod`, the client id value and
`scopesGranted` provenance, and that decrypting gives the same `StoredCredentials` shape. Nothing else is kept:
no `id_token`, no Planday user identity, no raw token response. Responses to the browser never contain a token,
App ID or code; they contain at most `credentialHint` rendered as "ending ••••4f2a".

### 5.6 Proof of connection

`PlandayProvider.connect()` runs these in order inside the web request, each request through the client of
section 4, holding the portal's lease (section 7.4). The lease lives on the `IntegrationConnection` row, so
`ensureConnectionRow(integrationId)` first inserts a placeholder when none exists (`CONNECTING`, no secrets, coarse
status `NOT_CONNECTED`; `ON CONFLICT DO NOTHING`); a placeholder is not a connection and a failed proof leaves it
as it was.

**Bounds (Railway).** Railway has no request cut; the binding limit is web's graceful shutdown (`SHUTDOWN_GRACE_MS`,
default 20 s, inside 30 s draining). The whole connect request (lease wait, proof and persist) is bounded by
`CONNECT_BUDGET_MS = SHUTDOWN_GRACE_MS − 2 000` (18 s by default): lease wait at most `CONNECT_LEASE_WAIT_MS` = 3 s,
then the proof with a `Deadline` that keeps 2 s in reserve for the connect transaction; each request's timeout
adapts to the time left (4.1). While web is draining (the SIGTERM handler in `server/lifecycle/webShutdown.ts`
sets `globalThis.__clockoffWebDraining`, read through `isWebDraining()`), `connect/token`, `connect/oauth` and the
OAuth `callback` refuse new proofs with `INTEGRATION_UNAVAILABLE` ("ClockOff is updating. Try again in a minute.";
the callback redirects with that code, and its state stays unconsumed so the retry works). A proof already running
fits inside the grace. The lease is released in a `finally` block on every path, before the run is announced.

1. Token: code exchange (A) or refresh grant (B, C).
2. `GET /portal/v1.0/info` → portal id, name, time zone. A 403 here → `PLANDAY_SCOPE_MISSING` with
   `missingScopes: ["portal info"]` (its scope is undocumented, notes §12 Q11).
3. Probes with `limit=1`: `/hr/v1.0/departments`, `/hr/v1.0/employeegroups`, `/hr/v1.0/employees`,
   `/scheduling/v1.0/shifts?from=<today>&to=<today>` (and `/punchclock/v1.0/punchclockshifts` with a one-hour
   window when clock mode is enabled). A 403 names the scope (`department:read`, …). Each 200 body must parse.

Only after all succeed is anything persisted with `status = CONNECTED`. A failure persists nothing except an
`integration.connect_failed` audit row (`{ method, errorCode }`) and returns the typed error: the UI never shows
success unless a portal answered with valid data (spec §0). After success the connect transaction also enqueues
one run (`enqueueRun`, 7.3) and records `INTEGRATION_CONNECTED` activity and audit `integration.connected` /
`integration.reconnected` (`{ method, portalId, portalName, readopted, revokedPrevious }`):

| Situation                                                   | Run enqueued                                                                                                                |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| First connect, or a portal switch (onboarding not complete) | `STRUCTURE`, `INITIAL`                                                                                                      |
| Reconnect while onboarding is incomplete                    | `STRUCTURE` if the session's structure run never succeeded; otherwise none (the wizard's Retry re-queues the kind it needs) |
| Reconnect after onboarding (`onboardingCompletedAt` set)    | `SYNC`, `RECOVERY`                                                                                                          |

The `finally` block releases the lease; only then is the run announced (a runner woken earlier would find the
portal still leased). The worker picks the run up within seconds; the response carries the queued run so the
wizard or the reconnect panel shows its progress at once.

### 5.7 Reconnect and portal binding

- Reconnect uses any available method, from the wizard (onboarding incomplete) or from the Integrations card's
  reconnect panel (10.1; the banner, the email and the connect link lead there once onboarding is complete). If
  the connection has an `externalPortalId` and the new token resolves to a different portal id →
  `INTEGRATION_PORTAL_MISMATCH`, nothing stored (notes §2 rule), unless the request carries
  `allowPortalSwitch: true` and the connection is `DISCONNECTED` (below).
- Same portal: credentials replaced, `status = CONNECTED`, `consecutiveFailureCount = 0`, `authProbeAttempts = 0`,
  `lastErrorCode` / `lastErrorMessage` / `authErrorNotifiedAt` / `degraded*` cleared, the run of 5.6 enqueued.
  `IntegrationMappingConfig` and every `ExternalEntityMap` row are reused, so no entity is duplicated
  (`reconnect.test.ts`).
- **Re-adoption** (same portal, previous status `DISCONNECTED`), in the connect transaction, because the disconnect
  cleared `managedByIntegrationId` while keeping the map rows (5.8) and the writers refuse unmanaged rows (6.9):
  1. `EMPLOYEE` map rows: if the employee exists and `deletedAt` is null → `managedByIntegrationId` set again;
     otherwise the map row is deleted (the next SYNC matches the Planday person afresh, 6.5).
  2. `LOCATION` / `TEAM` map rows whose entity has `source = INTEGRATION` and is not deleted → managed again
     (rows that point at a manager's existing location or team were never managed and stay so); deleted entities
     → map row deleted.
  3. `SHIFT` map rows: shift not deleted → managed again; a non-ended `CANCELLED` shift gets
     `upstreamRemovedAt = now` on its map row (eligible for REINSTATE, row 15 of 6.6), whoever cancelled it while
     disconnected; deleted shift → map row deleted (the next SYNC creates it again if Planday still publishes it).
  4. `lastHash = null` on every remaining map row, so the `RECOVERY` SYNC re-decides every record and reverts edits
     made in ClockOff while disconnected (they were editable then; Planday is the source of truth again).
     `readopted` counts per entity type go into the audit row. Tests in `reconnect.test.ts` cover both disconnect
     modes, a shift edited and one cancelled while disconnected, and assert no duplicate rows and that future
     shifts cancelled by `CANCEL_FUTURE_SHIFTS` are reinstated by the first SYNC.
- **Previous token.** After the reconnect transaction commits, if the previous credentials were not wiped
  (reconnect from `AUTH_ERROR`, or a method switch while connected) and their client id differs from the new one
  (for example method C → A), the previous refresh token is revoked best effort with its own client id (5 s, as in
  5.8 step 3); `revokedPrevious` goes into the audit row. With the same client id it is not revoked: whether
  revoking one token of an app also ends other grants of that app on the portal is undocumented (notes §12 Q5;
  section 16.2), and the customer's own Revoke button removes it.
- Switching to another portal is allowed only from `DISCONNECTED` and only when the manager confirmed "Use a
  different portal" (`allowPortalSwitch: true`). In the connect transaction `resetIntegrationMappings(integrationId)`
  deletes the map, mapping config (including `onboardingCompletedAt`), pending and preview rows (ClockOff
  entities stay, with `managedByIntegrationId` already cleared by the disconnect), starts a new onboarding session,
  enqueues `STRUCTURE` and audits `integration.portal_switched`; the manager continues in the wizard at step 2.
  Portal-qualified external ids (2.6) keep the old portal's rows from colliding with the new portal's.
- A connection with `isMock = true` is treated as `AUTH_ERROR` ("made against Mock Planday") when
  `PLANDAY_MODE=live`, so a mock token never reaches Planday.

### 5.8 Disconnect

`POST /api/integrations/planday/disconnect` (`integrations:write`; body
`{ mode: "KEEP_RECORDS" | "CANCEL_FUTURE_SHIFTS" }`; the existing generic disconnect route keeps its URL with this
body schema):

1. One transaction, first statement: mark the active run, if any, `FAILED` with `errorCode = "DISCONNECTED"`
   (`UPDATE integration_sync_runs … WHERE integration_id = $1 AND status = 'RUNNING'`). A slice in progress stops at
   its next step: its fence finds the run no longer `RUNNING` and rolls back (7.6), and every terminal or status
   write it attempts afterwards is fenced too (7.6), so nothing is written after the disconnect and a 401 that the
   revocation causes mid-flight can never turn the connection into `AUTH_ERROR`; any `GET` it has in flight is
   read-only.
2. Same transaction: read the refresh token and client id for the revocation, then wipe `encryptedClientId`,
   `encryptedRefreshToken`, `encryptedAccessToken`, `accessTokenExpiresAt`, `credentialHint`
   (`credential_version + 1`); clear the lease (`sync_lease_id = NULL, sync_lease_expires_at = NULL`: the slice's
   next renewal finds 0 rows and aborts, and a reconnect can take the portal at once) and the pending-run slot
   (7.3); `setConnectionStatus(DISCONNECTED, { from: any })`; `CANCEL_FUTURE_SHIFTS` → `cancelIntegrationShifts`
   (reason `DISCONNECTED`) for every `SCHEDULED` managed shift with `startsAt > now`, with `upstreamRemovedAt = now`
   on their map rows so a later same-portal reconnect can reinstate them (5.7; in-progress shifts are left to
   finish); clear `managedByIntegrationId` on the org's employees, locations, teams and shifts (they become
   ClockOff-managed and editable; `source` stays `INTEGRATION` as provenance); purge pending and preview rows; when
   onboarding is incomplete, release the session's employee imports (9.3) and mark the `ACTIVE` onboarding session
   `ABANDONED`; `nextSyncAt = null`; activity `INTEGRATION_DISCONNECTED`.
3. After commit: publish `integration.run.cancelled { integrationId, runId }` on the bus (the runner aborts that
   slice at once instead of at its next lease renewal, 7.5), then best effort `revokeToken` with the values read in
   step 2 (5 s timeout, notes §3.6); the result is logged, never blocks, and is recorded in the audit row
   `integration.disconnected` `{ mode, revokedAtPlanday, cancelledShifts }` written right after.
4. Publish the activity and `SCHEDULE_CHANGED` events on the bus; the worker's push-bridge leader turns them into
   silent pushes.

`disconnect.test.ts` covers the race: a slice whose next request returns 401 (the mock revokes all tokens when the
revocation endpoint is called) while the disconnect commits → the connection stays `DISCONNECTED`, no
`INTEGRATION_ERROR` notification and no email are created, `consecutiveFailureCount` and `nextSyncAt` are unchanged,
and an immediate reconnect gets the lease without `CONFLICT`.

`IntegrationMappingConfig` and `ExternalEntityMap` rows are kept so reconnecting the same portal reuses them.

## 6. Sync engine

### 6.1 Shape

- The provider (`packages/integrations/src/planday/phases.ts`) fetches one page per step, parses and maps it, and
  returns a `SyncBatch` (section 3.3). It never touches the database.
- The executor (`apps/web/src/server/integrations/runs/executor.ts`, in the worker) hands the batch to a sink in
  one database transaction together with the run's cursor, counts and heartbeat, fenced by the run status and the
  portal lease (7.6), so a page is applied exactly once from the run's point of view and re-applying it after a
  crash or a shutdown is a no-op.
- Two sinks: `stagingSink` (STRUCTURE, DIRECTORY runs: catalogue, `PendingExternalEmployee`,
  `IntegrationPreviewShift`; no ClockOff entity is touched) and `applySink` (IMPORT_EMPLOYEES, SYNC, CLOCK runs).
  The database-only phases (`MATCH_EMPLOYEES`, `REACTIVATIONS`, `APPLY_EMPLOYEES`) are steps of the sink itself:
  the executor calls `sink.runDatabasePhaseStep(phase, cursor, tx)` in place of the provider, in batches of 100.
- Every decision is a pure function in `packages/integrations/src/core/*Decisions.ts`, unit-tested row by row
  against the tables below. The sink loads the current state for a whole batch in a few queries (every query is a
  network round trip from Railway EU West to Neon London), calls the decision function per record in memory, and
  performs only the writes the decisions ask for.
- **Transaction size.** A step applies at most 100 records (page limits in 4.4) in one transaction, and its writes
  are batched: creations with `createMany`; changed shifts with one `UPDATE shifts … FROM (VALUES …)` that bumps
  `version` only where `version` still equals the value read (rows it does not return had a concurrent change and
  are retried one by one through `updateShiftRow`); one `activityEvent.createMany`; one `last_hash` /
  `last_seen_at` update for the batch's map rows. A step is about ten statements whatever the number of changes
  (`syncShifts.test.ts` › "500 changed shifts": five steps, statement count per transaction ≤ 12, each under the
  10 s timeout).

### 6.2 Idempotency (`ExternalEntityMap` + `lastHash`)

For every applied record:

1. `lastHash = HMAC-SHA256(key, canonicalJson(decisionInputs))`. The key is derived from
   `INTEGRATION_ENCRYPTION_KEY` (`hasher.ts`, HKDF info `"external-entity-hash:v2"`), so the column cannot be used
   to guess names or emails offline. `canonicalJson` sorts keys and normalises instants to ISO strings.
   `decisionInputs` is everything the decision depends on, not only the Planday record:
   - shifts: the mapped record (times, zone, status, Planday employee and department ids), its class (6.6), and the
     resolved targets: internal employee id (or null), whether that employee is mapped and in scope, location or
     ClockOff department id, the hidden-day flag (only when `respectHiddenDays`), and the window membership;
   - employees: the mapped record, the resolved primary location / ClockOff department, the mapped team ids, the
     scope flag, `importEmails`;
   - departments and groups: the record and their mapping entry.
     The global `mappingVersion` is not part of it: a settings save changes only the hashes of the entities whose
     resolved targets it changes.
2. Load map rows and current entities for the batch: `WHERE integration_id = $1 AND entity_type = $2 AND
external_id = ANY($3)`.
3. Short-circuit: map row exists, `lastHash` equals, **and** the entity is still in the state the last decision
   left it in → outcome `UNCHANGED`; the only write is one batched `UPDATE external_entity_maps SET last_seen_at =
$now WHERE id = ANY($ids)` per page. Never short-circuited: a shift that is `CANCELLED` with `upstreamRemovedAt`
   set while the incoming class is `PUBLISHED` (REINSTATE, 6.6 row 15); an employee deactivated by the sync
   (`upstreamRemovedAt` set) who is back on the active list (6.5); a map row with `lastHash = null` (re-adoption,
   5.7).
4. Otherwise the decision function runs. A create inserts the entity and its map row in the same transaction; an
   update writes the entity (with version bump for shifts) and the new `lastHash`; a cancel or deactivation also
   writes the incoming `lastHash` (so a later change back is seen as a change). When the hash differs but no
   ClockOff-visible field would change (for example a settings save that re-resolves to the same targets), the
   outcome is `REHASH_ONLY`: `last_hash` and `last_seen_at` are updated in the batch's one map-row `UPDATE`, with no
   version bump, no activity and no `SCHEDULE_CHANGED`.
5. Unique `(integration_id, entity_type, external_id)` plus the partial unique `internal_id` index make a
   duplicate impossible even if two writers race; a `P2002` is retried once as an update.

`idempotency.test.ts`: complete onboarding, run `SYNC` twice with the mock unchanged; the second run's counts are
all zero except `skipped`, and no `activity_events`, `audit_logs`, `notifications` rows are added, no
`shifts.version` changes, and `GET /api/mobile/v1/sync` returns the same `scheduleVersion`. Further cases: a
settings save that changes no target (toggle auto-include, change the sync window within the data) followed by a
SYNC leaves every `shifts.version` unchanged (`REHASH_ONLY` at most); hide then unhide a day (with
`respectHiddenDays` on); deactivate then reactivate an employee in Planday; reassign a shift X → Y (unmapped) → X;
each ends with the original shift `SCHEDULED` for X.

### 6.3 Departments → locations (spec §5)

STRUCTURE runs write the catalogue only. Applying happens at wizard step 3 (DB only, in the request) and in every
SYNC run's `DEPARTMENTS` phase. `decideDepartmentAction(department, mapping, mapRow, location)`:

| Situation                                                               | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Wizard default (suggestion)                                             | Target "new location" named like the department, `timezone` = portal time zone; if an existing ClockOff location has the same name (case-insensitive), suggest that location instead.                                                                                                                                                                                                                                                                                                                                                                                    |
| Included, target new location, no map row                               | Create `Location { name, timezone: portalTz, source: INTEGRATION, managedByIntegrationId }`; map row `LOCATION`; mapping stored as `{ target: "LOCATION", locationId }`.                                                                                                                                                                                                                                                                                                                                                                                                 |
| Included, target existing location                                      | Map row `LOCATION` to it; the location is not marked managed and its name is never changed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Included, target ClockOff department                                    | Map row `DEPARTMENT`; employees of that Planday department get `Employee.departmentId`; their shifts get `locationId = null`.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Excluded                                                                | No location; its employees are not imported unless another department of theirs is included; its shifts are never imported (6.6).                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Renamed in Planday, managed location                                    | Rename the location (hash changed).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Missing from a complete department list                                 | `upstreamRemovedAt = now`, location kept, warning `DEPARTMENT_MISSING` in the run and the card; never deleted (notes §11).                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| New department after onboarding                                         | Added to the catalogue as excluded (never auto-included), in-app notification "New Planday department <name>: choose where it goes" with a link to settings.                                                                                                                                                                                                                                                                                                                                                                                                             |
| Portal without departments, or people / shifts outside every department | Departments are optional per portal (notes §9.3). STRUCTURE's `EMPLOYEE_COUNTS` counts employees with an empty `departments[]` under the pseudo-id `"none"`. When that count is above 0, or the portal has no departments at all, the catalogue gets a row "Not in any department" (`"none"`), suggested target "new location" named after the portal. It behaves like a department: employees with an empty `departments[]` and shifts with `departmentId: null` belong to it. A portal with no departments therefore maps to one location instead of importing nobody. |

### 6.4 Employee groups → teams (optional)

| Situation                        | Action                                                                                                                                                                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Group mapped to "new team"       | Create `Team { name, source: INTEGRATION, managedByIntegrationId }`, map row `TEAM`.                                                                                                                                                                |
| Group mapped to an existing team | Map row `TEAM`; team not marked managed.                                                                                                                                                                                                            |
| Group not mapped                 | Ignored.                                                                                                                                                                                                                                            |
| Membership                       | For mapped teams only, `EmployeeTeam` rows equal the employee's Planday groups: add missing rows, remove rows for mapped teams the employee left. Memberships of unmapped (ClockOff-only) teams are never touched, so team overrides stay editable. |
| Renamed / missing                | As for departments.                                                                                                                                                                                                                                 |

### 6.5 Employees

**Scope.** A Planday employee is in scope when at least one of `departments[]` is in `includedDepartmentIds` (or
`departments[]` is empty and `"none"` is included, 6.3) and the id is not in `excludedEmployeeIds`. Out-of-scope
people are counted (`excluded.outOfScope`) and never persisted, in any table, warning or log; the staging sink
never stores them either (`dataMinimisation.test.ts`).

**Matching** — `matchExternalEmployee(external, candidates, plandayNameCounts)`, first rule that applies. A name
is never matched from a single page: a namesake on a later page would be unknown when an earlier page is applied.

- **Wizard.** The DIRECTORY run's `EMPLOYEES` phase only stages in-scope people (`PendingExternalEmployee`,
  reason `ONBOARDING`, no match yet). The database-only `MATCH_EMPLOYEES` phase then runs over the complete staged
  set (batches of 100): `plandayNameCounts` is computed from all staged rows, so namesakes on different pages are
  always seen. IMPORT_EMPLOYEES applies those results and the manager's step 5 choices.
- **After onboarding (SYNC).** Rules 1 to 3 apply per page (they compare against ClockOff's complete employee
  list). A name-only match (rule 4) never auto-links in a SYNC: it becomes `PendingExternalEmployee(reason
POSSIBLE_MATCH, matchedEmployeeId = the candidate, matchSignal NAME)` for one-click confirmation, whatever
  `autoIncludeNewEmployees` says. A new employee with no ClockOff candidate at all is imported (or queued) as
  below, which can never merge two people.

| Order | Signal                                                                                                                                                                                                                                                                                                          | Result                                                                                                                                                                                                                                                                                  |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `ExternalEntityMap(EMPLOYEE, id)`                                                                                                                                                                                                                                                                               | Mapped employee.                                                                                                                                                                                                                                                                        |
| 2a    | `Employee.externalEmployeeId` is exactly `PLANDAY:<currentPortalId>:<id>` (written by this integration), employee not deleted and not mapped to another Planday id                                                                                                                                              | Match (`EXTERNAL_ID`). A `PLANDAY:<otherPortalId>:…` value never matches.                                                                                                                                                                                                               |
| 2b    | `Employee.externalEmployeeId` is exactly `<id>` (a CSV import may carry the raw Planday id) **and** the email (case-insensitive) or the exact `nameKey` also agrees                                                                                                                                             | Match (`EXTERNAL_ID_RAW`). Raw id alone (payroll numbers collide with small Planday ids): wizard flag "possible match: confirm" (default action Create, the manager may Link); SYNC → `PendingExternalEmployee(reason POSSIBLE_MATCH, matchSignal EXTERNAL_ID_RAW)`. Never auto-linked. |
| 3     | Email equal (case-insensitive) to exactly one unmapped, non-deleted employee                                                                                                                                                                                                                                    | Match (`EMAIL`). Two or more → ambiguous.                                                                                                                                                                                                                                               |
| 4     | Exact full name (`nameKey` from `packages/shared/src/csv/matchEmployee.ts`) equal to exactly one unmapped employee, **and** `plandayNameCounts[nameKey] = 1` (no other in-scope Planday employee has that name, across all pages), **and** the ClockOff employee has no different email or external id recorded | Wizard: match (`NAME`), shown as matched. SYNC: `POSSIBLE_MATCH` (above).                                                                                                                                                                                                               |
| 5     | Name equals two or more ClockOff employees, or two Planday employees share the name and one ClockOff employee has it                                                                                                                                                                                            | `AMBIGUOUS`: never merged. Wizard: flag "ambiguous" and require a choice (link to a candidate, create new, exclude). After onboarding: `PendingExternalEmployee(reason AMBIGUOUS_MATCH, candidateEmployeeIds)`.                                                                         |
| 6     | Nothing                                                                                                                                                                                                                                                                                                         | New employee.                                                                                                                                                                                                                                                                           |

In a SYNC, a Planday employee whose only ClockOff candidate was linked earlier in the same run by another Planday
record (for example two Planday people sharing an email, on different pages) is queued `AMBIGUOUS_MATCH` with that
candidate rather than created, so two Planday people are never folded into one ClockOff employee and one person is
never created twice. Two new Planday namesakes with no ClockOff candidate are simply two new employees (duplicate
names are supported, 6.5 "No-email employees").

**Emails.** Planday's `email` is not documented as a work address (notes §9.2, §12 Q21). With `importEmails` on
(default, owner decision D-042) it is stored on the employee and is a managed field; with it off it is used in
memory for rule 3 only, never persisted (`Employee.email` is not written, pending rows keep `hasEmail` only), and
email stays editable in ClockOff. Wizard step 1 discloses "the email address on their Planday profile, which may
be a personal address"; step 5 has the "Import email addresses" toggle.

**Decisions** — `decideEmployeeAction(external, match, mapRow, employee, config, phase)`:

| Situation                                                                                                                                           | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wizard (DIRECTORY run)                                                                                                                              | `EMPLOYEES`: upsert `PendingExternalEmployee(reason ONBOARDING)` per in-scope person. `MATCH_EMPLOYEES`: write the match result (`matchedEmployeeId`, `matchSignal`, `candidateEmployeeIds`) over the complete staged set.                                                                                                                                                                                                                                                                                                                                                       |
| IMPORT_EMPLOYEES, selected, new                                                                                                                     | `importExternalEmployee`: `Employee { firstName, lastName, email (only with importEmails), externalEmployeeId: "PLANDAY:<portalId>:<id>", inviteStatus: NOT_INVITED, source: INTEGRATION, managedByIntegrationId, primaryLocationId, departmentId }`, `EmployeeLocation` / `EmployeeTeam` rows, map row; pending row deleted; the id is recorded in the session's `employeesImport.createdIds` (9.3).                                                                                                                                                                            |
| IMPORT_EMPLOYEES, selected, matched or manager-linked                                                                                               | `linkExternalEmployee`: map row; set `managedByIntegrationId`; overwrite first/last name (and email with importEmails) with Planday's; set `externalEmployeeId = PLANDAY:<portalId>:<id>` only when it is null; memberships as above; invite status, devices, policies untouched; recorded in `employeesImport.linkedIds`.                                                                                                                                                                                                                                                       |
| IMPORT_EMPLOYEES, unticked or "exclude"                                                                                                             | Id appended to `excludedEmployeeIds`; pending row deleted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| SYNC, mapped, fields changed                                                                                                                        | Update managed fields only: `firstName`, `lastName`, `email`, `primaryLocationId`, `departmentId` (when mapped to a ClockOff department), memberships of mapped locations and teams. Never `inviteStatus`, devices, policy or break-policy assignments, `jobTitle`, `phone`.                                                                                                                                                                                                                                                                                                     |
| SYNC, new in scope, `autoIncludeNewEmployees = true`, plan capacity available                                                                       | Import as above (`NOT_INVITED`); counted `created`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| SYNC, new in scope, auto-include off                                                                                                                | `PendingExternalEmployee(reason NEW_EMPLOYEE)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| SYNC, new in scope, plan capacity reached                                                                                                           | `PendingExternalEmployee(reason PLAN_LIMIT)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| SYNC, ambiguous                                                                                                                                     | `PendingExternalEmployee(reason AMBIGUOUS_MATCH)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| SYNC, possible match (name only, or raw CSV id without corroboration)                                                                               | `PendingExternalEmployee(reason POSSIBLE_MATCH)`; the manager links or creates (10.4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Listed by `GET /hr/v1.0/employees/deactivated?deactivatedFrom=<deactivationCheckedAt − 1 day>`, mapped and active, `deactivationDate` null or ≤ now | `deactivateManagedEmployee` (below), reason `DEACTIVATED_IN_PLANDAY`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Listed there with `deactivationDate` > now (a future dismissal)                                                                                     | No change; warning `DEACTIVATION_SCHEDULED` (once per run). The person is caught when the date has passed: by this list, or by the absent check below once they leave the active list.                                                                                                                                                                                                                                                                                                                                                                                           |
| Mapped, missing from `/employees` and not in `/deactivated` → `GET /hr/v1.0/employees/{id}` (at most 20 per run, notes §9.2 rule)                   | Positive evidence only (D-045): `isDeactivated: true` with `deactivationDate` null or ≤ now → deactivate, reason `REMOVED_FROM_PLANDAY`. Any other answer (400 or 404, which notes §8 makes a record-level skip and §12 Q24 leaves open; a body that is still active, for example when the authorising admin lost access to them) → warning `EMPLOYEE_NOT_VISIBLE`, map row `upstreamMissingSince` set if null, devices and access untouched.                                                                                                                                    |
| `upstreamMissingSince` older than 24 h, no `reviewDismissedAt`                                                                                      | `PendingExternalEmployee(reason MISSING_IN_PLANDAY, matchedEmployeeId)` and the `INTEGRATION_NEW_EMPLOYEES`-style prompt "N Planday employees can no longer be found — review" (10.4): Deactivate (manager action, `deactivateEmployee`) or Keep (`reviewDismissedAt = now`).                                                                                                                                                                                                                                                                                                    |
| Mapped employee seen again on `/employees`                                                                                                          | `upstreamMissingSince` and `reviewDismissedAt` cleared; a `MISSING_IN_PLANDAY` pending row is deleted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Future dismissal date while still on the active list only                                                                                           | Nothing until the date has passed (notes §12 Q23).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Mapped employee no longer has an included department                                                                                                | Kept as is (no deactivation), warning `EMPLOYEE_OUT_OF_SCOPE`; their shifts in excluded departments are cancelled by 6.6.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Deactivated by the sync (`upstreamRemovedAt` set), back on the active list                                                                          | Deferred to the database-only `REACTIVATIONS` phase, which runs after `DEACTIVATED_EMPLOYEES` and `ABSENT_EMPLOYEES` of the same run: the `EMPLOYEES` phase only records the id in the cursor (ids only). `REACTIVATIONS` skips any id the same run's deactivation phases listed with `deactivationDate` ≤ now, else `reactivateManagedEmployee`: `ACTIVE`, invite status recomputed (`recomputeEmployeeInviteStatus`), `EMPLOYEE_REACTIVATED` activity; the person must join again (their devices were revoked). Deactivated by a manager in ClockOff → left inactive, warning. |

An id on both lists in one run is decided by its `deactivationDate`, so an employee with a future dismissal who
appears on both never alternates between deactivated and reactivated (`syncEmployees.test.ts` › "future dismissal
on both lists": two SYNCs change nothing).

**Inactive employees keep their shifts.** `revokeEmployeeAccess` deliberately keeps an inactive employee's shifts
(`server/employees/employeeAccess.ts`: inactive employees are excluded from state computation, and a reactivated
employee's schedule should still be there). The shift sync follows that: a mapped employee who is `INACTIVE`
(deactivated in Planday or by a manager) is still a valid target, so their published shifts stay and keep
updating; they are not `OUT_OF_SCOPE`. Shifts Planday deletes when it deactivates someone arrive through the
deleted list as usual.

`deactivateManagedEmployee(tx, { organisationId, employeeId, integrationId, now, reason })` in
`apps/web/src/server/employees/employees.integration.ts` performs exactly what `deactivateEmployee` does with a
`SYSTEM` actor: `employmentStatus = INACTIVE`, `inviteStatus = DEACTIVATED`, `revokeEmployeeAccess(tx, {
revokeInvites: true, actor: { type: "SYSTEM" }, breakEndReason: "MANAGER_ENDED", now })` (devices deactivated,
push tokens forgotten, refresh tokens revoked, mobile identity unlinked, running break ended), activity
`EMPLOYEE_DEACTIVATED` `{ source: "PLANDAY", reason }`, map row `upstreamRemovedAt = now`. Never a hard delete.
After commit: `publishActivity`, `device.status.changed`. The run summary lists the count.

No-email employees are valid: they join with company code + name, or with a personal invite code when names
collide (existing mobile join: `AMBIGUOUS_MATCH` → invite code). Step 9 offers per-employee invite codes for
duplicate names (`createEmployeeInvite`).

**Locked fields.** `updateEmployee` (and the bulk and import paths that edit employees) rejects changes to
`firstName`, `lastName`, `email` (only while the integration's `importEmails` is on), `externalEmployeeId` and
`primaryLocationId` of an employee with `managedByIntegrationId` with `INTEGRATION_MANAGED` (409,
`details.provider = "PLANDAY"`). Policy, break policy,
team overrides, notes and every other ClockOff-only field stay editable. `deactivateEmployee` and `archiveEmployee`
stay available (a manager may cut off a phone immediately).

`assertEmployeeCapacity` in `employees.service.ts` is exported for the importer.

### 6.6 Shifts

**Window** (`core/window.ts`): `from` = start of yesterday and `to` = start of today + `syncWindowDays` days, in
the portal time zone (spec §5). Requests use `from − 1 day` and `to + 1 day` as `date` parameters (inclusive;
notes §10.3 rule 5); records are filtered on their computed instants (`endsAt > from` and `startsAt < to`). If
Planday answers 400 for the range (maximum undocumented, notes §12 Q37), the phase cursor switches to 14-day
slices.

**Filter** — `classifyPlandayShift(raw)`, applied before any mapping, first row that applies (notes §10.1 rule 1:
import a shift only if `status != "Draft"` and `employeeId != null`; notes §10.2: skip `employeeId == null`
whatever its status):

| Raw shift                                                                                                                                                                                                                    | Class                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `status === "Draft"`                                                                                                                                                                                                         | `DRAFT`: never imported (counted `excluded.drafts`).                                                                                                                     |
| `employeeId === null` (any status, including `Open`)                                                                                                                                                                         | `UNASSIGNED`: ignored (counted `excluded.open`).                                                                                                                         |
| `departmentId` not included (`null` counts as `"none"`, 6.3)                                                                                                                                                                 | `OUT_OF_SCOPE`.                                                                                                                                                          |
| `employeeId` not mapped to a ClockOff employee (map row missing, or the employee deleted)                                                                                                                                    | `OUT_OF_SCOPE` (counted; not persisted). A mapped employee who is `INACTIVE` is a valid target (6.5).                                                                    |
| `respectHiddenDays` and `scheduleDay.isVisible === false` for its department and local start date                                                                                                                            | `HIDDEN_DAY` (counted `excluded.hiddenDays`). Off by default (D-040, owner decision).                                                                                    |
| Status in `Open`, `Assigned`, `Approved`, `ForSale`, `OnDuty`, `PendingSwapAcceptance`, `PendingApproval`, `PunchclockStarted`, `PunchclockFinished`, `PunchclockApproved` (every documented non-`Draft` value, notes §10.1) | `PUBLISHED`: imported. `Open` with an employee is published by the notes' rule (notes §12 Q33 leaves open whether a published draft reads back as `Open` or `Assigned`). |
| Any undocumented status                                                                                                                                                                                                      | `UNKNOWN_STATUS`: skipped, warning with the status value (a status name is not personal data); never creates and never cancels a mapped shift.                           |
| Times invalid (4.8)                                                                                                                                                                                                          | `INVALID_TIME`: skipped, warning.                                                                                                                                        |

`core/shiftDecisions.test.ts` covers every row, including `{ status: "Open", employeeId: 1001 }` → `PUBLISHED`
and `{ status: "Open", employeeId: null }` → `UNASSIGNED`.

**Decision table** — `decideShiftAction({ existing, incoming, now, target })`. `existing` is the ClockOff shift
from the map row (or null); its time state is `FUTURE` (`startsAt > now`), `IN_PROGRESS`
(`startsAt ≤ now < endsAt`) or `ENDED` (`endsAt ≤ now`, or status `COMPLETED`). `incoming` is the classified
Planday shift or a removal (`DELETED` from `/shifts/deleted`, `NOT_FOUND` from a by-id 404, or a reclassification
to `DRAFT` / `UNASSIGNED` / `OUT_OF_SCOPE` / `HIDDEN_DAY`). `target` is the resolved employee and location (or
ClockOff department). Every outcome that writes the shift or cancels it also writes the incoming `lastHash` (6.2),
and every `CANCEL` (rows 8, 14 and 16) sets the map row's `upstreamRemovedAt`, which is what makes it eligible for
row 15.

| #   | Existing                                                            | Incoming                                                                                                                  | Action                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | none                                                                | `PUBLISHED`, `endsAt > now`                                                                                               | `CREATE` (`source INTEGRATION`, `externalShiftId PLANDAY:<portalId>:<id>`, `managedByIntegrationId`, `notes null`, `timezone` = shift zone).                                                                                                           |
| 2   | none                                                                | `PUBLISHED`, already ended                                                                                                | `SKIP` (`ENDED_BEFORE_IMPORT`); history before connecting is not imported.                                                                                                                                                                             |
| 3   | none                                                                | removal or non-`PUBLISHED`                                                                                                | `SKIP`.                                                                                                                                                                                                                                                |
| 4   | any (except the never-short-circuited states of 6.2 step 3)         | decision-input hash unchanged                                                                                             | `UNCHANGED`.                                                                                                                                                                                                                                           |
| 4a  | any non-ended                                                       | hash changed, but no ClockOff-visible field would change                                                                  | `REHASH_ONLY`: new `lastHash`, no version bump, no activity, no `SCHEDULE_CHANGED`.                                                                                                                                                                    |
| 5   | `ENDED`, `COMPLETED` or `CANCELLED`+ended                           | anything                                                                                                                  | `UNCHANGED` (ended shifts are never modified, spec §5).                                                                                                                                                                                                |
| 6   | `FUTURE`                                                            | `PUBLISHED`, times / location changed                                                                                     | `UPDATE` start, end, location; version +1.                                                                                                                                                                                                             |
| 7   | `FUTURE`                                                            | `PUBLISHED`, employee changed to another mapped employee                                                                  | `REASSIGN` in place (`employeeId`), version +1, `SCHEDULE_CHANGED` for both employees.                                                                                                                                                                 |
| 8   | `FUTURE`                                                            | removal (including `HIDDEN_DAY` when enabled), or employee changed to an unmapped person                                  | `CANCEL` (status `CANCELLED`, version +1, map row `upstreamRemovedAt = now`). Never deleted.                                                                                                                                                           |
| 9   | `IN_PROGRESS`                                                       | `PUBLISHED`, end later (extended)                                                                                         | `UPDATE_END` to the new end; version +1.                                                                                                                                                                                                               |
| 10  | `IN_PROGRESS`                                                       | `PUBLISHED`, end earlier but after `now` (shortened)                                                                      | `UPDATE_END`; version +1; a running break that now falls outside the window is ended (`endActiveBreakOutside`).                                                                                                                                        |
| 11  | `IN_PROGRESS`                                                       | `PUBLISHED`, new end ≤ `now`                                                                                              | `END_NOW`: `endsAt = now` (rounded up to the minute; the 15-minute minimum does not apply), version +1, running break ended `SHIFT_ENDED`. Work Mode ends at the next device sync.                                                                     |
| 12  | `IN_PROGRESS`                                                       | `PUBLISHED`, start changed but still ≤ `now`                                                                              | Start ignored (it already happened); end handled by rows 9 to 11; warning `IN_PROGRESS_START_IGNORED`.                                                                                                                                                 |
| 13  | `IN_PROGRESS`                                                       | `PUBLISHED`, new start > `now`                                                                                            | Treated as `FUTURE`: `UPDATE` start and end, version +1.                                                                                                                                                                                               |
| 14  | `IN_PROGRESS`                                                       | removal (`DELETED`, `NOT_FOUND`, `DRAFT`, `UNASSIGNED`, `OUT_OF_SCOPE`; never `HIDDEN_DAY`), or reassigned to anyone else | `CANCEL` for the old employee: version +1, running break ended `SHIFT_ENDED`, push. If the new assignee is a mapped employee, `CREATE` a new shift for them in the same transaction (see below).                                                       |
| 14a | `IN_PROGRESS`                                                       | `HIDDEN_DAY`                                                                                                              | `UNCHANGED` plus warning `HIDDEN_DAY_IN_PROGRESS`: a day hidden after the shift started never ends Work Mode mid-shift (spec §5 allows only Planday shortening, extending or removal).                                                                 |
| 15  | `CANCELLED` by the integration (`upstreamRemovedAt` set), not ended | `PUBLISHED` again                                                                                                         | `REINSTATE` with the full incoming target: status `SCHEDULED`, employee, location and times from Planday, version +1, `upstreamRemovedAt = null`. If the employee differs from the cancelled shift's, `SCHEDULE_CHANGED` for both, as `REASSIGN` does. |
| 16  | `FUTURE` with `startsAt ≥ to` (window shrank)                       | not read                                                                                                                  | `CANCEL` (`OUT_OF_WINDOW`); reinstated by row 15 when it re-enters the window.                                                                                                                                                                         |
| 17  | any non-ended                                                       | `UNKNOWN_STATUS` or `INVALID_TIME`                                                                                        | `UNCHANGED` plus warning (never cancel on uncertainty).                                                                                                                                                                                                |

Row 14 detail: an in-progress shift reassigned in Planday is cancelled for the old employee and created as a
fresh shift for the new one in the same transaction (in-place reassignment, row 7, is only for future shifts):
the map row's `internal_id` is repointed to the new shift and the old shift's `externalShiftId` becomes
`PLANDAY:<portalId>:<id>:superseded:<oldShiftId>` (the column is unique per org). Tested in `syncShifts.test.ts`,
together with row 15's full target (A's shift moves to unmapped Y and is cancelled, then to mapped C: the shift
belongs to C, and A's `scheduleVersion` changes).

**Removal evidence.** Absence alone never cancels (Decision D-045):

- `DELETED_SHIFTS` phase: `GET /scheduling/v1.0/shifts/deleted?deletedFrom=<deletedShiftsCheckedAt − 1 day>`
  (first run: `connectedAt − 1 day`). The watermark `deletedShiftsCheckedAt` moves to the run's `startedAt` only
  when this phase completes, never because `SHIFTS` completed, so a run that ends `PARTIAL` before it leaves the
  watermark where it was. The one-day overlap covers the undocumented zone of `dateTimeDeleted` (notes §12 Q30);
  re-reading a deletion is idempotent. Each mapped id → removal `DELETED`.
- `ABSENT_SHIFTS` phase: mapped, non-ended, non-cancelled shifts inside the window whose map row
  `lastSeenAt < run.startedAt` after a complete `SHIFTS` phase → `GET /scheduling/v1.0/shifts/{id}` (at most 50
  per run; the rest wait for the next run). 404 → `NOT_FOUND`; a body → classify and decide normally (it may have
  moved outside the window, become a draft or been reassigned).
- The `SHIFTS` phase must have read every page without error for `ABSENT_SHIFTS` to run; otherwise the phase is
  skipped and the run is `PARTIAL`.

**Overlaps.** A Planday shift overlapping another shift of the same employee is created anyway (Planday is the
source of truth; `mergeShiftIntervals` already makes overlapping intervals safe for the engine) and reported as
warning `CONFLICT` with both ids; the card shows "N Planday shifts overlap shifts added in ClockOff". At
onboarding, overlaps with existing manual or CSV shifts are offered for replacement (step 6). Decision D-034.

Replacement happens in the worker, not at Finish: Finish stores the ticked shift ids on the INITIAL SYNC run
(`IntegrationSyncRun.replaceShiftIds`, after checking they belong to the organisation). When the apply sink
creates a Planday shift for employee E, it cancels each listed shift of E that overlaps it **in the same
transaction**, through `cancelReplacedShift(tx, { organisationId, shiftId, approvedByUserId, now })` in
`shifts.integration.ts`: the one writer allowed to touch an unmanaged shift, only for ids in that list, only while
the shift is `SCHEDULED` and still `FUTURE` (in-progress and ended shifts are left alone), with activity
`SHIFT_CANCELLED` `{ source: "PLANDAY", reason: "REPLACED_BY_PLANDAY" }` and audit
`integration.conflicting_shift_replaced` on behalf of the manager who finished (`approvedByUserId` =
`run.requestedByUserId`). A listed shift that no Planday shift replaced is not cancelled; the run summary lists
it as an unresolved conflict. Until the INITIAL SYNC creates the replacement, the employee keeps the original
shift, so nobody is left without a schedule if that run is parked, fails or meets `AUTH_ERROR`.

**Breaks.** None are imported (section 1.2).

**Read-only.** `updateShift`, `cancelShift`, `deleteShift` and the edit actions of `bulkShiftAction` reject a
shift with `managedByIntegrationId` with `INTEGRATION_MANAGED` (bulk: per-item failure `INTEGRATION_MANAGED`).
`duplicateShift` stays allowed and creates an ordinary `MANUAL` shift ("manual ClockOff shifts allowed but
labelled": the schedule shows source badges "Planday" and "ClockOff").

### 6.7 Time zones, DST and overnight

- Shift instants: section 4.8. `Shift.timezone` = the shift's `timeZone` (IANA), else the portal's.
- Locations created from departments get the portal time zone (department zones are not readable, notes §10.3).
- At wizard step 2, a portal `timeZone` that is not a valid IANA id blocks Continue with "Planday reports the time
  zone '<value>', which ClockOff cannot read yet. Contact support." (no guessing; notes §10.3 rule 3).
- Tested with the fixture's overnight shifts and the shift spanning 2026-10-25 01:00 (Europe/London fall-back),
  in all three date-time encodings the mock can emit (wall-clock, `Z`, offset).

### 6.8 Clock events (Beta, `PLANDAY_CLOCK_MODE_ENABLED`, default `false`)

Only when the flag is on and `Integration.activationMode = CLOCK_EVENT`:

- A `CLOCK` run every 2 minutes (enqueued by the upkeep job, 7.9): `GET /punchclock/v1.0/punchclockshifts?from=<now − 3 h>&to=<now + 1 h>&limit=50`
  (overlapping windows, notes §9.4 rule; date-times sent as wall-clock in the portal zone, the documented example
  format). The list has no department filter (notes §9.4), so each record is filtered first: a record whose
  `departmentId` is not included, or whose `employeeId` is not mapped to an in-scope ClockOff employee, is dropped
  in memory (counted `excluded.outOfScope`, never persisted). Each remaining record → `ClockEvent CLOCK_IN`
  (`startDateTime`) and, when `endDateTime` is set, `CLOCK_OUT`; breaks fetched once per record after it has an
  `endDateTime` → `BREAK_START` / `BREAK_END` (reference only). `recordClockEvent` is idempotent on
  `(organisationId, "PLANDAY", externalId)` with the portal-qualified ids of 2.6.
- Reconciliation, writing Shift rows only through `shifts.integration.ts` (the engine is unchanged): a `CLOCK_OUT`
  earlier than the matched in-progress integration shift's end → `END_NOW` at the punch-out time; a `CLOCK_IN` up
  to 60 minutes before a matched future shift's start → start moved to the punch-in time. Without punches the
  scheduled shift runs as published: scheduled activation is the fallback.
- Latency is documented honestly in `docs/integrations/PLANDAY.md`: up to the 2-minute poll, plus Planday's
  undocumented punch freshness, plus device sync. Wizard step 8 shows the option disabled ("Beta") unless the
  flag is on.

### 6.9 Writing through the existing services

`apps/web/src/server/shifts/shifts.internal.ts` (extracted in stage 3, behaviour-preserving) holds
`updateShiftRow`, `endActiveBreakOutside`, `recordShiftActivity`, `auditSnapshot`, `instantsOf`, all taking a
`ShiftActor = { organisationId, actorType: "MANAGER" | "SYSTEM", actorUserId: string | null }`;
`shifts.service.ts` builds the actor from `ManagerContext` and its tests keep passing unchanged.

`apps/web/src/server/shifts/shifts.integration.ts`:

```ts
export interface IntegrationShiftWriteResult {
  rows: ShiftRow[];
  activities: ActivityEvent[]; // publish after commit
  scheduleChanges: Array<{ employeeId: string; shiftIds: string[]; reason: ScheduleChangeReason }>;
}
export function createIntegrationShifts(
  tx,
  actor,
  integrationId,
  inputs: IntegrationShiftInput[],
  opts: { recordActivity: boolean },
): Promise<IntegrationShiftWriteResult>; // createMany + map rows
export function rescheduleIntegrationShift(
  tx,
  actor,
  current: ShiftRow,
  patch: { startsAt?: Date; endsAt: Date; locationId?: string | null; employeeId?: string },
  now: Date,
): Promise<IntegrationShiftWriteResult>;
export function cancelIntegrationShift(
  tx,
  actor,
  current: ShiftRow,
  now: Date,
  reason: ShiftRemovalReason | "OUT_OF_WINDOW" | "DISCONNECTED",
): Promise<IntegrationShiftWriteResult>;
export function reinstateIntegrationShift(
  tx,
  actor,
  current: ShiftRow,
  target: { startsAt: Date; endsAt: Date; employeeId: string; locationId: string | null },
): Promise<IntegrationShiftWriteResult>;
export function bulkRescheduleIntegrationShifts(
  tx,
  actor,
  changes: Array<{ current: ShiftRow; patch: ReschedulePatch }>,
  now: Date,
): Promise<IntegrationShiftWriteResult>;
export function cancelReplacedShift(
  tx,
  input: { organisationId: string; shiftId: string; approvedByUserId: string | null; now: Date },
): Promise<IntegrationShiftWriteResult | null>; // null: not cancelled (not SCHEDULED or not FUTURE)
```

- Every function refuses a shift whose `managedByIntegrationId` is not the caller's integration (manual and CSV
  shifts are never touched by a sync), and every query filters on the run's `organisationId` as well as the id
  (11). The one exception is `cancelReplacedShift` (6.6 Overlaps), limited to the manager-approved ids on the
  INITIAL run.
- Every change bumps `version` through `updateShiftRow`'s optimistic lock; a `CONFLICT` (concurrent change) is
  retried once with the fresh row. Because `computeScheduleVersion` hashes `id:version:status`, every change
  changes the employee's `scheduleVersion` and `GET /api/mobile/v1/sync` delivers it.
- Activity: `SHIFT_UPDATED` / `SHIFT_CANCELLED` / `SHIFT_CREATED` with `actorType: SYSTEM`, metadata
  `{ source: "PLANDAY", reason, … }` for every change, except creations in the first `SYNC` after onboarding
  (one `INTEGRATION_SYNCED` summary instead of hundreds of rows). No audit row per synced shift (audit covers
  manager actions, spec §10).
- After the page transaction commits, the executor calls `publishActivity` for each event and
  `publishScheduleChanged` per employee (reason `UPDATED` / `CANCELLED` / `CREATED`). They travel on
  `PostgresEventBus`: dashboards receive them over SSE, and the worker's elected push-bridge leader (this worker or
  another) debounces them into silent pushes. No flush is needed: the worker is long-lived (7.7 covers shutdown).
- Bulk writes (6.1): `shift.createMany` plus `externalEntityMap.createMany` per page of up to 100, one bulk
  `UPDATE … FROM (VALUES …)` for changed shifts (`bulkRescheduleIntegrationShifts`, version-checked, conflicts
  retried one by one), one `activityEvent.createMany`, inside one transaction; then one `findMany` to return rows.

Locations and teams: `locations.integration.ts` (`createManagedLocations`, `renameManagedLocation`) and
`teams.integration.ts` (`createManagedTeams`, `renameManagedTeam`, `syncManagedTeamMemberships`).
`updateLocation` / `updateTeam` reject a name change on a managed row with `INTEGRATION_MANAGED`; deleting a
managed location or team is rejected likewise (remap or exclude in Planday settings instead).
`deleteDepartment` of a ClockOff department used as a mapping target is rejected with `CONFLICT`.

## 7. Jobs on the Railway worker

### 7.1 Where each sync runs

```text
 web (Next.js standalone, runs no jobs)                      worker (always on, one replica)
 ─────────────────────────────────────                       ─────────────────────────────────────────────────────
 connect proof A/B/C (≤ 18 s, 5.6) ──▶ Planday               scheduler, lane "integrations" (advisory lock + slot claim)
 wizard step · Sync now · settings ·                           integrations-sync    every 15 min, lock 4
 Finish · reconnect                                              → runScheduledIntegrationSyncs(): SCHEDULED runs (7.8)
   │ one transaction: the change + enqueueRun()                integrations-upkeep  every minute, lock 6
   ▼                                                             → runIntegrationsUpkeep(): health, RECOVERY, CLOCK,
 integration_sync_runs  (status RUNNING, first_claimed_at NULL) ◀──  catch-up, stalled runs, housekeeping (7.9)
   │ after COMMIT: bus "integration.run.queued"
   │   (NOTIFY clockoff_events) ──────────────────────────────▶ integrationRunner (7.5)
   │                                                            wake on the bus event, else poll every 10 s
   │                                                            claimDueRuns() → per-portal lease (7.4)
   │                                                            runSyncSlice(): steps of one Planday page + one
   │                                                            transaction, ≤ 120 s per slice (7.6) ──▶ Planday
   │                                                            after each committed step:
 web SSE /api/realtime/stream ◀──── NOTIFY ◀────────────────── bus "integration.sync.progress" (7.11)
   ▼
 wizard / Integrations card refetch GET /api/integrations/planday/runs/:id
```

| Sync                | Queued by                                                                                                   | Queue row (kind, trigger, priority)            | Executed by                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------- |
| Initial: structure  | web, after the connect proof (`connect/token`, OAuth `callback`, 5.6)                                       | `STRUCTURE`, `INITIAL`, 0                      | runner                                   |
| Initial: directory  | web, wizard step 3 save and `onboarding/shift-preview/refresh`                                              | `DIRECTORY`, `INITIAL`, 0                      | runner                                   |
| Initial: import     | web, wizard step 5 save                                                                                     | `IMPORT_EMPLOYEES`, `INITIAL`, 0               | runner (database only, no Planday calls) |
| Initial: first sync | web, wizard Finish (supersedes an active wizard run, 9.5)                                                   | `SYNC`, `INITIAL`, 0, `replaceShiftIds`        | runner                                   |
| Manual "Sync now"   | web, `POST /api/integrations/planday/sync` (≤ once a minute), settings save, `retryAuth`                    | `SYNC`, `MANUAL`, 0 (`retryAuth` flag)         | runner                                   |
| Scheduled           | worker, `integrations-sync` at every quarter hour (7.8); `integrations-upkeep` catch-up after a missed slot | `SYNC`, `SCHEDULED`, 3; `resumeAfter` = jitter | runner                                   |
| Recovery            | worker, `integrations-upkeep` on the backoff schedule (7.10); web on reconnect after onboarding (5.6)       | `SYNC`, `RECOVERY`, 2                          | runner                                   |
| Auth probe          | worker, `integrations-upkeep` for `AUTH_ERROR` connections (7.9 step 3)                                     | `SYNC`, `RECOVERY`, 2, `retryAuth`             | runner                                   |
| Clock (Beta)        | worker, `integrations-upkeep` every 2 minutes (6.8)                                                         | `CLOCK`, `SCHEDULED`, 1                        | runner                                   |

`SYNC` and `CLOCK` runs exist only after wizard Finish (`onboardingCompletedAt`, 7.3); before it, only the three
wizard kinds run, so nothing imports employees or shifts behind the manager's step 5 and step 6 choices.

Why this shape (Decision D-031, rewritten for Railway):

- Web redeploys on every push to `main` and drains in 30 s; it runs no jobs by design (`processBoundaries.test.ts`).
  The worker is always on, drains in 60 s and already owns every background job. A sync inside a web request
  would be cut by deploys and would break the process boundary.
- One execution path: initial, manual, scheduled, recovery and clock runs all go through `runSyncSlice()`, so the
  tests of one cover all, and nothing depends on which process or trigger created a run.
- The queue row is durable. A run survives restarts, deploys and crashes, and resumes at its last committed page.
- The bus wake-up starts a queued run within about a second; the 10 s poll covers a lost NOTIFY (the bus never
  replays).
- The scheduler's lanes keep their contract: the minute lane (Work Mode) never waits for Planday, and the two
  integration jobs only enqueue and evaluate, finishing in seconds. Long work happens in the runner, outside the
  lanes, so a 20-minute initial sync of a large portal never produces `skipped_overlap`.

### 7.2 Run kinds and phases

`provider.phasesFor(kind, options)`:

| Kind               | Phases                                                                                                                                                                                                                                                                   | Sink    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| `STRUCTURE`        | `PORTAL_CHECK`, `DEPARTMENTS`, `EMPLOYEE_GROUPS`, `EMPLOYEE_COUNTS` (pages `/hr/v1.0/employees`, counts in memory only, including `"none"`), `FINALISE`                                                                                                                  | staging |
| `DIRECTORY`        | `PORTAL_CHECK`, `EMPLOYEES` (stage in-scope people), `MATCH_EMPLOYEES` (database only, over the complete staged set, 6.5), `SCHEDULE_DAYS` (if `respectHiddenDays`), `PREVIEW_SHIFTS` (next 14 days), `FINALISE`                                                         | staging |
| `IMPORT_EMPLOYEES` | `APPLY_EMPLOYEES` (from staging rows and the step 5 choices, batches of 100, no Planday calls), `FINALISE`                                                                                                                                                               | apply   |
| `SYNC`             | `PORTAL_CHECK` (forced token refresh, 4.3), `DEPARTMENTS`, `EMPLOYEE_GROUPS`, `EMPLOYEES`, `DEACTIVATED_EMPLOYEES`, `ABSENT_EMPLOYEES`, `REACTIVATIONS` (database only, 6.5), `SCHEDULE_DAYS`?, `SHIFTS`, `DELETED_SHIFTS`, `ABSENT_SHIFTS`, `CLOCK_EVENTS`?, `FINALISE` | apply   |
| `CLOCK`            | `CLOCK_EVENTS`, `FINALISE`                                                                                                                                                                                                                                               | apply   |

`PORTAL_CHECK` calls `GET /portal/v1.0/info` and fails the run with `INTEGRATION_PORTAL_MISMATCH` (connection →
`AUTH_ERROR`) if the id differs from `externalPortalId` (notes §2). In a `retryAuth` run, a successful
`PORTAL_CHECK` moves the connection `AUTH_ERROR → CONNECTED` at once (conditional, 2.2), clears
`authErrorNotifiedAt` and `authProbeAttempts`, and the run continues as an ordinary SYNC.

`FINALISE` (one fenced transaction, 7.6): status `SUCCEEDED` (no warnings), `PARTIAL` (warnings, or a guarded
phase skipped) or `FAILED`; `finishedAt`; `cursor = {}` (no per-run lists survive the run); for `SYNC`:
`lastSuccessfulSyncAt = run.startedAt` (only when `SHIFTS` completed), `deactivationCheckedAt` (only when
`DEACTIVATED_EMPLOYEES` completed), `deletedShiftsCheckedAt` (only when `DELETED_SHIFTS` completed),
`consecutiveFailureCount = 0`, `nextSyncAt` = the next quarter hour (display only: the slot job creates scheduled
runs, 7.8), `setConnectionStatus(CONNECTED, { from: [SYNCING, DEGRADED] })`, clear `degraded*` fields; one
`INTEGRATION_SYNCED` activity when anything changed (`counts` in metadata); one `INTEGRATION_NEW_EMPLOYEES`
notification when new pending rows appeared (deduplicated: skipped while an unread one exists for the
integration). Wizard kinds touch no connection field.

Follow-ups, in the same transaction:

1. **Mapping moved.** If `IntegrationMappingConfig.mappingVersion` is no longer the run's snapshot (settings or
   mappings changed while it ran), a follow-up **of the same kind** is queued: a `SYNC` gets a `MANUAL` `SYNC`; a
   `DIRECTORY` gets a `DIRECTORY` (wizard steps 3 and 4 saved during it). `STRUCTURE`, `IMPORT_EMPLOYEES` and
   `CLOCK` get none. A follow-up `SYNC` is still subject to the onboarding gate (7.3).
2. **Pending slot.** If the connection's pending-run slot (7.3) is set and rule 1 queued nothing, the slot is
   cleared and that run inserted; if rule 1 queued a run of the same kind, the slot is simply cleared; otherwise it
   stays set and drains when the rule 1 run ends. Both rules use `enqueueRun` and are announced after commit.

The same two rules run when a run ends `FAILED` through `failRun`, so a queued request is never lost because the
run in front of it failed.

### 7.3 The run queue (`integration_sync_runs`)

- The table is the queue. A run is **active** while `status = 'RUNNING'`: queued (`firstClaimedAt` null; the UI
  says "Waiting to start") or started. The partial unique index `integration_sync_runs_one_running` allows one
  active run per integration. Terminal statuses are the spec's `SUCCEEDED`, `PARTIAL` and `FAILED`; no `QUEUED`
  status is added.
- `apps/web/src/server/integrations/runs/enqueue.ts`, used by web services and the worker's jobs alike:

  ```ts
  export interface EnqueueRunInput {
    organisationId: string;
    integrationId: string;
    kind: IntegrationSyncRunKind;
    trigger: IntegrationSyncTrigger;
    requestedByUserId?: string | null;
    /** Default: RUN_PRIORITY by trigger and kind (runs/constants.ts). */
    priority?: number;
    /** Not claimable before this instant (scheduled jitter, recovery backoff). */
    resumeAfter?: Date | null;
    /** Manual auth retry or automatic auth probe (7.10): the only runs allowed to start on AUTH_ERROR. */
    retryAuth?: boolean;
    /** INITIAL SYNC only (6.6 Overlaps). */
    replaceShiftIds?: string[];
  }
  export type EnqueueRunResult =
    | { outcome: "QUEUED"; run: IntegrationSyncRun }
    /** An active run of the same kind exists and has not started yet, or is the same request; nothing inserted. */
    | { outcome: "ALREADY_RUNNING"; run: IntegrationSyncRun }
    /** A run is active: the request went into the connection's pending slot and starts when that run ends. */
    | { outcome: "FOLLOW_UP_QUEUED"; run: IntegrationSyncRun }
    /** SYNC / CLOCK before onboarding is complete: nothing inserted. */
    | { outcome: "REFUSED"; reason: "ONBOARDING_INCOMPLETE" };
  /** Safe inside the caller's transaction: never raises a unique violation. */
  export function enqueueRun(db: Db, input: EnqueueRunInput): Promise<EnqueueRunResult>;
  /** Call after COMMIT only: publishes `integration.run.queued` (runner wake-up; dashboards refetch). */
  export function announceRunQueued(
    run: Pick<IntegrationSyncRun, "id" | "organisationId" | "integrationId" | "kind" | "trigger">,
  ): void;
  ```

  Rules, in order:

  1. **Onboarding gate.** `kind` `SYNC` or `CLOCK` while `IntegrationMappingConfig.onboardingCompletedAt` is null →
     `REFUSED` (`ONBOARDING_INCOMPLETE`). The same check runs at the start of every slice (7.6), in the upkeep
     queries (7.9) and in `POST …/sync` and `PATCH …/settings` (409 `INTEGRATION_ONBOARDING_INCOMPLETE`), so no
     path imports employees or shifts before Finish.
  2. **Insert.** `INSERT … ON CONFLICT ("integration_id") WHERE "status" = 'RUNNING' DO NOTHING RETURNING *`
     (inference on the partial unique index), so a duplicate never aborts the caller's transaction. A returned row
     → `QUEUED`. The row gets `mappingVersion` from the mapping config and `progress = { completedPhases: [],
totalPhases, label: "Waiting to start", pagesRead: 0 }`.
  3. **Active run exists.** Nothing was returned, so the active run is selected:
     - same kind and not yet claimed (`firstClaimedAt` null) → `ALREADY_RUNNING` (it will read the current state
       anyway); a `retryAuth` request sets `retry_auth = true` on it;
     - same kind, already started, and the request is a manual "Sync now" without `retryAuth` →
       `ALREADY_RUNNING` (a mapping change is caught by FINALISE rule 1 instead, 7.2);
     - otherwise (another kind, for example "Sync now" during a `CLOCK` run or Finish during a refresh) → the
       request is written to the connection's pending slot (`pendingRunKind`, `pendingRunTrigger`,
       `pendingRunRetryAuth`, `pendingRunRequestedByUserId`, `pendingRunRequestedAt`) and the result is
       `FOLLOW_UP_QUEUED` with the active run. The slot holds one request: a `SYNC` replaces a `CLOCK` (a SYNC
       includes clock events), a wizard kind replaces an older wizard kind, and a `retryAuth` flag is never
       dropped. The active run's terminal write drains it (7.2).
       Callers report the outcome: "Sync now" answers `{ run, alreadyRunning, followUpQueued }`, so a request is never
       silently dropped. `runQueue.test.ts` covers each branch, including Finish's `INITIAL` SYNC and a step 5
       `IMPORT_EMPLOYEES` requested while another run is active.

- `RUN_PRIORITY` (lower runs first): `INTERACTIVE = 0` (wizard runs, manual syncs, settings saves), `CLOCK = 1`,
  `RECOVERY = 2`, `SCHEDULED = 3`. The priority applies to a run's first slice only: a run that has already had
  a slice (`firstClaimedAt` not null) competes at `GREATEST(priority, 3)`, round-robin with every other started or
  scheduled run, so a 20-minute initial sync of a large portal answers the wizard quickly but cannot hold back
  other portals' scheduled syncs for more than one slice each.
- `claimDueRuns({ limit, providers, instanceId })` in `runs/runs.repository.ts`:

  ```sql
  SELECT r.id, r.integration_id
    FROM integration_sync_runs r
    JOIN integrations i ON i.id = r.integration_id
    JOIN integration_connections c ON c.integration_id = r.integration_id
   WHERE r.status = 'RUNNING'
     AND i.provider = ANY($providers)                 -- AVAILABLE providers only (PLANDAY_ENABLED)
     AND (r.resume_after IS NULL OR r.resume_after <= now())
     AND (c.sync_lease_id IS NULL OR c.sync_lease_expires_at < now())
   ORDER BY CASE WHEN r.first_claimed_at IS NULL THEN r.priority ELSE GREATEST(r.priority, 3) END,
            COALESCE(r.last_slice_at, r.created_at)
   LIMIT $limit * 3;
  ```

  For each candidate in order it calls `acquireLease(integrationId, holder = randomUUID(), LEASE_TTL_MS)` (7.4)
  until `limit` leases are held, then `UPDATE integration_sync_runs SET claimed_by = $instanceId,
first_claimed_at = COALESCE(first_claimed_at, now()) WHERE id = $id AND status = 'RUNNING'` (0 rows: the run
  finished or was cancelled meanwhile → release the lease, skip). Two workers racing for one candidate are safe:
  `acquireLease` is a single conditional `UPDATE`, so exactly one wins. It also returns `nextResumeAt` (the
  earliest future `resume_after` among active runs) for the runner's timer.

- Ordering: a queued interactive run goes first; after its first slice every run round-robins at the scheduled
  level by when it last got service (`COALESCE(last_slice_at, created_at)`), so a long run that yields after its
  slice lets other portals' runs in. `runQueue.test.ts` › "a long priority-0 run cannot delay a SCHEDULED run of
  another integration by more than one slice" (concurrency 1).

### 7.4 Per-portal lease (`integration_connections.sync_lease_*`)

- **Acquire** (`runs.repository.ts`), on the database clock:

  ```sql
  UPDATE integration_connections
     SET sync_lease_id = $holder, sync_lease_expires_at = now() + make_interval(secs => $ttl)
   WHERE integration_id = $id
     AND (sync_lease_id IS NULL OR sync_lease_expires_at < now() OR sync_lease_id = $holder)
  RETURNING id;
  ```

- **Renew and fence**: `UPDATE integration_connections SET sync_lease_expires_at = now() + make_interval(secs =>
$ttl) WHERE integration_id = $id AND sync_lease_id = $holder AND sync_lease_expires_at > now() RETURNING id`. A
  timer renews every `LEASE_RENEW_MS` (20 s) while a slice runs, and the same statement opens every step
  transaction as its fence (7.6). Zero rows → `LeaseLostError`: the step rolls back and the slice stops.
- **Release**: `… SET sync_lease_id = NULL, sync_lease_expires_at = NULL WHERE integration_id = $id AND
sync_lease_id = $holder`.
- `LEASE_TTL_MS` = 90 s. A holder that dies (crash, SIGKILL, frozen container) frees the portal within 90 s.
- Holders: the runner (a fresh holder uuid per slice) and web's connect proof (waits up to `CONNECT_LEASE_WAIT_MS`
  = 3 s, polling every 250 ms, else `CONFLICT` "A sync is in progress; try again in a minute"). Every Planday API
  request stream for a portal runs under it, which is what spec §3's "one concurrent request stream per portal"
  means across processes; inside one process `KeyedSerialQueue` serialises requests (4.5). Because one live
  connection exists per portal across organisations (D-054, 2.5), the connection's lease is the portal's lease.
  Disconnect takes no lease but clears it (5.8): the slice it cancels finds its lease gone at the next renewal (or
  at once through `integration.run.cancelled`, 7.5) and every write it attempts is fenced, so a reconnect can start
  immediately.
- Why a row lease and not a Postgres advisory lock (Decision D-043): web needs it too and has only pooled Prisma
  connections (a session advisory lock cannot live behind PgBouncer's transaction mode, and the worker's
  `DIRECT_URL` lock session is worker-only); expiry on the database clock frees a dead holder without a session to
  time out; and the holder uuid doubles as a fencing token checked inside every write, so a holder that lost its
  lease (long pause, partition) cannot write. The runner holds no advisory lock; the job locks (keys 4 and 6) only
  serialise the two integration jobs.

### 7.5 The integration runner (`apps/web/src/worker/integrationRunner.ts`)

```ts
export interface IntegrationRunnerDeps {
  log: Logger;
  /** Worker instance id (heartbeat identity), written to `claimed_by`. */
  instanceId: string;
  /** Default runnerConcurrency(env().DATABASE_URL): RUNNER_CONCURRENCY (2) capped by the Prisma pool. */
  concurrency?: number;
  /** Default RUNNER_POLL_MS (10 000). */
  pollMs?: number;
  /** Default SLICE_MAX_MS (120 000). */
  sliceMaxMs?: number;
  /** Providers whose registered implementation is AVAILABLE and resumable (empty while PLANDAY_ENABLED=false). */
  availableProviders?: () => IntegrationProvider[];
  claim?: typeof claimDueRuns;
  runSlice?: typeof runSyncSlice;
  /** Default: getEventBus().subscribeAll. */
  subscribe?: (handler: RealtimeEventHandler) => Unsubscribe;
  clock?: () => number;
}

export interface IntegrationRunnerStatus {
  inFlight: Array<{ runId: string; kind: IntegrationSyncRunKind; runningForMs: number }>;
  lastPollAt: string | null;
  slicesFinished: number;
}

export interface IntegrationRunner {
  /** After the migration gate, with the jobs: registers providers, subscribes to the bus, polls at once. */
  start(): void;
  /** Coalesced "poll now" (bus event, a settled slice). */
  wake(): void;
  /** Shutdown step 1: no new claims, poll timer stopped, bus unsubscribed, the shared AbortSignal fired. */
  halt(): void;
  /** Shutdown step 3: waits up to graceMs for in-flight slices; returns the run ids still running. */
  drain(graceMs: number): Promise<{ abandoned: string[] }>;
  status(): IntegrationRunnerStatus;
}

export function createIntegrationRunner(deps: IntegrationRunnerDeps): IntegrationRunner;
```

- **Wiring** (`cli.ts` `serve`): created next to the scheduler; `startAfterMigrationGate` starts it right after the
  minute trigger, only when `WORKER_JOBS_ENABLED` (paused jobs pause runs too; queued runs wait). `run <job>` and
  `emit-diagnostic` never start it. The heartbeat's `details` gain `integrationRunner: status()`.
- **Poll** (never two at once; a wake during a poll schedules exactly one more): `free = concurrency −
inFlight.size`; when `free > 0` and `availableProviders()` is not empty, `claimDueRuns({ limit: free,
providers, instanceId })`. Each claim starts `runSyncSlice(runId, { holder, instanceId, signal, maxMs, now,
log })`, tracked in `inFlight`. When a slice settles it is removed, one line is logged (`integration slice
finished { runId, kind, trigger, outcome, steps, requests, durationMs }`) and `wake()` is called (the same run
  may be due again after yielding, or another one was waiting for capacity). The next timer is `min(pollMs,
nextResumeAt − now)`, `unref`'d (the `serve` keep-alive interval keeps the process up).
- **Wake-ups**: the bus handler calls `wake()` for `integration.run.queued`, and for
  `integration.run.cancelled { runId }` it aborts that run's slice controller if the run is in flight here (a
  disconnect or a Finish that superseded a wizard run). Without `DIRECT_URL` (local development without the
  Postgres bus) only the poll and the lease renewal work, which is fine.
- **Errors**: a failing poll or claim is logged (`integration runner poll failed`) and retried at the next poll; a
  slice that throws is logged at `error` and counted; nothing in the runner can exit the process.
- **Pool guard**: `runnerConcurrency(databaseUrl)` in `runs/constants.ts` returns `min(RUNNER_CONCURRENCY,
max(1, connectionLimit − 2))`, where `connectionLimit` is the `connection_limit` parameter of `DATABASE_URL`
  (Prisma's default `2 × CPUs + 1` when absent). Start-up logs `integration runner started { concurrency,
poolSize }` (never the URL) and warns below 4 connections: the runner shares one Prisma pool with the
  per-minute Work Mode jobs.
- **Overrun guard**: a slice still running `SLICE_OVERRUN_MS` (60 s) after its `maxMs` is logged at `error`
  (`integration slice overran`) and its own controller is aborted; if it never returns, its lease expires and the
  run is claimed again. The watchdog keeps watching only the minute lane (exiting the worker for a slow Planday
  portal would hurt Work Mode); the integrations lane and the runner are monitored through `/api/health` instead
  (7.9 "Monitoring").
- **Memory**: one page per slice in memory (≤ 100 shifts or 50 employees) and concurrency 2 fit the worker's
  256 MiB (heap cap 160 MiB).

### 7.6 Slice algorithm (`runSyncSlice` in `apps/web/src/server/integrations/runs/executor.ts`)

```ts
export type SliceOutcome =
  | { state: "DONE"; status: "SUCCEEDED" | "PARTIAL" | "FAILED"; steps: number; requests: number }
  | {
      state: "YIELDED";
      reason: "SLICE_TIME" | "SHUTDOWN" | "LEASE_LOST";
      steps: number;
      requests: number;
    }
  | {
      state: "PARKED";
      reason: "RATE_LIMITED" | "RETRY_BACKOFF";
      resumeAfter: Date;
      steps: number;
      requests: number;
    }
  | { state: "SKIPPED"; reason: "NOT_RUNNING" | "PROVIDER_UNAVAILABLE" };

export function runSyncSlice(
  runId: string,
  opts: {
    /** Lease token from claimDueRuns (or a test holder); the slice renews and finally releases it. */
    holder: string;
    instanceId: string;
    signal: AbortSignal;
    maxMs?: number;
    now?: () => Date;
    log?: Logger;
  },
): Promise<SliceOutcome>;
```

```text
runSyncSlice(runId, { holder, signal, maxMs = 120 000, now, log })
  started = now(); local = AbortSignal.any([signal, leaseLost.signal])
  renewTimer = every 20 s: renewLease(holder) — 0 rows → leaseLost.abort()
  try
    run = load(runId); if !run or run.status ≠ RUNNING → SKIPPED(NOT_RUNNING)
    ensureProvidersRegistered(); provider not AVAILABLE or not resumable → SKIPPED(PROVIDER_UNAVAILABLE)
    v0 = connection.credential_version                                // the store tracks it as knownVersion()
    connection DISCONNECTED or credentials wiped → fenced(failRun(DISCONNECTED, { touchConnection: false }))
    kind ∈ (SYNC, CLOCK) and onboardingCompletedAt IS NULL → fenced(failRun(ONBOARDING_INCOMPLETE,
                                                                   { touchConnection: false })) → DONE(FAILED)
    connection AUTH_ERROR and not run.retryAuth → fenced(failRun(AUTH_ERROR, { touchConnection: false }))
    if kind = SYNC → setConnectionStatus(SYNCING, { from: [CONNECTED], credentialVersion: v0 })  // CLOCK never
    publishRunProgress(run, { force: true })
    loop
      if local.aborted → YIELDED(SHUTDOWN | LEASE_LOST)
      if now() − started ≥ maxMs → YIELDED(SLICE_TIME)
      if run.requestCount ≥ RUN_REQUEST_BUDGET → fenced(finalise(PARTIAL, REQUEST_BUDGET_EXHAUSTED)) → DONE
      step = phase ∈ DATABASE_ONLY_PHASES ? (sink step, inside the transaction below)
                                          : provider.runPhaseStep(ctx, run.phase, run.cursor, inputsFor(run))
             // ctx = { signal: local, credentialStore: PrismaCredentialStore(integrationId, holder), log, now, … }
             // the Planday page is fully read here, BEFORE any transaction opens
      fenced(tx ⇒ sink.apply(step.batch, run, tx);                            // ≤ 100 records, batched writes (6.1)
             UPDATE integration_sync_runs SET phase, cursor, counts, warnings, progress, request_count, attempt = 0)
      after COMMIT: publish the activities and SCHEDULE_CHANGED events the sink collected; publishRunProgress(run)
      if step.done → run.phase = next(run.phase); FINALISE → fenced(finalise(run)) → DONE(status)
  catch (every path below first checks stillOwned(): run RUNNING, lease held by $holder, connection not
         DISCONNECTED and credential_version = store.knownVersion(); if not → SKIPPED(NOT_RUNNING), nothing written)
  catch PlandayRateLimitedError(retryAt) → fenced(parkRun(retryAt)) → PARKED(RATE_LIMITED)
  catch auth (AUTH_FAILED, SCOPE_MISSING, PORTAL_MISMATCH, mock connection in live mode) →
      fenced(failRun + enterAuthError())                                // 8.4; enterAuthError is a no-op on a
      → DONE(FAILED)                                                    // retryAuth run (already AUTH_ERROR)
  catch retryable (UNAVAILABLE, CREDENTIAL_PERSIST_FAILED, Prisma P1001/P1008/P2024/P2028/P2034) →
      run.attempt += 1; attempt ≥ RUN_RETRY_ATTEMPTS (3) → fenced(failRun + scheduleRecovery()) → DONE(FAILED)
      else fenced(parkRun(now + fullJitterBackoff(attempt, { baseMs: 5 000, capMs: 120 000 }))) → PARKED(RETRY_BACKOFF)
  catch AbortError (shutdown or lease lost, from a fetch or an abortable wait) → YIELDED (the step wrote nothing)
  catch RunCancelled or CredentialsWipedError → SKIPPED(NOT_RUNNING); catch LeaseLostError → YIELDED(LEASE_LOST)
  catch INVALID_RESPONSE or unexpected → fenced(failRun + scheduleRecovery()) → DONE(FAILED)
  finally
    clear renewTimer
    UPDATE integration_sync_runs SET claimed_by = NULL, last_slice_at = now() WHERE id = run.id AND claimed_by = $instanceId
    releaseLease(holder); publishRunProgress(run, { force: true })

fenced(work) = prisma.$transaction(timeout 10 s, maxWait 5 s):
  fence 1: UPDATE integration_sync_runs SET heartbeat_at = now()
            WHERE id = run.id AND status = 'RUNNING' RETURNING id             // 0 rows → RunCancelled (rollback)
  fence 2: renew the lease with $holder (7.4)                                 // 0 rows → LeaseLostError (rollback)
  work(tx)                                                                    // every connection write inside is a
                                                                              // compare-and-set (2.2) on status and
                                                                              // credential_version = knownVersion()
```

Every write a slice makes (steps, park, fail, finalise, and the connection-status changes they carry) goes through
`fenced`, so a run that a disconnect, a Finish or the upkeep job has already ended, or a slice that lost its
lease, writes nothing; and every connection write is a compare-and-set, so a slice can never move a
`DISCONNECTED` connection (nor one reconnected since it started) to `AUTH_ERROR`, nor bump its failure count.

- **Step contract.** One step = one provider page of at most 100 records (or one batch of 100 for a
  database-only phase, which makes no Planday call) + one apply transaction that also writes the cursor.
  Interrupting a slice anywhere leaves either the whole step committed or none of it, and replaying a step is a
  no-op (6.2), so no state is ever half applied.
- **No transaction spans a Planday call.** The page is fetched before the transaction opens; token refresh
  persists through one guarded `UPDATE` (4.3). Transactions are database-only and short (10 s timeout), so the
  shared Prisma pool stays available to the per-minute jobs.
- `failRun` sets `status = FAILED`, `finishedAt`, `errorCode`, a sanitised `errorMessage`, `cursor = {}`, and runs
  the FINALISE follow-up rules (7.2). For `SYNC` and `CLOCK` runs only, it also updates the connection
  (`WHERE status IN ('CONNECTED','SYNCING','DEGRADED') AND credential_version = knownVersion()`):
  `consecutiveFailureCount += 1`, `lastErrorCode`, `lastErrorMessage`, `SYNCING → CONNECTED` (health decides
  `DEGRADED` by time, section 8). A failed wizard run (`STRUCTURE`, `DIRECTORY`, `IMPORT_EMPLOYEES`) touches no
  connection field and schedules no recovery: the wizard shows the error and its Retry re-queues the same kind.
  Auth failures still move the connection to `AUTH_ERROR` whatever the kind (the wizard shows it inline).
- `parkRun(resumeAfter)` keeps the run `RUNNING` with `resume_after` set and a human label ("Waiting for Planday's
  rate limit — resumes at 10:42"); the lease is released, so the worker serves other portals meanwhile.
- `scheduleRecovery()` (`SYNC` and `CLOCK` runs only, same conditional update) sets `nextSyncAt = now +
recoveryBackoffMs(consecutiveFailureCount)` (7.10); the upkeep job enqueues the `RECOVERY` run when it is due.
- Tests drive runs through the same function: `driveRunToCompletion(runId, { now, ignoreResumeAfter })`
  (`test/integration/planday/plandayHarness.ts`) acquires the lease with a test holder and loops slices until
  `DONE`.

### 7.7 SIGTERM, slices and the 25-second grace

Every deploy sends SIGTERM to the old worker (60 s draining, no overlap: the new worker starts at once, waits for
its migration gate, then claims runs). `SHUTDOWN_GRACE_MS` is at most 25 s (default 20 s). `WorkerShutdownDeps` in
`shutdown.ts` gains `haltIntegrationRunner()` and `drainIntegrationRunner(graceMs)`; the order and the fixed budget
(20.5 s, checked by `railwayConfig.test.ts`) stay as they are:

1. **Step 1, stop timers**: also calls `haltIntegrationRunner()` (`runner.halt()`). No new claims; the shared
   AbortSignal fires.
2. In-flight slices react at their next await:
   - an API `GET` in flight is aborted (its signal is `AbortSignal.any([AbortSignal.timeout(10_000), signal])`).
     The page is discarded; nothing of that step was written; the cursor still points at the page;
   - a token request is **not** aborted (it has only its own 10 s timeout), so a refresh token Planday may have
     rotated is always persisted before the slice stops (4.3);
   - an apply transaction already running commits normally (10 s timeout); the loop sees the signal before the
     next step;
   - a rate-limit or backoff wait inside the slice is abortable and ends at once;
   - `finally` clears `claimed_by`, stamps `last_slice_at`, releases the lease and publishes a last progress event.
3. **Step 3, stop scheduler**: awaits `scheduler.stop(graceMs)` and `drainIntegrationRunner(graceMs)`
   (`runner.drain`) together, within the same grace, so the shutdown budget does not grow; abandoned runs are
   logged with the abandoned jobs.

Worst case from SIGTERM to a released lease: one token request (≤ 10 s) plus its `UPDATE` attempts (≤ 5 s, 4.3)
and the release, or one apply transaction (≤ 10 s) plus the release; both inside the 20 s default and the 25 s
maximum. If the grace
still runs out (for example the database stalls), the process exits: Postgres rolls back the open transaction when
its connection closes, the lease expires within 90 s, and the next worker (normally the new deployment) resumes at
the last committed cursor.

Events from committed steps (activities, `SCHEDULE_CHANGED`, progress) are queued on the bus before step 6 closes
it. A `SCHEDULE_CHANGED` published during the push-leadership hand-over may reach no bridge; the shift rows and
`scheduleVersion` are committed, so phones pick the change up at their next sync (the bus's existing behaviour).

Web SIGTERM: from the signal on, web refuses new connect proofs (5.6), and a proof in flight is bounded by
`CONNECT_BUDGET_MS = SHUTDOWN_GRACE_MS − 2 s`, so it finishes (persist included) before web's grace runs out. If it
is cut anyway, nothing was persisted (persisting is the proof's last step, 5.6), the lease expires within 90 s,
and the manager connects again.

### 7.8 The 15-minute slot: `apps/web/src/server/integrations/scheduledSync.ts`

The worker job stays as it is (`integrations-sync`, lane `integrations`, `intervalMinutes: 15`, lock key 4, minute
slot claim). Its implementation is rewritten from a no-op into the scheduled-run enqueuer. Exact interface:

```ts
export interface ScheduledSyncCandidate {
  integrationId: string;
  organisationId: string;
  /** An active (RUNNING) SYNC run exists for the integration (an active CLOCK run does not count, 7.3). */
  hasActiveRun: boolean;
  /** createdAt of the newest SYNC run of any trigger, or null. */
  lastSyncRunCreatedAt: Date | null;
}

export interface ScheduledSyncReport {
  /** Registered providers whose implementation is AVAILABLE and resumable. */
  availableProviders: number;
  /** Connections eligible for a scheduled sync (rules below). */
  integrations: number;
  /** SCHEDULED SYNC runs created for this slot. */
  enqueued: number;
  /** Eligible, but a run is active or a SYNC run was created less than 10 minutes ago. */
  skipped: number;
  /** Candidates whose enqueue threw (logged; the loop continued). */
  failed: number;
  reason?: "NO_AVAILABLE_PROVIDER";
}

export interface ScheduledSyncOptions {
  log?: Logger;
  /** Default: the start of now's minute. Scheduled runs become claimable at slotStart + jitter. */
  slotStart?: Date;
  /** Test seam (default: one query per provider, findScheduledSyncCandidates). */
  findCandidates?: (provider: IntegrationProvider, now: Date) => Promise<ScheduledSyncCandidate[]>;
  /** Test seam (default: enqueueRun + announceRunQueued). */
  enqueue?: (input: EnqueueRunInput) => Promise<EnqueueRunResult>;
}

export function runScheduledIntegrationSyncs(
  now: Date,
  opts?: ScheduledSyncOptions,
): Promise<ScheduledSyncReport>;

/** 0–119: first four bytes of sha256(integrationId) mod 120. Spreads portals on ClockOff's shared App ID. */
export function scheduledJitterSeconds(integrationId: string): number;
```

1. `ensureProvidersRegistered()`; providers = `INTEGRATION_PROVIDERS` whose `providerAvailability(id)` is
   `AVAILABLE` and whose `getProvider(id)` passes `isResumableProvider`. None → `{ availableProviders: 0,
integrations: 0, enqueued: 0, skipped: 0, failed: 0, reason: "NO_AVAILABLE_PROVIDER" }`, which is what
   production reports until stage 8 and whenever `PLANDAY_ENABLED=false`.
2. Candidates (one query per provider): `integration_connections.status IN ('CONNECTED', 'SYNCING', 'DEGRADED')`,
   `integration_mapping_configs.onboarding_completed_at IS NOT NULL`, `is_mock = false` in live mode.
3. Per candidate: `hasActiveRun` or `lastSyncRunCreatedAt > now − 10 min` → `skipped`; otherwise
   `enqueueRun({ kind: "SYNC", trigger: "SCHEDULED", priority: RUN_PRIORITY.SCHEDULED, resumeAfter: slotStart +
scheduledJitterSeconds(integrationId) s })` (a `CLOCK` run in progress turns it into `FOLLOW_UP_QUEUED`, so the
   slot is not lost), `announceRunQueued(run)`, and `next_sync_at = slotStart + 15 min` on the connection (the
   card's "Next scheduled sync"). `enqueued` counts `QUEUED` and `FOLLOW_UP_QUEUED`.
4. A failing candidate is logged with its integration id only, counted in `failed`, and the loop continues. The
   function never calls Planday and finishes in seconds.
5. The slot start is computed locally (`Math.floor(now / 60 000) × 60 000`): server modules may not import
   `src/worker` (`processBoundaries.test.ts`), so `minuteStart()` from `jobs.ts` is not reused.

`apps/web/src/worker/jobs.ts`, `integrationsSync.run`:

```ts
const report = await runScheduledIntegrationSyncs(ctx.now, { log: ctx.log });
return {
  ok: report.failed === 0,
  processed: report.enqueued,
  details: { ...report },
  ...(report.failed > 0 ? { error: `enqueue failed for ${report.failed} integration(s)` } : {}),
};
```

The module comment of `scheduledSync.ts` is rewritten (no `SYNC_SINK_PENDING`), `server/integrations/index.ts`
exports the new types, and `scheduledSync.test.ts` is rewritten for the rules above. An operator run (`node
main.mjs run integrations-sync` in the worker container, `railway ssh --service worker`) takes lock 4 without a
slot claim and is harmless: one active run per integration and the 10-minute rule make it idempotent.

### 7.9 The per-minute upkeep job: `integrations-upkeep`

New job in `apps/web/src/worker/jobs.ts`, after `integrations-sync` in `WORKER_JOBS` (at a quarter hour the lane
runs the slot job first):

```ts
const integrationsUpkeep: WorkerJob = {
  name: "integrations-upkeep",
  description:
    "Integration health, recovery and clock runs, missed-slot catch-up, stalled runs and housekeeping.",
  lockKey: LOCK_KEYS.integrationsUpkeep, // LOCK_KEY_NAMESPACE | 6n = 4849333701445681158 (never reused)
  intervalMinutes: 1,
  lane: "integrations",
  async run(ctx) {
    const { runIntegrationsUpkeep } = await import("@/server/integrations/upkeep");
    const report = await runIntegrationsUpkeep(ctx.now, { log: ctx.log, signal: ctx.signal });
    return {
      ok: report.failedSteps.length === 0,
      processed:
        report.recoveryEnqueued +
        report.authProbesEnqueued +
        report.clockEnqueued +
        report.catchUpEnqueued,
      details: { ...report },
      ...(report.failedSteps.length > 0
        ? { error: `failed: ${report.failedSteps.join(", ")}` }
        : {}),
    };
  },
};
```

`WorkerJobName` gains `"integrations-upkeep"`; `lockKeys.ts` gains `integrationsUpkeep` (key 6; the push-bridge
lease keeps 5).

```ts
// apps/web/src/server/integrations/upkeep.ts
export interface IntegrationsUpkeepReport {
  availableProviders: number;
  health: { evaluated: number; degraded: number; recovered: number; emails: number };
  recoveryEnqueued: number;
  authProbesEnqueued: number;
  clockEnqueued: number;
  catchUpEnqueued: number;
  stalledRunsFailed: number;
  syncingReset: number;
  missingReviewsCreated: number;
  /** Present on the housekeeping minute only. */
  housekeeping?: {
    oauthStates: number;
    connectLinks: number;
    runs: number;
    sessionsAbandoned: number;
  };
  failedSteps: string[];
  reason?: "NO_AVAILABLE_PROVIDER" | "PAUSED";
}
export function runIntegrationsUpkeep(
  now: Date,
  opts?: {
    log?: Logger;
    /** UPKEEP_BUDGET_MS = 15 000: well inside SHUTDOWN_GRACE_MS (default 20 s). */
    budgetMs?: number;
    /** UPKEEP_STEP_TIMEOUT_MS = 5 000 per step, sends included. */
    stepTimeoutMs?: number;
    /** Aborted by scheduler.stop() (the scheduler now sets JobContext.signal, 7.12). */
    signal?: AbortSignal;
  },
): Promise<IntegrationsUpkeepReport>;
```

Steps, each guarded (a failure or a step that exceeds `stepTimeoutMs` is logged, its name added to `failedSteps`,
and the next step runs); once `budgetMs` is spent, or `signal` is aborted, the remaining steps wait for the next
minute. Every connection query below requires `onboarding_completed_at IS NOT NULL` (7.3):

1. `evaluateIntegrationHealth(now)` (section 8): `DEGRADED` transitions, recovery, 6-hour emails; each transition
   is a compare-and-set on the `status` and `last_sync_at` it read (2.2), so it never overwrites a `CONNECTED`
   that a FINALISE wrote meanwhile.
2. Recovery: connections with `consecutive_failure_count` between 1 and 4, status `CONNECTED`/`SYNCING`/`DEGRADED`,
   onboarding complete, `next_sync_at ≤ now`, no active run → `enqueueRun({ kind: SYNC, trigger: RECOVERY })`.
3. Auth probes: connections in `AUTH_ERROR` with `last_error_code = 'PLANDAY_AUTH_FAILED'`, onboarding complete,
   `next_sync_at ≤ now`, no active run, and in `AUTH_ERROR` for less than 7 days → `enqueueRun({ kind: SYNC,
trigger: RECOVERY, retryAuth: true })`, `authProbeAttempts += 1`, `next_sync_at = now + probeBackoff(attempts)`
   (5 minutes, 15 minutes, then hourly). A probe costs one refresh grant (plus one `GET /portal/v1.0/info` when it
   succeeds), so a revoked token costs at most one token request per hour per portal. A successful probe returns
   the connection to `CONNECTED` (7.2) and sends one `INTEGRATION_RECOVERED` notification; a failed one changes
   nothing else (no new notification or email: `authErrorNotifiedAt` is still set). Deterministic failures
   (portal mismatch, missing scope, a mock connection in live mode) are not probed.
4. Catch-up: connections eligible under 7.8 whose newest `SYNC` run was created more than 20 minutes ago (a slot
   was missed, for example during a deploy at the quarter hour) → `SCHEDULED` run without jitter.
5. Clock (Beta, only with `PLANDAY_CLOCK_MODE_ENABLED` and `Integration.activationMode = CLOCK_EVENT`, onboarding
   complete): on even minutes, when no run is active and the newest `CLOCK` run was created at least 110 s ago →
   `CLOCK` run.
6. Runs: `RUNNING` runs created more than `RUN_MAX_AGE_MS` (2 h) ago whose lease is free → `failRun(STALLED)` (its
   follow-up rules and, for SYNC/CLOCK, `scheduleRecovery()`); connections left `SYNCING` without an active run →
   `CONNECTED` (conditional on `SYNCING`).
7. Missing employees: map rows with `upstream_missing_since < now − 24 h` and no `review_dismissed_at` and no
   pending row → `PendingExternalEmployee(MISSING_IN_PLANDAY)` (6.5) plus one deduplicated prompt notification.
8. Housekeeping, at minute 7 of each hour only: delete OAuth states expired or consumed more than 1 day ago,
   connect links expired more than 30 days ago, runs older than 90 days beyond the newest 50 per integration;
   mark onboarding sessions without activity for 30 days `ABANDONED`, purge their pending and preview rows and
   release their employee imports (9.3).

Every enqueue above is followed by `announceRunQueued`. With no AVAILABLE provider the job returns
`reason: "NO_AVAILABLE_PROVIDER"` before step 1 and does nothing else; while `PLANDAY_ENABLED=false` after release
it reports `reason: "PAUSED"` when any live Planday connection exists, so the health endpoint's paused banner
(8.3) has a log line to match.

**Monitoring.** The integrations lane is not watched by the minute-lane watchdog, so stage 4 adds:
`scheduler.laneLastCompletedAt("integrations")` (alongside `minuteLaneLastCompletedAt`) in the heartbeat details as
`integrationsLaneLastCompletedAt`, plus `integrationRunner: runner.status()`; `/api/health` gains
`worker.integrations: "ok" | "stale" | "disabled" | "unknown"` from `worker_job_runs.last_ok_at` of
`integrations-upkeep` (`stale` after 5 minutes without an `ok`; `disabled` with jobs disabled). It does not change
the health status code (like `worker.jobs`), and Gate D checks it is `ok` from stage 4 on.

### 7.10 Scheduling, manual sync, retries, backoff and 429

- **Scheduled**: every quarter hour per portal, claimable 0–119 s after the slot (deterministic per integration,
  so portals on ClockOff's shared App ID do not fire together). With `DEGRADED` after 60 minutes, four missed
  slots raise the amber banner.
- **Manual**: `POST /api/integrations/planday/sync` (`integrations:write`) → 409
  `INTEGRATION_ONBOARDING_INCOMPLETE` before Finish; `CONFLICT INTEGRATION_NOT_CONNECTED` unless
  `CONNECTED`/`SYNCING`/`DEGRADED` (or `AUTH_ERROR` with `{ retryAuth: true }`, which enqueues a `MANUAL` `SYNC` with
  `retry_auth = true`, the only kind of run allowed to start on `AUTH_ERROR`; its forced refresh and
  `PORTAL_CHECK` are the connection test and success returns the connection to `CONNECTED`, 7.2); the response is
  `{ run, alreadyRunning, followUpQueued }` from `enqueueRun` (7.3), so a request during a run of another kind is
  queued behind it rather than dropped; a manual run created less than 60 s ago → `RATE_LIMITED` with
  `details.retryAfterSeconds` (a follow-up counts as created). Audit `integration.sync_requested`. The run is
  announced after commit, so it starts within about a second.
- **Request retries** (client, 4.5): 5xx, 409 on `GET`, network errors and timeouts get full-jitter exponential
  backoff (base 500 ms, factor 2, cap 8 s), at most 3 attempts per request, then `PLANDAY_UNAVAILABLE`.
- **429** (notes §6): wait `x-ratelimit-reset` seconds; if an undocumented `Retry-After` is also present, the
  longer of the two (notes §12 Q15); neither → 60 s; plus 0–1 s jitter. A wait of at most `MAX_INLINE_WAIT_MS`
  (30 s) is slept inside the slice (abortable by shutdown); a longer one throws `PlandayRateLimitedError(retryAt)`
  and the run is parked until `retryAt` with its lease released. At most 3 inline 429 waits per request, then the
  run is parked. `x-ratelimit-remaining ≤ 2` applies the same wait before the next request on that key.
- **Run-level retries**: a retryable failure parks the run with full-jitter backoff (5 s … 120 s) for attempts 1
  and 2; the third fails the run and schedules recovery.
- **Recovery backoff** (`recoveryBackoffMs(n)`, n = `consecutiveFailureCount` after the failure): 1, 2, 5 and 10
  minutes for n = 1 to 4; from n = 5 no recovery run is scheduled and the quarter-hour schedule continues, so
  recovery is never slower than the schedule. `AUTH_ERROR` stops ordinary automatic runs; a reconnect, a manual
  `retryAuth` or a successful automatic auth probe (7.9 step 3: after 5 minutes, 15 minutes, then hourly for up to
  7 days) resumes them. The probes keep the spec's immediate `AUTH_ERROR`, banner, email and notification, and
  recover a connection that a transient identity-server error put there without a manager having to act.
- **Budgets** (4.5) live in the process that makes the requests. Nearly all Planday traffic is the worker's (one
  replica), so the per-client-id budget for methods A and B covers every portal; web's connect proofs add a few
  requests each from their own bucket (risk listed in section 16).

### 7.11 Progress reporting to the wizard

- **Events** (added to `REALTIME_EVENT_TYPES` in `apps/web/src/server/events/EventBus.ts` and
  `packages/validation/src/realtime.ts`, stage 1):

  | Type                         | Published by                                                                                                                                                                                                                               | Payload                                                                                                                                                               |
  | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `integration.run.queued`     | `announceRunQueued` (web services, worker jobs)                                                                                                                                                                                            | `{ provider, integrationId, runId, kind, trigger }`                                                                                                                   |
  | `integration.run.cancelled`  | disconnect, Finish superseding a wizard run (5.8, 9.5)                                                                                                                                                                                     | `{ provider, integrationId, runId }`; the runner aborts that slice (7.5); dashboards refetch the run                                                                  |
  | `integration.sync.progress`  | `publishRunProgress` (runner slices)                                                                                                                                                                                                       | `{ provider, integrationId, runId, kind, trigger, status, phase, label, completedPhases, totalPhases, pagesRead, queued, resumeAfter, finished }` (counts as numbers) |
  | `integration.health.changed` | `setConnectionStatus` after commit (8.1), only for transitions that change the banner or the compliance flag: into or out of `DEGRADED`, `AUTH_ERROR` or `DISCONNECTED` (never `CONNECTED ↔ SYNCING`, which progress events already cover) | `{ provider, integrationId, status }`                                                                                                                                 |

  Payloads hold ids, enums, numbers and labels ClockOff writes itself; never names, emails, Planday values or
  error text from Planday (`progressEvents.test.ts` scans them). `publishRunProgress` sends at most one event per
  run every `PROGRESS_EVENT_MIN_INTERVAL_MS` (2 s), and always on a phase change, park, yield and finish.

- **Path**: worker `publish` → `PostgresEventBus` NOTIFY on `clockoff_events` → web's listener →
  `GET /api/realtime/stream` (organisation-scoped SSE) → `useRealtime` → `REALTIME_INVALIDATIONS`:
  `integration.run.queued`, `integration.run.cancelled` and `integration.sync.progress` → `[plandayKeys.runs,
plandayKeys.detail, plandayKeys.onboarding]`; `integration.health.changed` → `[integrationKeys.health,
plandayKeys.detail, complianceKeys.all]`. Events are hints; the UI always refetches
  `GET /api/integrations/planday/runs/:runId`. The query keys live in
  `apps/web/src/components/integrations/integration-keys.ts` (created in stage 1: `integrationKeys` moved there
  from `use-integrations.ts`, which re-exports it, plus `integrationKeys.health` and `plandayKeys`), so the
  realtime model (stage 6), the hooks (stages 6 and 7) and the banner (stage 7) import one stage-1 file.
- **Fallback**: NOTIFYs are not replayed (listener reconnects, the 5-minute planned stream rotation, deploys). The
  realtime provider already refetches every mapped key after a drop and polls every 30 s while disconnected. In
  addition `useSyncRun(runId)` (`hooks/use-planday-runs.ts`) refetches every 3 s while the run is active and the
  stream is not `connected`, and every 15 s while it is, and stops once the run has finished.
- **DTO**: `GET /api/integrations/planday/runs/:runId` (manager) → `PlandaySyncRun`: `{ id, kind, trigger, status,
queued, phase, progress: { completedPhases, totalPhases, label, pagesRead }, counts, warningsCount, warnings
(first 20), resumeAfter, startedAt, finishedAt, errorCode, errorMessage }`. Labels are human ("Waiting to
  start", "Reading employees (page 3)", "Importing shifts", "Waiting for Planday's rate limit").

### 7.12 Railway constraints checklist

| Constraint                                                                | Handling                                                                                                                                                                                         |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Web runs no jobs; redeploys on every push; 30 s draining                  | Web only enqueues; its only Planday calls are the bounded connect proof and revocation; `processBoundaries.test.ts` lists the run entry points                                                   |
| Worker SIGTERM: `SHUTDOWN_GRACE_MS` ≤ 25 s inside 60 s draining           | 7.7: abort API reads, never token requests; drain within the scheduler's grace; resumable cursors                                                                                                |
| One worker replica, no deploy overlap; old and new worker briefly coexist | Per-portal leases with fencing; one active run per integration; slot claims for the two jobs                                                                                                     |
| The integrations lane is not watched by the watchdog                      | Both jobs only enqueue and evaluate (15 s budget, 5 s per step, aborted by `scheduler.stop`); the runner has its own overrun guard; `/api/health` reports `worker.integrations` (7.9 Monitoring) |
| `JobContext.signal` is not set by the scheduler today                     | Stage 4A: the scheduler gives each lane pass an `AbortController`, passes its signal as `ctx.signal`, and aborts it in `stop()`                                                                  |
| One Prisma pool shared with the per-minute jobs                           | Runner concurrency capped by `connection_limit`; no transaction spans a Planday call; 10 s transactions                                                                                          |
| 256 MiB worker memory (heap cap 160 MiB)                                  | One page per slice in memory; concurrency 2; batched writes                                                                                                                                      |
| NOTIFY is not replayed                                                    | Progress events are hints; run polling fallback; 10 s runner poll                                                                                                                                |
| Database round trips (Railway EU West to Neon London)                     | Batched reads per page; `createMany`; one `last_seen_at` update per page                                                                                                                         |
| Migrations run before web switches over; old code and rollbacks remain    | Expand-only migrations (2.1)                                                                                                                                                                     |
| Variables are listed by name in `.railway/railway.ts`                     | Stage 1 adds the `PLANDAY_*` names (appendix A)                                                                                                                                                  |
| Neon compute is kept awake by the worker                                  | The runner adds one indexed query every 10 s; the worker already keeps compute awake (the Neon plan risk in `docs/STATUS.md` is unchanged)                                                       |

## 8. Health monitoring

### 8.1 State machine (`IntegrationConnection.status`)

```text
             connect proof OK                 run starts            run FINALISE (SHIFTS done)
CONNECTING ───────────────────▶ CONNECTED ─────────────▶ SYNCING ───────────────────────────▶ CONNECTED
     │ proof fails: no row change  ▲  ▲ │                    │ non-auth failure ─────────────▶ CONNECTED (failure count +1)
     ▼                             │  │ │ ≥ 60 min without a successful sync (upkeep job)
  (stays CONNECTING / previous)    │  │ ▼
                                   │  └── DEGRADED ◀── upkeep (also from SYNCING) ; next successful run ─▶ CONNECTED
       reconnect proof OK ─────────┘
 CONNECTED / SYNCING / DEGRADED ── auth failure (token 400/401, 401 after refresh, 403, portal mismatch,
                                    mock in live mode) ──▶ AUTH_ERROR
 AUTH_ERROR ── retryAuth run or auth probe passes PORTAL_CHECK ──▶ CONNECTED ; reconnect proof OK ──▶ CONNECTED
 any ── manager disconnect ──▶ DISCONNECTED ── connect proof OK (same portal, or a confirmed switch) ──▶ CONNECTED
```

- `SYNCING` is set only by `SYNC` runs (never `CLOCK`), so clock mode does not make the status flap every two
  minutes. `SYNCING` never hides a problem: a run on a `DEGRADED` connection leaves it `DEGRADED` until it
  succeeds; a run never starts on `AUTH_ERROR` except a `retryAuth` run.
- Health is evaluated only after onboarding is complete (`onboardingCompletedAt`), except `AUTH_ERROR`, which the
  wizard shows inline at once.
- Every transition goes through `setConnectionStatus(tx, integrationId, next, { from, credentialVersion?,
lastSyncAt?, reason })`, a compare-and-set (2.2) that also writes `Integration.status`, `statusChangedAt`, and
  after commit publishes `integration.health.changed` for banner-relevant transitions (7.11; a cache hint only).
  `DISCONNECTED` is left only by a connect proof, and a slice's writes carry the `credential_version` it started
  with, so a slice can never turn a deliberate disconnect into `AUTH_ERROR` (5.8, 7.6). Every transition out of
  `AUTH_ERROR` clears `authErrorNotifiedAt` and `authProbeAttempts`; every transition out of `DEGRADED` clears the
  `degraded*` guards, so the next incident notifies again. Most transitions happen in the worker (slices, upkeep);
  the Postgres bus carries the hint to every dashboard's SSE stream.

### 8.2 Thresholds (`health.ts`, constants exported for tests)

| Constant                      | Value  | Meaning                                                                                                             |
| ----------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| `DEGRADED_AFTER_MS`           | 60 min | No successful sync for this long → `DEGRADED` (measured from `lastSuccessfulSyncAt`, else `onboardingCompletedAt`). |
| `DEGRADED_EMAIL_AFTER_MS`     | 6 h    | Still `DEGRADED` this long after the last success → email managers once per incident.                               |
| `SYNC_INTERVAL_MS`            | 15 min | Scheduled cadence.                                                                                                  |
| `MANUAL_SYNC_MIN_INTERVAL_MS` | 60 s   | Sync now throttle.                                                                                                  |

### 8.3 Banners

`GET /api/integrations/health` (manager, any role) → `{ banners: IntegrationHealthBanner[] }` with
`{ provider, level: "error" | "warning", title, body, action: { label, href } | null, isMock }`:

| Status                                                                                            | Level   | Title / body                                                                                                                                  | Action (OWNER/ADMIN only)                         |
| ------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `AUTH_ERROR`                                                                                      | error   | "Planday disconnected — your rota is no longer updating." Body names the reason class (access revoked, missing permission, different portal). | "Reconnect" → `reconnectHref(connection)` (below) |
| `DEGRADED`                                                                                        | warning | "Planday sync is delayed. Last successful sync <relative time>. ClockOff keeps retrying; phones keep the schedule they have."                 | "View details" → `/integrations#planday`          |
| Paused (kill switch: `PLANDAY_ENABLED=false`, a live Planday connection with onboarding complete) | warning | "Planday sync is paused by ClockOff. Phones keep the schedule they have."                                                                     | none                                              |

`reconnectHref(connection)` (`server/integrations/health.ts`, also used by the email, the notification and the
connect-link redirect) is `/integrations?planday=reconnect` once `onboardingCompletedAt` is set (the card's
reconnect panel, 10.1) and `/onboarding/planday?step=connect` before that. The banner endpoint is generic (not a
Planday route), so it still answers while `PLANDAY_ENABLED=false` and shows the paused banner instead of going
silent.

`IntegrationHealthBanner` (`apps/web/src/components/shell/integration-health-banner.tsx`) renders in
`DashboardShell` directly under the verify-email banner on every dashboard page, polling every 60 s
(`refetchInterval: 60_000`) and refetching on the realtime hint. MANAGER sees the banner without the action.

### 8.4 Emails and notifications (deduplicated)

| Event                                 | In-app notification                                                                                        | Email                                                                            | Dedupe                                                                                                                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enter `AUTH_ERROR`                    | `INTEGRATION_ERROR` to every OWNER and ADMIN ("Planday disconnected", href `reconnectHref`)                | `integrationAuthErrorEmail` to every OWNER and ADMIN, **regardless of opt-outs** | `UPDATE … SET auth_error_notified_at = now() WHERE … AND auth_error_notified_at IS NULL RETURNING`: only the winner sends; cleared on every transition out of `AUTH_ERROR` (8.1). |
| Leave `AUTH_ERROR` by an auth probe   | `INTEGRATION_RECOVERED` to OWNER and ADMIN ("Planday reconnected; your rota is updating again")            | none                                                                             | One per transition (the compare-and-set winner sends).                                                                                                                            |
| Enter `DEGRADED`                      | `INTEGRATION_DEGRADED` to OWNER and ADMIN                                                                  | none                                                                             | `degraded_notified_at` guard; cleared on recovery.                                                                                                                                |
| `DEGRADED` for 6 h                    | `INTEGRATION_DEGRADED` to every member ("still not updating")                                              | `integrationDegradedEmail` to every member (OWNER, ADMIN, MANAGER)               | `degraded_email_sent_at` guard; cleared on recovery.                                                                                                                              |
| New pending employees                 | `INTEGRATION_NEW_EMPLOYEES` to OWNER and ADMIN: "N new employees found in Planday — review"                | none                                                                             | Not created while an unread one exists for the integration.                                                                                                                       |
| Mapped employees missing from Planday | `INTEGRATION_NEW_EMPLOYEES` (same type, other copy): "N Planday employees can no longer be found — review" | none                                                                             | As above.                                                                                                                                                                         |
| New Planday department                | `INTEGRATION_DEPARTMENT_FOUND` to OWNER and ADMIN ("New Planday department: choose where it goes")         | none                                                                             | Once per department id (`catalog.departments[].notifiedAt`).                                                                                                                      |

- New `MANAGER_NOTIFICATION_TYPES` in `packages/validation/src/notifications.ts`: `INTEGRATION_DEGRADED`
  (`{ inApp: true, email: true }`), `INTEGRATION_NEW_EMPLOYEES` (`{ inApp: true, email: false }`),
  `INTEGRATION_DEPARTMENT_FOUND` (`{ inApp: true, email: false }`), `INTEGRATION_RECOVERED`
  (`{ inApp: true, email: false }`). `INTEGRATION_ERROR` already exists with email on.
- **Opt-outs (Decision D-055).** Spec §6 says "email every OWNER and ADMIN" when Planday disconnects; an
  organisation whose admins have all switched `INTEGRATION_ERROR` email off would otherwise learn of it only from
  the banner. So the auth-error email and in-app notification are transactional: sent to every OWNER and ADMIN
  whatever `notificationPreferences` says (the preferences page labels the row "always sent for a broken
  connection"). Opt-outs keep applying to `DEGRADED` and the other notifications.
- Templates in `apps/web/src/server/email/templates.ts`: `integrationAuthErrorEmail({ recipientName,
organisationName, providerName, reconnectUrl })` and `integrationDegradedEmail({ …, lastSuccessfulSyncAt })`,
  plain text plus HTML like the existing templates, links built with `buildAppLink`. No error detail beyond the
  reason class, no portal data. Sent with `sendEmailSafely` after the transaction commits.
- Notifications are written inside the transition transaction with `publish: false`, published after commit.
  Emails are sent from whichever process made the transition (normally the worker, which already sends the
  hourly digest) with `sendEmailSafely` after commit; the `…_notified_at` guards make a retry or a second worker
  harmless.

### 8.5 Compliance "Rota may be out of date"

`packages/validation/src/compliance.ts`: the compliance employee row gains `rotaMayBeOutOfDate: boolean`;
`compliance.service.ts` sets it for employees with `managedByIntegrationId` whose connection is `DEGRADED` or
`AUTH_ERROR` (one query per request for the org's unhealthy integration ids). `compliance-columns.tsx` shows an
amber "Rota may be out of date" badge with a tooltip linking to the Integrations page. The summary's
`integrationStatus` entries gain `connectionStatus`.

### 8.6 Devices

Nothing changes on devices (spec §6): phones keep enforcing the cached schedule. The server keeps serving the
last synced `Shift` rows; the Work Mode tick keeps evaluating them.

## 9. Onboarding and the Planday wizard

### 9.1 Pages

| Path                              | File                                                 | Purpose                                                              |
| --------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------- |
| `/onboarding/rota-source`         | `app/(dashboard)/onboarding/rota-source/page.tsx`    | "How do you schedule your team?" cards                               |
| `/onboarding/planday?step=<step>` | `app/(dashboard)/onboarding/planday/page.tsx`        | The nine-step wizard; `step` is a kebab-case `IntegrationWizardStep` |
| `/onboarding/planday/poster`      | `app/(dashboard)/onboarding/planday/poster/page.tsx` | Printable QR poster (company code + join instructions)               |
| `/connect/planday?token=<token>`  | `app/(dashboard)/connect/planday/page.tsx`           | Shareable connect link landing                                       |
| `/help/planday`                   | `app/(dashboard)/help/planday/page.tsx`              | Customer help article (section 14)                                   |

All sit inside `DashboardShell` (its client-side auth gate applies). `create-organisation-form.tsx` redirects to
`/onboarding/rota-source` instead of `/overview` after a successful create. `ROUTES` in
`config/navigation.ts` gains `onboardingRotaSource`, `onboardingPlanday`, `connectPlanday`, `helpPlanday`.

### 9.2 API endpoints

All under `app/api/…`, `createHandler` with `auth: "manager"` unless stated; organisation always from the
context (never from input). "W" = `integrations:write` (OWNER, ADMIN); "R" = any manager role; "O" =
`org:manage`. Schemas in `packages/validation/src/planday.ts` and `organisation.ts`.

| Method and path                                                                                | Perm            | Body / query → response                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /api/organisations/current/rota-source`                                                   | O               | `{ rotaSource, otherText? }` → `Organisation`; audit `organisation.rota_source_set`                                                                                                                                                                     |
| `GET /api/integrations/planday` (`[provider]/route.ts`)                                        | R               | → `PlandayIntegrationDetail` (card data, 10.1)                                                                                                                                                                                                          |
| `GET /api/integrations/planday/connect-methods`                                                | R               | → 5.1                                                                                                                                                                                                                                                   |
| `POST /api/integrations/planday/connect`                                                       | W               | Generic route: 404 `CONNECT_METHOD_UNAVAILABLE` for Planday (section 5)                                                                                                                                                                                 |
| `POST /api/integrations/planday/connect/oauth`                                                 | W               | `{ returnTo, allowPortalSwitch? }` → `{ authorizationUrl }`                                                                                                                                                                                             |
| `GET /api/integrations/planday/callback`                                                       | user            | query `code`, `state`, `error?` → 302                                                                                                                                                                                                                   |
| `POST /api/integrations/planday/connect/token`                                                 | W               | `{ method, appId?, refreshToken, allowPortalSwitch? }` → `{ connection: PlandayConnectionSummary, run: PlandaySyncRun \| null }`                                                                                                                        |
| `POST /api/integrations/planday/disconnect`                                                    | W               | `{ mode }` → `IntegrationResponse`                                                                                                                                                                                                                      |
| `POST /api/integrations/planday/sync`                                                          | W               | `{ retryAuth? }` → `{ run, alreadyRunning, followUpQueued }`; 409 `INTEGRATION_ONBOARDING_INCOMPLETE` before Finish                                                                                                                                     |
| `GET /api/integrations/planday/runs`                                                           | R               | `?limit≤50` → `{ runs: PlandaySyncRun[] }`                                                                                                                                                                                                              |
| `GET /api/integrations/planday/runs/:runId`                                                    | R               | → `PlandaySyncRun` (404 for another org's run)                                                                                                                                                                                                          |
| `GET` / `PATCH /api/integrations/planday/settings`                                             | R / W           | → / `PlandaySettingsPatch` → `PlandaySettings`; audit `integration.settings_updated`, mapping version +1, MANUAL run; `PATCH` 409 `INTEGRATION_ONBOARDING_INCOMPLETE` before Finish                                                                     |
| `GET /api/integrations/planday/pending-employees`                                              | R               | `?search&reason&page` → paged `PendingExternalEmployee` DTOs                                                                                                                                                                                            |
| `POST /api/integrations/planday/pending-employees/resolve`                                     | W               | `{ items: [{ id, action: "IMPORT" \| "LINK" \| "DISMISS" \| "DEACTIVATE" \| "KEEP", employeeId? }] }` → results; audit per item (`DEACTIVATE` / `KEEP` only for `MISSING_IN_PLANDAY`)                                                                   |
| `GET` / `POST /api/integrations/planday/connect-links`                                         | R / W           | → active links / `{ expiresInHours: 24 \| 72 \| 168, email? }` → `{ url, expiresAt, invited }` (URL shown once; 9.7)                                                                                                                                    |
| `DELETE /api/integrations/planday/connect-links/:linkId`                                       | W               | revoke                                                                                                                                                                                                                                                  |
| `POST /api/integrations/planday/connect-links/resolve`                                         | user            | `{ token }` → `{ redirectTo }`                                                                                                                                                                                                                          |
| `GET /api/integrations/health`                                                                 | R               | → 8.3 (static `health` segment beside `[provider]`; the provider schema rejects "health", so no clash)                                                                                                                                                  |
| `GET` / `POST /api/integrations/planday/onboarding`                                            | R / W           | → session DTO / start or resume → session DTO                                                                                                                                                                                                           |
| `POST /api/integrations/planday/onboarding/goto`                                               | W               | `{ step }` (only completed steps or the current one)                                                                                                                                                                                                    |
| `POST /api/integrations/planday/onboarding/confirm-portal`                                     | W               | `{}` → session                                                                                                                                                                                                                                          |
| `GET` / `PUT /api/integrations/planday/onboarding/locations`                                   | R / W           | → departments table / `{ departments: [{ externalId, target: "NEW_LOCATION" \| "LOCATION" \| "DEPARTMENT" \| "EXCLUDE", locationId?, departmentId?, name? }] }` → session + DIRECTORY run                                                               |
| `GET` / `PUT /api/integrations/planday/onboarding/teams`                                       | R / W           | → groups table / `{ skip?: true, groups: [{ externalId, target: "NEW_TEAM" \| "TEAM" \| "IGNORE", teamId? }] }`                                                                                                                                         |
| `GET` / `PUT /api/integrations/planday/onboarding/employees`                                   | R / W           | `?search&flag&page` → rows + counts / `{ selection: { mode: "ALL_EXCEPT" \| "ONLY", externalIds }, resolutions: [{ externalId, action: "LINK" \| "CREATE" \| "EXCLUDE", employeeId? }], autoIncludeNewEmployees, importEmails }` → IMPORT_EMPLOYEES run |
| `GET` / `PUT /api/integrations/planday/onboarding/shift-preview`                               | R / W           | → 9.5 step 6 / `{ replaceConflictingShiftIds: uuid[], sampleTimesConfirmed: boolean }`                                                                                                                                                                  |
| `POST /api/integrations/planday/onboarding/shift-preview/refresh`                              | W               | new DIRECTORY run                                                                                                                                                                                                                                       |
| `GET` / `PUT /api/integrations/planday/onboarding/policies`                                    | R / W           | → options / `{ work: { starter: true } \| { policyId }, break: { starter: true } \| { breakPolicyId }, teamPolicies: [{ teamId, policyId }] }`                                                                                                          |
| `PUT /api/integrations/planday/onboarding/activation`                                          | W               | `{ activationMode }` (`CLOCK_EVENT` only with the flag)                                                                                                                                                                                                 |
| `POST /api/integrations/planday/onboarding/finish`                                             | W               | `{}` → `{ session, run, summary }`                                                                                                                                                                                                                      |
| `GET /api/integrations/planday/onboarding/invites`                                             | R               | → join code, copyable message, duplicate-name groups with invite status                                                                                                                                                                                 |
| Dev only: `GET` / `POST /api/dev/mock-planday/authorize`, `POST /api/dev/mock-planday/control` | public, guarded | section 12.6                                                                                                                                                                                                                                            |

Every endpoint above that starts a run (connect, step 3, step 5, shift-preview refresh, Finish, sync, settings)
inserts the queue row in its own transaction and announces it after commit (7.3); none executes sync work. While
`PLANDAY_ENABLED=false`, `requirePlanday()` answers 404 `NOT_FOUND` on every Planday route; the generic
`GET /api/integrations` keeps listing Planday as Coming soon, with `paused: true` on the item when the organisation
has a live Planday connection (the card then shows "Paused", 10.1), and `GET /api/integrations/health` returns the
paused banner (8.3).

**Ids in request bodies (Decision D-056).** No body carries an organisation id, but many carry ids of the
organisation's own records: `locationId` / `departmentId` (step 3, settings), `teamId` (step 4, settings,
`teamPolicies`), `employeeId` (step 5 `resolutions`, pending `LINK`), `policyId` / `breakPolicyId` (step 7),
`replaceConflictingShiftIds` (step 6). Each is checked with `organisation_id = ctx.organisation.id` (and not
deleted) when the request is saved, in one query per kind; an unknown or foreign id answers 404 `NOT_FOUND` for
the whole request and writes nothing. The worker re-checks: `linkExternalEmployee`, `createPolicyAssignment`,
`cancelReplacedShift` and every `*.integration.ts` writer filter by the run's `organisationId` as well as the id,
so a stale or tampered session state can never write across organisations. `tenantCases/planday.ts` and
`onboardingWizard.test.ts` send another organisation's employee, team, policy, shift and location ids in each of
these bodies and assert 404 and no write.

Every manager-facing route above is registered in `packages/validation/src/openapi/routes.ts` and the
`REQUIRED_ENDPOINTS` list of `openapi.test.ts`, and `docs/openapi.json` is regenerated (`pnpm openapi`). Callback
and dev routes are listed under "Not in the document" in `docs/API.md`; there are no job routes. A tenant-isolation case file
`apps/web/test/integration/tenantCases/planday.ts` covers every org-scoped GET and mutation.

### 9.3 `IntegrationOnboardingSession`

- One `ACTIVE` session per org and provider. `POST …/onboarding` creates the `Integration` row (lazily, as
  today), the `IntegrationMappingConfig` row and the session, or returns the active one. If the integration is
  already `CONNECTED` and onboarding not completed, it resumes at the first incomplete step; if onboarding is
  complete, it answers `CONFLICT` with `details.href = reconnectHref(connection)` when the connection is
  `AUTH_ERROR` or `DISCONNECTED` (the card's reconnect panel, 10.1), else `/integrations`. The wizard page follows
  that link instead of showing a dead end.
- `state` (`plandayOnboardingStateSchema`, every key optional, unknown keys rejected):

  ```ts
  {
    connect?:      { method: IntegrationAuthMethod; connectedAt: string };
    locations?:    { savedAt: string; departments: DepartmentChoice[] };
    teams?:        { savedAt: string; skipped: boolean; groups: GroupChoice[] };
    employees?:    { savedAt: string; selection: Selection; resolutions: Resolution[]; autoIncludeNewEmployees: boolean; importEmails: boolean };
    /** Written by the IMPORT_EMPLOYEES apply sink: what this session imported, for release (below). */
    employeesImport?: { createdIds: string[]; linkedIds: string[] };
    shiftPreview?: { savedAt: string; replaceConflictingShiftIds: string[]; sampleTimesConfirmed: boolean };
    policies?:     { savedAt: string; workPolicyId: string; breakPolicyId: string; createdStarterWork: boolean; createdStarterBreak: boolean; teamPolicies: Array<{ teamId: string; policyId: string }> };
    activation?:   { savedAt: string; mode: ActivationMode };
    finish?:       { finishedAt: string; runId: string };
  }
  ```

- Resumability: every step persists on Continue; `currentStep` and `completedSteps` drive navigation; runs keep
  going while the browser is closed; reopening `/onboarding/planday` lands on `currentStep`. Going back to a
  completed step and saving again re-applies that step (idempotent through `ExternalEntityMap`) and invalidates
  later steps that depend on it (locations → employees and preview; employees → preview).
- **Releasing session imports.** Employees are imported at step 5, before Finish, with `managedByIntegrationId`
  set. `releaseOnboardingImports(sessionId, employeeIds?)` (`onboarding.service.ts`) undoes that for employees no
  SYNC has touched yet: for `linkedIds` it deletes the map row and clears `managedByIntegrationId` (the
  pre-existing employee is left exactly as it is); for `createdIds` it deletes the map row and soft-deletes the
  employee (`deletedAt`) when it is still `NOT_INVITED` with no device, else only unmanages it. It runs when a
  re-saved step 3 drops a department (for the imported employees with no included department left, then step 5
  re-opens), when the session is abandoned (7.9 housekeeping) and on a disconnect before Finish (5.8), so no
  employee stays locked as "Managed in Planday" without ever being synced.
- Session DTO: `{ id, status, currentStep, completedSteps, isMock, connection: PlandayConnectionSummary | null,
runs: { structure, directory, importEmployees, final }: PlandaySyncRun | null, stepSummaries }`.

### 9.4 Rota-source page ("How do you schedule your team?")

Cards (`components/onboarding/rota-source-cards.tsx`); choosing one calls `PUT …/rota-source`, then:

| Card                                                                             | Stored `rotaSource`                     | Next                                                                                                                                                |
| -------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Planday, while `providerAvailability("PLANDAY")` is `AVAILABLE`                  | `PLANDAY`                               | `/onboarding/planday` (session started)                                                                                                             |
| Planday, while it is `COMING_SOON` (stages 6 and 7 deploy dark; the kill switch) | `PLANDAY`                               | Shown like the other coming-soon cards: "Notify me when it's ready", then the CSV path, so a Planday customer never lands on routes that answer 404 |
| Deputy, 7shifts, When I Work, Rotaready, Homebase ("Coming soon")                | the provider                            | "Notify me when it's ready" (existing `POST /api/integrations/:provider/notify-me`, records interest and audit), then the CSV path                  |
| Spreadsheet or another system                                                    | `CSV`                                   | `/schedule/import` with the template download (`docs/templates/shift-import-template.csv`)                                                          |
| "I'll add shifts in ClockOff"                                                    | `MANUAL`                                | `/overview`                                                                                                                                         |
| Something else                                                                   | `OTHER` + `rotaSourceOtherText` (1–200) | choose CSV or manual                                                                                                                                |

Existing orgs with `rotaSource = null` see a dismissible "How do you schedule your team?" card on the overview
(OWNER/ADMIN), linking to the page. The choice can be changed later from Settings → Organisation.

### 9.5 The nine steps

| Step               | Shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Actions and validation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Resumability / data                                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 Connect          | What ClockOff reads (portal name and time zone; departments; employee groups; employees' names, the email address on their Planday profile, which may be a personal address (D-042), departments and groups; published shifts' times, department and employee; punch-clock times only in clock-in mode). Prominently **what it never reads**: pay, salaries and payroll; home addresses; dates of birth; bank details; NI / SSN; phone numbers and other personal contact details. The recommended method (A, else B, else C) and "Other ways to connect" (always C, plus B when available). Mock badge in mock mode. "Not the Planday admin? Send a connect link" (OWNER/ADMIN).               | A: button → OAuth start. B/C: paste fields (5.3, 5.4), Connect → `connect/token`; inline typed errors ("Planday refused this token", "Missing permission: shift:read", "This token belongs to a different portal"). Never echoes the pasted value; success shows "Token ending ••••4f2a".                                                                                                                                                                                                                                                                           | `state.connect`; a refresh after a successful connect lands on step 2.                                                                                 |
| 2 Confirm portal   | Portal name, time zone (with a note when it differs from the org's), child-portal note when `portals[]` is non-empty ("ClockOff syncs only <name>"), STRUCTURE run progress.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Continue enabled when the STRUCTURE run `SUCCEEDED`, or `PARTIAL` with its warnings listed, and the time zone is IANA. "Wrong portal? Disconnect and try again" (one click, `KEEP_RECORDS`, back to step 1; the next connect is sent with `allowPortalSwitch: true`, 5.7). "Retry" (re-queues `STRUCTURE`) when the run failed.                                                                                                                                                                                                                                     | Run id on the session.                                                                                                                                 |
| 3 Locations        | Department table: name, number, employee count, suggested target (6.3), target select (new location / existing location / ClockOff department / exclude), editable new-location name; the "Not in any department" row when present (6.3).                                                                                                                                                                                                                                                                                                                                                                                                                                                       | At least one included department (the "none" row counts; a portal with no departments and no people outside them shows "This Planday portal has no departments or employees ClockOff can read. Contact support."); existing ids must belong to the org (D-056); names 1–100 chars, unique among new locations. Save applies locations in the request (DB only), releases imports of departments no longer included (9.3) and enqueues the DIRECTORY run for the worker (7.3).                                                                                       | `state.locations`; mapping config updated.                                                                                                             |
| 4 Teams (optional) | Employee-group table with counts of in-scope employees; target select (new team / existing team / ignore).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | "Skip" or Save (applies teams in the request; team ids checked against the org, D-056).                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `state.teams`. The DIRECTORY run keeps going meanwhile; a save during it bumps `mappingVersion`, so it gets a DIRECTORY follow-up, never a SYNC (7.2). |
| 5 Employees        | Waits for the DIRECTORY run (including `MATCH_EMPLOYEES`). Searchable, filterable table (all / new / matched / possible match / ambiguous / missing email / selected), checkbox per row, select-all (on the current filter), counts ("38 selected of 41; 3 without email; 1 ambiguous"), flags: matched (shows the ClockOff employee), possible match (a raw CSV id without corroboration, 6.5: "Confirm" links, default Create), ambiguous (candidate picker), missing email (info). Toggles: "Add new Planday employees automatically" (default on) and "Import email addresses" (default per D-042, with the note that Planday's address may be personal).                                   | Every selected ambiguous row resolved; selection within the plan's employee limit (`assertEmployeeCapacity`, message names the limit); at least one selected; `LINK` targets belong to the org (D-056). Save → IMPORT_EMPLOYEES run with progress (or `FOLLOW_UP_QUEUED` behind an active run, 7.3); Continue when it `SUCCEEDED`, or `PARTIAL` with warnings listed; Retry when it failed.                                                                                                                                                                         | `state.employees`, `state.employeesImport`; pending rows deleted as they resolve.                                                                      |
| 6 Shift preview    | Next 14 days in the org time zone: per-day counts, expandable day lists (employee, location, local times, "Overnight" badge, DST note), conflicts with existing ClockOff shifts (manual or CSV) for the same employee with a "Replace with Planday's" checkbox each (default ticked; in-progress conflicts are listed without a checkbox: they are never replaced), notes: "N draft shifts are not synced until published in Planday", "N open shifts are ignored", and, only with `respectHiddenDays`, "N shifts on hidden days are skipped". "Check a few times": three sample shifts with their Planday local times, and the question "Do these match Planday?". Preview age with "Refresh". | Save stores the replacement choice (ids checked against the org) and requires the sample times confirmed; "No, they don't match" blocks Continue with "ClockOff could not read Planday's shift times correctly. Contact support." and reports it (log line with the portal id only). A DIRECTORY run that failed with `TIME_ENCODING_MISMATCH` (4.8) shows the same message.                                                                                                                                                                                        | `state.shiftPreview`; preview rows from the DIRECTORY run filtered to imported employees.                                                              |
| 7 Policies         | Default Work Policy and Break Rules. One click "Standard Staff" (Social Media, Games, Entertainment; employee app selection required; scheduled; 10-minute warning) and "Standard Break" (breaks on, 2 × 15 minutes, 30 minutes total, restrictions relaxed: `RELAX_ALL`). Existing policies selectable. Optional per-team policy for each mapped team.                                                                                                                                                                                                                                                                                                                                         | Both defaults set. Starters created through `createPolicy` + `publishPolicy` + `setDefaultPolicy` and `createBreakPolicy` + `setDefaultBreakPolicy` with the manager's context (audited as usual); team policies through `createPolicyAssignment` (`scope TEAM`). Idempotent: a starter created earlier in the session is reused.                                                                                                                                                                                                                                   | `state.policies`.                                                                                                                                      |
| 8 Activation mode  | Scheduled (default, selected) and "Clock-in (Beta)" disabled unless `PLANDAY_CLOCK_MODE_ENABLED`, with the latency explanation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Sets `Integration.activationMode`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `state.activation`.                                                                                                                                    |
| 9 Finish           | Summary (locations, teams, employees with and without email, shifts imported once the final run is done, policies, activation mode), final run progress. Invite staff: company join code (`getJoinCodes`), copyable invite message (code + App Store link), QR poster link, and for each group of employees sharing a full name a "Create personal invite codes" action (`createEmployeeInvite`) with the codes listed. "Go to dashboard".                                                                                                                                                                                                                                                      | Finish (from step 8's Continue), in one transaction: an active wizard run (a preview refresh) is marked `FAILED` `SUPERSEDED` and the pending slot cleared (`integration.run.cancelled` after commit); set `onboardingCompletedAt`; session `COMPLETED`; purge preview rows; enqueue `SYNC` (trigger `INITIAL`) with `replaceShiftIds` = the ticked conflicts (re-checked against the org; the worker replaces them as their Planday shifts are created, 6.6 Overlaps; nothing is cancelled here); `nextSyncAt` after it; audit `integration.onboarding_completed`. | Reopening `/onboarding/planday` after completion shows the Finish page in read-only form with a link to Integrations.                                  |

QR poster: add `qrcode` (MIT) and `@types/qrcode` to `apps/web`; the poster page renders an SVG QR of the App
Store link the invite message already uses (the exported `appStoreUrl()` in
`server/employeeInvites/employeeInvites.service.ts`: `NEXT_PUBLIC_APP_STORE_URL`, else `APP_URL`), with the company
join code in large type and the three join steps, printable (`@media print`). There is no web `/join` route
(checked 2026-10-08) and none is added: employees join in the iOS app with the code. The step 9 copyable message
reuses `buildInviteInstructions`.

### 9.6 Checklist changes

- `OnboardingSignals` (`server/organisations/repository.ts`) gains `rotaSource` and `providerConnected` (a
  Planday connection that is not `DISCONNECTED` and whose mapping config has `onboardingCompletedAt`).
- `computeOnboardingSteps`: `addEmployees = employees > 0 || providerConnected`,
  `addSchedules = shifts > 0 || providerConnected`.
- Copy and links adapt (`onboardingStepPresentation(key, { rotaSource, providerConnected, plandayAvailable })` in
  `server/organisations/service.ts`, with `plandayAvailable = providerAvailability("PLANDAY") === "AVAILABLE"`;
  `OnboardingResponse` gains `rotaSource`):

  | `rotaSource`                                      | `addEmployees`                                          | `addSchedules`                                                             |
  | ------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- |
  | `PLANDAY`, Planday available                      | "Import employees from Planday" → `/onboarding/planday` | "Sync shifts from Planday" → `/integrations`                               |
  | `PLANDAY`, Coming soon (dark launch, kill switch) | "Add employees"                                         | "Import your Planday rota as a CSV" → `/schedule/import`, with "Notify me" |
  | `CSV`, `OTHER`                                    | "Add employees"                                         | "Import your rota from a spreadsheet" → `/schedule/import`                 |
  | Coming-soon provider                              | "Add employees"                                         | "Import your <Deputy> rota as a CSV" → `/schedule/import`                  |
  | `MANUAL`, null                                    | unchanged                                               | unchanged                                                                  |

  `organisations.test.ts` covers both Planday rows.

### 9.7 Shareable connect link

The link's main recipient is the customer's Planday administrator, who is often not yet a member of the ClockOff
organisation. So "Send a connect link" asks for the recipient's email:

- Create (W) `{ expiresInHours, email? }`: 32 random bytes base64url token; row stores `sha256(token)`,
  `expiresAt` (24 h, 72 h default or 7 days), creator. Audit `integration.connect_link_created`. At most 5 active
  links per org.
  - `email` of an existing `OWNER` / `ADMIN` member, or no email: the response returns
    `${APP_URL}/connect/planday?token=<token>` once (copy button), `invited: false`.
  - `email` of anyone else: `inviteMember(ctx, { email, role: "ADMIN", next: "/connect/planday?token=<token>" })`
    (the existing manager invite, `server/organisations/members.ts`, gains an optional allow-listed `next`; its
    rules apply, so only someone allowed to grant ADMIN can do this) and the link row stores `managerInviteId`.
    The invite email carries the accept link with `next`; the response returns `invited: true` and the same URL.
    An existing `MANAGER` member gets `CONFLICT` "Make them an Admin first" (no silent promotion).
- `accept-invite-panel.tsx` honours a `next` that `safeConnectNext()` accepts (only `/connect/planday?token=…`)
  after a successful acceptance, instead of `/overview`; `getPostAuthRedirect` (`config/navigation.ts`) lets a
  user with no organisation continue to such a `next`, as it already does for `/accept-invite`, instead of sending
  them to create-organisation. A brand-new recipient therefore registers, accepts the invite, joins the right
  organisation as ADMIN and lands on the link, never on "How do you schedule your team?" for a new, empty
  organisation.
- Landing page posts the token to `…/connect-links/resolve` (`auth: "user"`, CSRF as usual, rate limit 20 per
  hour per IP). The server finds the row by hash; it must be unexpired and unrevoked; the signed-in user must be
  `OWNER` or `ADMIN` of the link's organisation. Otherwise it answers the same generic `NOT_FOUND`, and the page
  shows "This link is not for this account. Ask the person who sent it to invite you as an Admin of their
  organisation." with "Create my own organisation instead" as a secondary link (no organisation data revealed).
  On success: switch the org cookie to that organisation (the existing switch-organisation logic),
  `useCount + 1`, `lastUsedAt`, audit `integration.connect_link_used`, `{ redirectTo }` =
  `/onboarding/planday?step=connect` before Finish, `reconnectHref(connection)` after it (8.3).
- Not an auth bypass: a signed-out visitor goes through `/login?next=…` first; the link grants nothing the user
  does not already have, and membership comes only from the ordinary invite flow.
- `connectLinks.test.ts`: link with an invite for a new email → register → accept → resolve → wizard in the
  right organisation; a signed-in non-member and a `MANAGER` get `NOT_FOUND`; expired and revoked links fail.

## 10. Integrations page

Files: `components/integrations/planday/planday-card.tsx`, `planday-settings-drawer.tsx`,
`planday-sync-history.tsx`, `planday-pending-queue.tsx`, `planday-disconnect-dialog.tsx`,
`planday-connect-links.tsx`, `use-planday.ts` (React Query hooks), `planday-view-model.ts` (+ test). The
existing `IntegrationsList` renders `PlandayCard` for `PLANDAY` when available and the existing card for the
other five. The page description stops saying "Providers are coming soon".

### 10.1 Card (`GET /api/integrations/planday` → `PlandayIntegrationDetail`)

| Element                                         | Source                                                                                                                                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status badge                                    | `connectionStatus` (Connecting, Connected, Syncing, Delayed = DEGRADED, Disconnected from Planday = AUTH_ERROR, Disconnected)                                                                                      |
| "Mock Planday" badge                            | `isMock`                                                                                                                                                                                                           |
| Portal name                                     | `externalPortalName`                                                                                                                                                                                               |
| Auth method                                     | "Connected with Planday sign-in" (A), "ClockOff app added in Planday" (B), "Your own Planday API app" (C)                                                                                                          |
| Last successful sync                            | `lastSuccessfulSyncAt` (relative + absolute tooltip)                                                                                                                                                               |
| Next scheduled sync                             | `nextSyncAt`                                                                                                                                                                                                       |
| Last sync summary                               | last finished run: counts per entity, excluded counts, warnings count with an expandable list                                                                                                                      |
| Sync now                                        | W only; disabled while a SYNC run is active ("Waiting to start" while queued) or within 60 s of the last manual run (countdown); during a CLOCK run it queues a follow-up ("Starts after the current clock check") |
| Settings, History, Pending (N), Disconnect      | W for actions; MANAGER sees read-only views                                                                                                                                                                        |
| Not connected / onboarding incomplete           | "Set up Planday" → `/onboarding/planday`                                                                                                                                                                           |
| `AUTH_ERROR` or `DISCONNECTED` after onboarding | "Reconnect Planday" (W) opens the reconnect panel; for `AUTH_ERROR` also "Try again" (`POST …/sync { retryAuth: true }`, for a transient Planday error)                                                            |
| Kill switch (`paused` on the list item)         | "Paused" badge and "Planday sync is paused by ClockOff" instead of "Coming soon"; no actions                                                                                                                       |

**Reconnect panel** (`components/integrations/planday/planday-reconnect-panel.tsx`, stage 7A), opened from the
card and by `/integrations?planday=reconnect` (the target of the banner, the auth-error email, the notification and
the connect link once onboarding is complete, 8.3). It reuses the wizard's connect form
(`components/onboarding/planday/connect-form.tsx`, built in stage 6B with a `returnTo` prop): method A with
`returnTo: "SETTINGS"` (the callback lands on `/integrations?planday=connected`), the B and C paste forms, the
same typed errors, and the portal check of 5.7 ("This token belongs to a different portal"). From `DISCONNECTED`
it also offers "Use a different portal", which confirms the consequences (mappings reset, the wizard starts again
at step 2) and connects with `allowPortalSwitch: true`. On success it shows the `RECOVERY` run's progress; the
banner clears when the run's `PORTAL_CHECK` passes. The e2e (13.4 step 10) reconnects through it.

### 10.2 Settings drawer

Department mappings (same control as wizard step 3, including newly found departments and the "Not in any
department" row), team mappings, included departments, auto-include toggle, "Import email addresses" toggle
(D-042), sync window (7, 14, 28, 42 or 56 days), activation mode (Clock-in only with the flag), "Skip shifts on
days hidden in Planday" (off by default, D-040). Save → `PATCH …/settings` (409 before Finish) → validates every id
against the organisation (D-056), applies location/team changes in the request, increments `mappingVersion`,
audits the before/after diff, enqueues a `MANUAL` `SYNC` run (or a follow-up behind an active run, 7.3), and shows
its progress. Records whose resolved targets did not change are `REHASH_ONLY` or `UNCHANGED` (6.2), so a settings
save never bumps every shift.

### 10.3 History

Last 20 runs: started, trigger, kind, status, duration, counts, error code and sanitised message; a row expands to
its warnings (code, message, Planday record id).

### 10.4 Pending queue

Rows from `pending-employees` with reason badges (New, Possible match, Ambiguous name, Plan limit, Missing in
Planday). Actions: Import (creates a `NOT_INVITED` employee), Link to an existing employee (candidate picker;
required for ambiguous rows, pre-filled for possible matches), Dismiss (adds the id to `excludedEmployeeIds`). A
"Missing in Planday" row offers Deactivate (the ordinary `deactivateEmployee` with the manager's context: devices
revoked, audited) and Keep (`reviewDismissedAt`; no new review until Planday returns the person and loses them
again). Bulk select. The overview shows "N new employees found in Planday — review" and "N Planday employees can no
longer be found — review" (OWNER/ADMIN) linking here.

### 10.5 Disconnect dialog

Two options: "Keep synced employees, locations and shifts in ClockOff (they become editable)" (`KEEP_RECORDS`,
default) and "Cancel all future Planday shifts (employees are kept)" (`CANCEL_FUTURE_SHIFTS`). States that
ClockOff also revokes its access at Planday where Planday allows it, and that phones keep the shifts they have
until the next sync. Typed confirmation of the portal name. Audit and activity per 5.8.

### 10.6 "Managed in Planday" across the dashboard

- Employees (`employee-form-sheet.tsx`, `employee-overview-tab.tsx`, `employee-columns.tsx`): name, email,
  external id and primary location read-only with a "Managed in Planday" lock icon and tooltip; a "Planday"
  source badge in the table.
- Schedule (`shift-drawer.tsx`, `shift-chip.tsx`): Planday shifts show a "Planday" badge, every field read-only
  and "Edit this shift in Planday"; Duplicate allowed; manual shifts show a "ClockOff" badge.
- Locations and teams (`locations-table.tsx`, `location-form-sheet.tsx`, `teams-table.tsx`,
  `team-form-sheet.tsx`): managed names read-only, delete hidden.
- `lib/errorMessages.ts`: copy for `INTEGRATION_MANAGED` and the other new codes.
- DTOs: `Employee`, `Shift`, `Location`, `Team` gain `managedBy: { provider: "PLANDAY"; integrationId: uuid } | null`;
  `Employee`, `Location`, `Team` gain `source`.

## 11. Security checklist (spec §10)

| Requirement                                                                  | Mechanism                                                                                                                                                                                                                                                                   | Test                                                                    |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Organisation-scoped via manager context                                      | Every service takes `ManagerContext`; every query filters `organisationId = ctx.organisation.id`; runs, pending rows, links and sessions loaded by `(id, organisationId)`; 404 for other orgs.                                                                              | `tenantCases/planday.ts`, `tenantIsolation.test.ts`                     |
| Never trust org id from client or unsigned state                             | No endpoint accepts an organisation id. OAuth callback and connect links take the org from the signed, single-use server-side row, then re-check membership and role.                                                                                                       | `oauthState.test.ts`, `connectLinks.test.ts`                            |
| OWNER/ADMIN for connect, disconnect, settings, links; MANAGER can view       | `integrations:write` (OWNER, ADMIN) on every mutation; GETs need any role. Callback and link resolution check the role explicitly.                                                                                                                                          | `permissions` cases in `connectMethods.test.ts`                         |
| Secrets encrypted                                                            | AES-256-GCM with per-column AAD (4.3.1); access token cached encrypted; `id_token` discarded; PKCE verifier encrypted.                                                                                                                                                      | `crypto.test.ts`, `connectMethods.test.ts`                              |
| Pasted credentials never echoed                                              | Responses carry `credentialHint` only ("ending ••••4f2a"); request bodies never logged (`createHandler` logs no bodies); redact keys (4.9).                                                                                                                                 | `connectMethods.test.ts` (response scan), log capture                   |
| Exact redirect URI                                                           | Built from `APP_URL` once; sent identically in authorize and exchange; the mock rejects any other value.                                                                                                                                                                    | `oauthState.test.ts`                                                    |
| State single-use, ≤ 10 minutes, bound to org + user                          | HMAC over nonce, org, user, expiry; hashed row; atomic consume; user and role re-checked.                                                                                                                                                                                   | `oauthState.test.ts` (tamper, expiry, replay, wrong user, demoted user) |
| Rate-limit credential paste                                                  | Route `RateLimitRule` (per process) plus a database count of failed connects per org per hour (holds across restarts and processes).                                                                                                                                        | `connectMethods.test.ts`                                                |
| Audit every connect / reconnect / disconnect / mapping / sync-setting change | Audit actions in appendix B, written in the same transaction as the change; no secrets in `before`/`after`.                                                                                                                                                                 | `audit` assertions in each suite                                        |
| Least privilege at Planday                                                   | Read scopes only; method C instructions name them; never call outside notes §9 (mock flags any other path).                                                                                                                                                                 | mock `unexpectedRequests` assertion in every suite                      |
| Data minimisation                                                            | Allow-list parsing and mapping; staging purged; sentinel scan.                                                                                                                                                                                                              | `dataMinimisation.test.ts`                                              |
| Mock cannot run in production                                                | `parseEnv` refuses, factory throws, dev routes 404, `isMock` connections refused in live mode.                                                                                                                                                                              | `env.test.ts`, `mockGuard.test.ts`                                      |
| No job endpoints; web never runs syncs                                       | Runs are queue rows the worker claims; no HTTP route executes or triggers a job (the `auth: "cron"` mode and `CRON_SECRET` no longer exist); `processBoundaries.test.ts` fails if web code calls `runSyncSlice`, `runScheduledIntegrationSyncs` or `runIntegrationsUpkeep`. | `deploy/processBoundaries.test.ts`, `runQueue.test.ts`                  |
| Open redirects                                                               | `returnTo` is an enum mapped to fixed paths; error redirects carry only error codes; an invite's `next` passes `safeConnectNext()` (only `/connect/planday?token=…`).                                                                                                       | `oauthState.test.ts`, `connectLinks.test.ts`                            |
| Ids inside request bodies belong to the organisation (D-056)                 | Every client-supplied uuid (location, department, team, employee, policy, break policy, shift) is checked with `organisation_id = ctx.organisation.id` when saved; foreign or unknown → 404, nothing written; worker writers filter by the run's `organisationId` too.      | `tenantCases/planday.ts` (body-id cases), `onboardingWizard.test.ts`    |
| No unverified OAuth codes                                                    | The generic `POST /api/integrations/:provider/connect` answers 404 for Planday; only `consumeOAuthState` can produce the `VerifiedAuthorizationCode` the provider accepts (3.3, 5).                                                                                         | `connectMethods.test.ts`, `planday/provider.test.ts`                    |
| One request stream per portal across organisations                           | One live, non-mock connection per portal (partial unique index, D-054); a second organisation gets `INTEGRATION_PORTAL_IN_USE`.                                                                                                                                             | `connectMethods.test.ts`                                                |

## 12. Mock Planday

### 12.1 Approach

An in-process fake server, `createMockPlanday(options)` in `packages/integrations/src/planday/mock/server.ts`,
returns `{ fetch, state, controls, requestLog, unexpectedRequests }`. Its `fetch` has the `fetch` signature and
answers requests to `https://openapi.planday.com` and `https://id.planday.com` from in-memory state; any other
host throws. No MSW dependency (Decision D-037): the injected fetch exercises the real URLs, query strings,
headers and paging of the client, works the same in Vitest and in `next dev`, and keeps the dependency list
unchanged.

- Tests: `setPlandayTransportForTesting(createMockPlanday({ … }))` (in `transport.ts`), in process.
- Local development and Playwright (`PLANDAY_MODE=mock`): web and the worker are separate processes and must see
  the same portal, so the mock also runs as a small HTTP server. `startMockPlandayHttpServer({ port, fixture })`
  (`mock/httpServer.ts`, `node:http`) serves the same handler under `/openapi/*` and `/id/*`, plus `POST /__control`
  (the 12.4 controls) and `GET /__health`; `apps/web/scripts/mock-planday.mts` (`pnpm --filter @clockoff/web
mock:planday`) starts it on `PLANDAY_MOCK_PORT` (4010) with `buildPlandayFixture({ anchor: now })`. Both
  processes' `getPlandayTransport()` rewrite the two Planday hosts to `PLANDAY_MOCK_URL` (4.1), and the dev
  routes (12.6) forward to `/__control`, so a shift edited through the control route is what the worker's next run
  reads.
- The mock is written from the notes (raw Planday JSON, PII fields included), not from ClockOff's schemas, so a
  schema mistake is caught rather than mirrored.

### 12.2 Endpoints implemented (exactly those the client calls)

`POST /connect/token` (both grants, `client_id` must own the token, PKCE checked when a challenge was sent),
`POST /connect/revocation`, `GET /connect/authorize` (only reached through the dev route), `GET
/portal/v1.0/info`, `GET /hr/v1.0/departments`, `GET /hr/v1.0/employeegroups`, `GET /hr/v1.0/employees`, `GET
/hr/v1.0/employees/deactivated`, `GET /hr/v1.0/employees/{employeeId}` (by-id shape incl. `gender`, `custom_*`,
`isDeactivated`; 400 for removed), `GET /scheduling/v1.0/shifts` (`from`/`to` inclusive on `date`, `limit`
1–5000, `offset`), `GET /scheduling/v1.0/shifts/{shiftId}` (404 `ProblemDetails`), `GET
/scheduling/v1.0/shifts/deleted`, `GET /scheduling/v1.0/scheduleDay`, `GET /punchclock/v1.0/punchclockshifts`,
`GET /punchclock/v1.0/punchclockshifts/{id}/breaks`. Each checks `Authorization: Bearer` (valid, unexpired,
issued to the `X-ClientId` app), the scope of that endpoint (403 when the app lacks it), the documented `limit`
range, and answers `{ data, paging: { offset, limit, total } }` (or `paging: null` under `setPagingNull`) with
`x-ratelimit-*` headers. Any other path → 404 and an entry in `unexpectedRequests`; forbidden query parameters
(`special`, `searchQuery`, `includeSecurityGroups`) are also recorded there. Every suite asserts
`unexpectedRequests` is empty.

### 12.3 Fixture (`fixture.ts`, spec §11 exactly)

`FROZEN_NOW = 2026-10-21T10:30:00Z` (Wednesday, 11:30 BST). `buildPlandayFixture({ anchor })` lays out four weeks
from the Monday of `anchor`'s week in Europe/London; tests use `anchor = FROZEN_NOW` (weeks of 19 Oct, 26 Oct,
2 Nov, 9 Nov 2026).

- **Portal** `id 4100001`, `name "Mock Bistro Group"`, `companyName "Mock Bistro Group Ltd"`, `country "GB"`,
  `timeZone "Europe/London"`, `portals []`. A second portal `4100002` "Mock Cafe Co" exists for tenant-isolation
  and portal-switch tests, with overlapping employee and shift ids. A third portal `4100003` "Mock Kiosk" has **no
  departments** (three employees with empty `departments[]`, their shifts with `departmentId: null`) for the
  "Not in any department" path (6.3). Neither extra portal changes the spec §11 counts of the main portal.
- **Departments (3)**: `101 Bar`, `102 Kitchen`, `103 Head Office` (the one tests and the e2e exclude).
- **Employee groups (4)**: `201 Bartenders`, `202 Chefs`, `203 Floor Staff`, `204 Supervisors`.
- **Employees (12)**:

  | Id   | Name          | Departments (primary first) | Groups   | Notes                                                                                                     |
  | ---- | ------------- | --------------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
  | 1001 | Aisha Khan    | Bar                         | 201      | In-progress shift at `FROZEN_NOW`                                                                         |
  | 1002 | Ben Carter    | Bar                         | 201, 204 | Overnight Friday shifts; the DST-spanning shift                                                           |
  | 1003 | Chloe Davies  | Kitchen                     | 202      | Has the draft shift                                                                                       |
  | 1004 | Daniel Evans  | Kitchen                     | 202      | **No email**                                                                                              |
  | 1005 | Alex Morgan   | Bar                         | 203      | **Shares a name** with 1006                                                                               |
  | 1006 | Alex Morgan   | Kitchen                     | 203      | **Shares a name** with 1005 (different email)                                                             |
  | 1007 | Priya Patel   | Bar, Kitchen                | 204      | **Exists in ClockOff from a CSV import** (`fixtureCsvEmployees`: `externalEmployeeId "1007"`, same email) |
  | 1008 | Tom Harris    | Kitchen                     | 202      |                                                                                                           |
  | 1009 | Grace Lee     | Bar                         | 203      |                                                                                                           |
  | 1010 | Omar Said     | Head Office                 | 204      | Only in the excluded department                                                                           |
  | 1011 | Hannah Wright | Bar                         | 203      | **Deactivated** (only in `/employees/deactivated`)                                                        |
  | 1012 | Leo Turner    | Kitchen                     | 203      |                                                                                                           |

  Every raw employee carries the notes §9.2 strip-set fields filled with sentinels (`"SENTINEL-PII-<field>-<id>"`
  for strings, e.g. `street1`, `ssn`, `salaryIdentifier`, `userName` as `sentinel-<id>@pii.invalid`, phones as
  `+4470090<id>`, `birthDate "1901-02-03T00:00:00Z"`, `custom_1 { name: "Shoe size", value: "SENTINEL-PII-CUSTOM-<id>" }`,
  `deactivationReason "SENTINEL-PII-REASON-1011"`). Shifts carry `comment: "SENTINEL-PII-COMMENT-<id>"`.

  ClockOff-side fixtures for the matching tests (created by the tests, not by the mock, so the e2e's fresh
  organisation is unaffected): `fixtureCsvEmployees` (Priya Patel, raw `externalEmployeeId "1007"`, same email:
  corroborated raw-id match), `fixtureCsvCollision` (Sam Jones, raw `externalEmployeeId "1008"`, different name and
  email: must never link to Tom Harris), `fixtureNamesake` (a ClockOff "Alex Morgan" with no email or external id:
  must never be linked to 1005 or 1006, also with `capPageSize(1)` so the namesakes arrive on different pages).

- **Shifts (~60)**: a weekly pattern for 1001–1009 and 1012 (Bar 10:00–18:00, Kitchen 08:00–16:00, staggered
  days), plus:

  | Special                              | Shift                                                                                    |
  | ------------------------------------ | ---------------------------------------------------------------------------------------- |
  | Overnight                            | 1002, every Friday 20:00 → Saturday 02:00 (Bar)                                          |
  | Open, unassigned                     | Bar, Saturday of week 1, `employeeId null`, `status "Open"`                              |
  | Draft                                | 1003, Wednesday of week 2, `status "Draft"`                                              |
  | Spanning the late-October DST change | 1002, Saturday 24 Oct 2026 22:00 → Sunday 25 Oct 2026 06:00 Europe/London (9 real hours) |
  | In progress at `FROZEN_NOW`          | 1001, Wednesday 21 Oct 2026 09:00–17:00 BST                                              |
  | Excluded department                  | 1010, Head Office, Tuesday of week 2                                                     |
  | Hidden day                           | Kitchen, Thursday of week 3 (`scheduleDay.isVisible false` for that date)                |
  | Other published statuses             | one `ForSale`, one `Approved`, one `PunchclockStarted`                                   |

  With another anchor (e2e uses the real date), the DST shift moves to the nearest late-October or late-March
  transition inside the four weeks, else it is omitted (the frozen tests cover it).

- **Credentials**: customer app id `5f0c6a3e-0000-4000-8000-00000000c0de` with refresh token
  `mock-refresh-portal-4100001` (method C); tokens for ClockOff's app ids (A, B) are issued by the mock for the ids
  passed in `options.partnerAppIds` (from `PLANDAY_CLIENT_ID` / `PLANDAY_APP_ID`). Access tokens live 3600 s on
  the mock clock.
- **Punch clock**: two records for 1001's in-progress shift (punch-in 08:58, no punch-out) and one finished
  record with a break, for Beta tests.

### 12.4 Fault simulation (`controls`)

`queueRateLimit({ path?, count, retryAfterSeconds?, resetSeconds? })` (429 with `Retry-After`, with
`x-ratelimit-reset`, or neither), `expireAccessTokens()`, `setRotateRefreshTokens(true)` (refresh returns a new
token and invalidates the old one), `revokeRefreshToken(token | "all", { keepAccessTokens? })` (token endpoint
answers 400 `{"error":"invalid_grant"}`; API 401 unless `keepAccessTokens`, the "Revoke leaves live access tokens
valid" variant of notes §12 Q5), `setRevocationKillsAccessTokens(bool)` (whether `POST /connect/revocation` also
ends the grant's access tokens; both behaviours are tested), `reauthorize(appId)` (a new refresh token for the
app, as after the admin authorises again; returned to the dev control route so "Fill test credentials" can use it
in a reconnect), `queueMalformed({ path, count })` (drops a required field), `queue5xx({ path, count })`,
`setDateTimeFormat("local" | "utc" | "utc-without-z" | "offset")` (`utc-without-z` is the wrong encoding the
`date` cross-check of 4.8 must catch), `capPageSize(n)` (server-lowered limit), `setPagingNull(bool)`,
`editShift(id, patch)`, `deleteShift(id)` (moves it to the deleted list with `dateTimeDeleted`),
`setShiftStatus(id, status)`, `reassignShift(id, employeeId)`, `setScheduleDayVisible(departmentId, date, bool)`,
`addEmployee(raw)`, `deactivateEmployee(id, { effectiveDate?, stayOnActiveList? })` (a future `effectiveDate` with
`stayOnActiveList` puts the person on both lists, the worst case of 6.5), `reactivateEmployee(id)`,
`removeEmployee(id)` (gone from both lists; by-id answers 400), `setScopes(appId, scopes)`, `advanceClock(ms)`,
`reset()`.

### 12.5 `PLANDAY_MODE` guard and badge

- `apps/web/src/lib/env.ts`: `PLANDAY_MODE: z.enum(["mock", "live"]).optional()`, resolved to `live` when
  `NODE_ENV=production` and `mock` otherwise; `parseEnv` throws "PLANDAY_MODE=mock is not allowed in production"
  when production and `mock` (production refuses to start: the worker's `serve` validates the environment first and exits 1, and web's
  `/api/health` fails, so Railway never promotes the web deployment).
- `createMockPlanday`, `startMockPlandayHttpServer` and `scripts/mock-planday.mts` throw when
  `process.env.NODE_ENV === "production"` (`mock/guard.ts`); `parseEnv` also refuses `PLANDAY_MOCK_URL` in
  production. The mock module is imported only by `transport.ts` (tests), the dev routes and the script.
- Connections made in mock mode store `isMock = true`; live mode refuses them (5.7).
- A "Mock Planday" badge appears on the wizard header, the card, the health banner and the connect step, which in
  mock mode also offers "Fill test credentials" (fixture values; these are not customer secrets).

### 12.6 Dev routes (404 unless `PLANDAY_MODE=mock` and not production)

- `GET /api/dev/mock-planday/authorize` renders a minimal consent page for method A (checks `client_id`, the
  exact `redirect_uri`, `response_type=code`, scopes); `POST` approves or denies, asks the mock server for a code
  (`/__control` `issueAuthorizationCode`) and redirects to the callback with `code` and `state`.
- `POST /api/dev/mock-planday/control` (also requires `DEV_TOOLS_ENABLED=true`) `{ action, … }` → forwards to the
  mock server's `/__control`: the 12.4 controls, plus `issueTokenForApp(appId)` for method B. Playwright drives
  edits and revocations through it.

## 13. Test plan

### 13.1 Unit (Vitest, no database)

`packages/integrations/src/**`:

| File                                                                      | Covers                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `planday/http.test.ts`                                                    | Headers (both present, no `X-OpenAPI-Region`), 429 via `x-ratelimit-reset` / `Retry-After` (the longer) / default 60 s, inline wait up to 30 s versus park, jitter bounds, 5xx backoff, timeouts, the connect deadline, per-run budget, API requests aborted by the signal but token requests never, serial queue, header slow-down |
| `planday/pagination.test.ts`                                              | `offset += data.length`; null `paging` continues to an empty page (also with a server-lowered limit); `paging.total` stop; a short page with `paging` present is not an end; empty page; duplicates                                                                                                                                 |
| `planday/tokens.test.ts`                                                  | Code exchange, refresh, missing `expires_in` → 3600, rotation, 400/401 → `AUTH_FAILED`, 5xx → `UNAVAILABLE`, `id_token` dropped                                                                                                                                                                                                     |
| `planday/schemas.test.ts`                                                 | Every endpoint schema; malformed → `INVALID_RESPONSE`; unsafe integer ids; strip sets E and E+ never present after parse                                                                                                                                                                                                            |
| `planday/time.test.ts`                                                    | `Z`, offset, wall-clock; Europe/London gap and overlap; overnight; > 25 h; Windows zone → `INVALID_TIME`; `date` cross-check (UTC without `Z` near midnight in BST → `TIME_ENCODING_MISMATCH`)                                                                                                                                      |
| `planday/mappers.test.ts`                                                 | Allow-list mappers produce exactly the §8 fields (object key snapshot); portal-qualified external ids                                                                                                                                                                                                                               |
| `core/shiftDecisions.test.ts`                                             | Every row of the 6.6 table (including 4a `REHASH_ONLY`, 14a hidden day in progress, 15 with a new employee), plus `classifyPlandayShift` for every status, including `Open` with and without an employee                                                                                                                            |
| `core/employeeDecisions.test.ts`                                          | Matching order 1–6 with `plandayNameCounts`; raw id without corroboration never links; other-portal ids never match; name-only in SYNC → `POSSIBLE_MATCH`; ambiguity never merged; future dismissal; positive-evidence deactivation; decision table 6.5                                                                             |
| `core/hash.test.ts`                                                       | Decision-input hashes: a target change changes the hash, a settings change that keeps every target does not                                                                                                                                                                                                                         |
| `core/locationDecisions.test.ts`                                          | 6.3 and 6.4 tables                                                                                                                                                                                                                                                                                                                  |
| `core/rateLimiter.test.ts`, `core/backoff.test.ts`, `core/window.test.ts` | Buckets, jitter, window across DST                                                                                                                                                                                                                                                                                                  |
| `planday/provider.test.ts`                                                | Phases against the mock with an in-memory sink; scope probes for C; `connect()` accepts only `PlandayConnectCredentials` (a raw `authorizationCode` / `state` is refused, `REDIRECT_REQUIRED` is never returned); forced refresh in `PORTAL_CHECK`; portal mismatch; a portal without departments                                   |
| `planday/mock/mock.test.ts`                                               | Fixture invariants (counts and specials exactly as 12.3); production guard throws                                                                                                                                                                                                                                                   |
| `planday/mock/httpServer.test.ts`                                         | The same handler over HTTP: host rewrite paths, `/__control`, `/__health`, refusal in production                                                                                                                                                                                                                                    |

`apps/web/src/**` unit: `lib/env.test.ts` (mode resolution, `PLANDAY_ENABLED` defaults, production refusal of
`PLANDAY_MODE=mock` and `PLANDAY_MOCK_URL`), `lib/crypto.test.ts` (AAD), `server/integrations/scheduledSync.test.ts`
(7.8: `NO_AVAILABLE_PROVIDER` when nothing is registered or `PLANDAY_ENABLED=false`; one `SCHEDULED` run per
eligible connection with its deterministic jitter; skips active and fresh; a failing candidate is isolated and
counted), `worker/integrationRunner.test.ts` (fake claim, slice, bus and clock: wakes on `integration.run.queued`,
polls every 10 s and at the earliest `resume_after`, never exceeds its concurrency, re-polls when a slice settles,
survives a throwing poll or slice, claims nothing without providers, `halt()` aborts the signal and stops claiming,
`drain()` waits up to the grace and reports abandoned runs, overrun guard, pool-size cap),
`worker/jobs.test.ts` (five jobs, unique lock keys, key 6 for `integrations-upkeep`, lanes and intervals,
`integrations-sync` reports `enqueued` as `processed`), `worker/scheduler.test.ts` (`ctx.signal` set per lane pass
and aborted by `stop()`; `laneLastCompletedAt("integrations")`), `worker/shutdown.test.ts` (new: the runner halts
in step 1 and drains together with the scheduler within one grace; the fixed budget stays 20.5 s; upkeep returns
within its budget once aborted), `worker/cli.test.ts` (serve starts the runner after the migration gate only when
jobs are enabled; `run <job>` never starts it; heartbeat details carry `integrationsLaneLastCompletedAt` and
`integrationRunner`), `server/health/workerHeartbeat.test.ts` (`worker.integrations` ok / stale / disabled),
`server/lifecycle/webShutdown.test.ts` (the draining flag is set on the first signal),
`deploy/processBoundaries.test.ts` (the new run entry points), `deploy/railwayConfig.test.ts` (both Dockerfiles
copy every workspace `package.json`; `.railway/railway.ts` lists the appendix A names),
`server/integrations/dependencyDirection.test.ts`, `components/integrations/planday/planday-view-model.test.ts`,
`components/realtime/realtime-model.test.ts` (the four new event types), `components/onboarding/planday/*.test.tsx`
render tests (connect step with and without A/B env, mock badge, "Waiting to start", Continue on `PARTIAL`),
`server/organisations/organisations.test.ts` (checklist copy table, both Planday availability rows),
`config/navigation.test.ts` (`getPostAuthRedirect` continues to `/connect/planday?token=…` with no organisation),
`components/integrations/planday/planday-reconnect-panel.test.tsx` (shown for `AUTH_ERROR` and `DISCONNECTED`,
"Use a different portal" only from `DISCONNECTED`, "Try again" only for `AUTH_ERROR`).

### 13.2 Integration (Vitest `integration` project, `clockoff_test`, in-process mock transport)

Folder `apps/web/test/integration/planday/` with a helper `plandayHarness.ts` (create org + OWNER/ADMIN/MANAGER,
mock, `connectViaMethod(method)`, `completeOnboarding(choices)`, `runSync({ now })`, `driveRunToCompletion(runId,
{ now, ignoreResumeAfter })` (takes the lease with a test holder and loops `runSyncSlice`), device factory). Tests
never start the runner: they call the same functions it calls.

| File                            | Asserts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connectMethods.test.ts`        | A, B, C store equivalent credentials (5.5); A/B hidden and rejected without env; proof failures persist nothing; scope 403 names the scope; paste rate limit; no secret in any response; MANAGER forbidden; the generic `POST …/planday/connect` with `{ code, state }` → 404, nothing stored; a second organisation connecting the same portal → `INTEGRATION_PORTAL_IN_USE`; a connect while web is draining → `INTEGRATION_UNAVAILABLE`, OAuth state left unconsumed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `oauthState.test.ts`            | Valid callback; tampered HMAC; expired (> 10 min, mock clock); replay rejected; other user; user demoted to MANAGER; exact redirect URI; PKCE on and off; denied consent; open redirect impossible                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `tokenRefresh.test.ts`          | Refresh 5 min before expiry; forced refresh at every SYNC's `PORTAL_CHECK`; rotation persisted in the same `UPDATE` as the access token; the five persistence cases of 4.3 (transient retry, rotating mock → `AUTH_ERROR`, non-rotating → `CREDENTIAL_PERSIST_FAILED`, lease lost, wiped); concurrent callers under one lease share one token request; a holder without the lease cannot refresh; 401 → one forced refresh                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `rateLimits.test.ts`            | 429 with a short reset waits inside the slice and succeeds; a long reset (or none) parks the run (`resumeAfter`, lease released) and the next slice completes; pagination to exhaustion with `capPageSize`, with and without `setPagingNull`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `syncShifts.test.ts`            | Drafts excluded; open ignored (`employeeId null`, any status); `Open` with an employee imported; removed → `CANCELLED` (deleted list and by-id 404), never deleted; in-progress shortened / extended / ended now / removed; past untouched; overnight and DST instants; reassignment future and in-progress; X → unmapped Y → mapped C ends with C's shift (full-target REINSTATE); excluded department; hidden day with `respectHiddenDays` on (future cancelled and reinstated on unhide; in progress untouched) and ignored with it off; an inactive mapped employee's shifts kept; unknown status; `TIME_ENCODING_MISMATCH` fails the run with nothing of that page written; 500 changed shifts (five steps, ≤ 12 statements per transaction, under the timeout); conflict replacement at the INITIAL SYNC (cancelled with the replacement's transaction; in-progress and unreplaced conflicts kept); version bump, `SCHEDULE_CHANGED` published, activity rows; edit reaches `GET /api/mobile/v1/sync` `scheduleVersion` |
| `syncEmployees.test.ts`         | CSV employee linked by raw external id with corroboration (1007); raw id without corroboration never linked (`fixtureCsvCollision` → `POSSIBLE_MATCH`); email match; namesakes on different pages (`capPageSize(1)`) never merged with `fixtureNamesake`; name-only after onboarding → `POSSIBLE_MATCH`; auto-include vs pending; plan limit; deactivation (deactivated list, past date) revokes device and refresh tokens, unlinks, ends break, activity `EMPLOYEE_DEACTIVATED`, no hard delete; future dismissal on both lists: two SYNCs change nothing; removed employee (by-id 400) → `EMPLOYEE_NOT_VISIBLE`, devices untouched, `MISSING_IN_PLANDAY` review after 24 h, Deactivate and Keep; `isDeactivated: true` by id → deactivated; reactivation deferred to `REACTIVATIONS`; `importEmails` off stores no email; no-email employee joins with company code + name; duplicate names need invite codes; a portal without departments imports through "Not in any department"                                         |
| `idempotency.test.ts`           | 6.2, including the settings-save, hide/unhide, deactivate/reactivate and X → Y → X cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `reconnect.test.ts`             | Revoke → reconnect same portal → no duplicate employees, locations, teams, shifts or map rows; disconnect (`KEEP_RECORDS` and `CANCEL_FUTURE_SHIFTS`) → reconnect same portal → records re-adopted, a shift edited while disconnected reverted, future shifts reinstated, no duplicates; different portal refused without `allowPortalSwitch`; switch after disconnect (4100001 → 4100002, overlapping ids) resets mappings with no cross-link and no `P2002`; previous token revoked only when the client id differs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `health.test.ts`                | `DEGRADED` after 60 min; email after 6 h exactly once; recovery clears; revoked refresh token → `AUTH_ERROR`, one `INTEGRATION_ERROR` notification per OWNER/ADMIN, one email each (also when every admin opted out of `INTEGRATION_ERROR` email), none to MANAGER, within one run; the same with `revokeRefreshToken({ keepAccessTokens: true })` (detected by the forced refresh); `retryAuth` success → `CONNECTED`, and a later revocation notifies and emails again; an auth probe after a transient token-endpoint 400 returns the connection to `CONNECTED` with one `INTEGRATION_RECOVERED`; banner endpoint per role, `reconnectHref` before and after onboarding, paused banner with `PLANDAY_ENABLED=false`; compliance `rotaMayBeOutOfDate`                                                                                                                                                                                                                                                                       |
| `runQueue.test.ts`              | `enqueueRun` inside a caller's transaction never aborts it; each outcome (`QUEUED`, `ALREADY_RUNNING`, `FOLLOW_UP_QUEUED`, `REFUSED`); the pending slot drains at FINALISE and at `failRun`; "Sync now" during a `CLOCK` run runs after it; `claimDueRuns` order (first-slice priority, demotion, round-robin, `resume_after`) and a long priority-0 run delays another integration's SCHEDULED run by at most one slice; AVAILABLE providers only; two holders never lease one portal; an expired lease is taken over; a step, park, fail or finalise after lease loss or after the run left `RUNNING` writes nothing; disconnect during a slice                                                                                                                                                                                                                                                                                                                                                                             |
| `runnerShutdown.test.ts`        | The signal fires while a page request is in flight: nothing of the step is written, the cursor stays, the lease is released; a token exchange in flight completes and persists a rotated token; the resumed run ends with exactly the rows, maps and counts of an uninterrupted run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `progressEvents.test.ts`        | `integration.run.queued` after commit only (none on rollback); `integration.sync.progress` after committed steps, throttled to one per 2 s, forced on phase change, park, yield and finish; payloads contain no sentinel, name or email                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `workerIntegrationJobs.test.ts` | Slot job enqueues `SCHEDULED` runs with jitter and `nextSyncAt` (a slot during a `CLOCK` run becomes a follow-up); upkeep: health evaluation (compare-and-set against a concurrent FINALISE), `RECOVERY` on the backoff schedule only after onboarding, auth probes on their backoff (none for deterministic failures, none after 7 days), `CLOCK` every 2 minutes only with the flag, catch-up after a missed slot, runs older than 2 h failed `STALLED`, `SYNCING` reset, missing-employee reviews, hourly housekeeping (abandoned sessions release their imports), budget and abort; manual sync throttle and `followUpQueued`                                                                                                                                                                                                                                                                                                                                                                                             |
| `disconnect.test.ts`            | Both modes; revocation called with the stored token after commit; secrets wiped; lease and pending slot cleared; managed flags cleared; `CANCEL_FUTURE_SHIFTS` marks map rows `upstreamRemovedAt`; an active run is failed and its slice writes nothing more; a 401 in flight during the disconnect leaves `DISCONNECTED` with no notification, no email and no failure count; an immediate reconnect gets the lease; audit and activity                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `onboardingWizard.test.ts`      | Rota source stored; every step's validation; resume after reload at each step; no `Shift` rows and no `Employee` rows beyond the step 5 selection exist before Finish, even when step 4 is saved during the DIRECTORY run (DIRECTORY follow-up, no SYNC) and when a 5xx fails the DIRECTORY run three times (no recovery SYNC, Retry re-queues DIRECTORY); `POST …/sync` and `PATCH …/settings` → 409 before Finish; Continue on `PARTIAL`; re-saving step 3 without a department releases its imported employees; a foreign id in any body → 404; Finish while a preview refresh runs supersedes it and queues the INITIAL SYNC; Finish produces the expected employees, locations, teams, shifts and policies; checklist satisfied by the connection                                                                                                                                                                                                                                                                        |
| `connectLinks.test.ts`          | OWNER/ADMIN create; MANAGER cannot; a link for a new email sends an ADMIN invite whose acceptance lands on the link and then the wizard of the right organisation; a `MANAGER` recipient → `CONFLICT`; expired and revoked rejected; non-member and MANAGER of the org get `NOT_FOUND`; after onboarding the link redirects to the reconnect panel; success switches org; audit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `settingsAndSync.test.ts`       | Settings `PATCH` applies mappings, bumps `mappingVersion`, audits the diff and queues a `MANUAL` run (or a follow-up); a run that started before the change gets a follow-up of its own kind at `FINALISE`; a save that changes no target bumps no `shifts.version`; `retryAuth` on `AUTH_ERROR` (flag stored on the run; only that run may start)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `mockDevRoutes.test.ts`         | Dev routes answer 404 in production, in live mode and (control) without `DEV_TOOLS_ENABLED`; they forward to the mock server                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `lockedFields.test.ts`          | Managed employee name/email edit → 409; policy edit allowed; managed shift update/cancel/delete → 409; duplicate allowed; managed location rename → 409                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `dataMinimisation.test.ts`      | After onboarding (with one in-scope employee unticked at step 5) + Finish + two syncs + deactivation + a `CLOCK` run (clock flag on): every text, varchar, citext, json/jsonb and text[] column of every table (from `information_schema.columns`) contains no `SENTINEL-PII`, no `1901-02-03`, no `pii.invalid`, no fixture phone, no token value, and no name, email or id of 1010 (excluded department), 1011 (deactivated, never imported) or the unticked employee, except their ids in `excludedEmployeeIds` and map rows; punch records of excluded departments or unmapped employees produce no `ClockEvent`; captured logs contain none of those nor any name or email                                                                                                                                                                                                                                                                                                                                               |
| `tenantIsolation.test.ts`       | Two orgs with portals 4100001 and 4100002 (overlapping ids) sync side by side; no cross-links; every Planday endpoint 404s across orgs (also via `tenantCases/planday.ts`, including the body-id cases of D-056)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `mockGuard.test.ts`             | Production env with mock throws; dev routes 404 in production and in live mode; `isMock` connection refused in live mode                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### 13.3 Spec §12 mapping

| Spec §12 item                                                           | Test file(s)                                                             |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| All three methods store equivalent credentials                          | `connectMethods.test.ts`                                                 |
| OAuth state verification + replay rejection                             | `oauthState.test.ts`                                                     |
| Token refresh incl. rotation persisted atomically + persistence failure | `tokenRefresh.test.ts`, `planday/tokens.test.ts`                         |
| Pagination                                                              | `planday/pagination.test.ts`, `rateLimits.test.ts`                       |
| 429 backoff                                                             | `planday/http.test.ts`, `rateLimits.test.ts`                             |
| Every §5 rule                                                           | `core/*Decisions.test.ts`, `syncShifts.test.ts`, `syncEmployees.test.ts` |
| Employee matching incl. ambiguous never merged                          | `core/employeeDecisions.test.ts`, `syncEmployees.test.ts`                |
| Deactivation revokes device tokens                                      | `syncEmployees.test.ts`                                                  |
| Idempotency (sync twice changes nothing)                                | `idempotency.test.ts`                                                    |
| Reconnect reuses mappings without duplicates                            | `reconnect.test.ts`                                                      |
| Health transitions + notifications                                      | `health.test.ts`                                                         |
| Data-minimisation test                                                  | `dataMinimisation.test.ts`, `planday/schemas.test.ts`                    |
| Tenant isolation across two orgs each with Planday                      | `tenantIsolation.test.ts`, `tenantCases/planday.ts`                      |
| Mock cannot run in production                                           | `mockGuard.test.ts`, `lib/env.test.ts`, `planday/mock/mock.test.ts`      |
| Playwright full wizard                                                  | `e2e/planday-onboarding.spec.ts`                                         |

### 13.4 Playwright (`apps/web/e2e/planday-onboarding.spec.ts`)

Runs against three local processes sharing `PLANDAY_ENABLED=true PLANDAY_MODE=mock
PLANDAY_MOCK_URL=http://127.0.0.1:4010`. `playwright.config.ts` `webServer` becomes an array: the mock server
(`pnpm --filter @clockoff/web mock:planday`, url `http://127.0.0.1:4010/__health`), web (`pnpm dev` with
`DEV_TOOLS_ENABLED=true EMAIL_PROVIDER=console`, url `/api/health`) and the worker (`pnpm --filter @clockoff/web
worker`, `wait: { stdout: /"jobs started"/ }`, so runs are executed exactly as in production). Local `DIRECT_URL`
(the Postgres container) gives web and worker the Postgres bus, so progress arrives over SSE. With reused servers
the spec first checks `GET /api/integrations/planday/connect-methods` → `isMock` and that the structure run leaves
"Waiting to start" within 20 s (the worker is running), and fails with a clear message otherwise.

1. Register, verify email (dev outbox), create the organisation → lands on "How do you schedule your team?".
2. Planday card → wizard step 1 → "Other ways to connect" → method C → "Fill test credentials" → Connect →
   "Token ending ••••0001" shown, never the token.
3. Step 2 shows "Mock Bistro Group" and the Mock badge; the structure run's progress updates live until it succeeds.
4. Step 3: exclude Head Office; keep Bar and Kitchen as new locations. Step 4: accept new teams.
5. Step 5: 10 candidates (12 − Hannah deactivated − Omar excluded), flags "missing email" on Daniel; select all;
   wait for the import run.
6. Step 6: per-day counts, an "Overnight" badge, the drafts note and the open-shifts note.
7. Step 7: one-click Standard Staff and Standard Break. Step 8: Scheduled. Finish: wait for the final run;
   duplicate-name group "Alex Morgan" offers personal invite codes.
8. Dashboard: `/employees` lists the 10 people with "Managed in Planday"; `/locations` lists Bar and Kitchen;
   `/schedule` shows Planday shifts for the current week.
9. `POST /api/dev/mock-planday/control { action: "editShift" }` → "Sync now" → the run is picked up by the worker
   and the shift's new end time appears.
10. `{ action: "revokeRefreshToken" }` → "Sync now" → red banner "Planday disconnected…" on the overview; the dev
    outbox holds the email to the owner; the notifications bell shows the notification.
11. The banner's "Reconnect" opens `/integrations?planday=reconnect`; `{ action: "reauthorize" }` issues a new
    token; "Fill test credentials" → Connect → the reconnect panel shows the `RECOVERY` run, the banner clears, and
    `/employees` still lists exactly the 10 people (no duplicates).

Screenshots go to `e2e/screenshots/planday-*.png` (reused for the help article's slots where suitable).

## 14. Documentation and help deliverables

| File                                                                                                                                             | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/integrations/PLANDAY.md` (new)                                                                                                             | Architecture (package, sinks, the run queue, the worker's integration runner and the two integration jobs, leases, SIGTERM behaviour, progress events; the diagram from 7.1); the three methods and when each shows; env vars (appendix A, and why there is no client secret, notes §3.4); exact scopes; sync rules (tables of 6.3–6.6); health; rate limits; clock-in latency stated plainly; mock testing (the three local processes); switching to live; the `PLANDAY_ENABLED` kill switch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `docs/integrations/PLANDAY_DATA.md` (new)                                                                                                        | What is read, what is stored and where (table of 4.7 and the staging tables), what is never read, retention (staging purged, employees soft-deactivated, runs 90 days, run cursors cleared at the end of each run, revocation on disconnect), the `email` caveat (notes §12 Q21) and the "Import email addresses" choice (D-042).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `docs/INTEGRATIONS.md`                                                                                                                           | "Adding Planday" replaced by a link to PLANDAY.md; data model table updated (`ExternalEntityMap` replaces `settings.locationMap`); "Never hard-delete" bullet updated (deactivation now follows Planday on positive evidence, D-033, D-045); overlap rule (D-034); portal-qualified external ids (D-050); lifecycle diagram updated to runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `docs/DECISIONS.md`                                                                                                                              | Entries D-030 to D-056 (appendix C); D-040 and D-042 are entered as owner decisions with the plan's safe default and the question to the owner.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `docs/STATUS.md`                                                                                                                                 | New "Planday" section with built/partial/mocked rows and **"Planday: switching from mock to live"**: (1) request a demo portal from `apisupport@planday.com`; (2) create a test app and the production app "ClockOff" with exactly the read scopes in PLANDAY.md, Redirection URL `https://app.clockoff.online/api/integrations/planday/callback`; (3) **the demo-portal gate** (section 15, release step 2): record fixtures on the demo portal (a published shift across a DST change in a DST-observing zone, a shift starting within an hour of midnight, a draft before and after publishing, a hidden day) and verify the open questions marked "demo" in section 16.1 (portal-info scope, PKCE, refresh rotation, date-time and `date` encodings, time-zone formats, published-draft status, `isVisible` meaning, scope-grid labels, 429 headers); record results in PLANDAY_API_NOTES.md; (4) capture the screenshots into `apps/web/public/help/planday/`; (5) ask Planday support whether customers may use Connect App with ClockOff's App ID (method B); (6) the owner decides D-040 and D-042; (7) on Railway set `PLANDAY_ENABLED=true` on web and worker, leave `PLANDAY_MODE` unset (live), set `PLANDAY_CLIENT_ID` on web once the production app exists (enables A), `PLANDAY_APP_ID` on web only after step 5, `PLANDAY_OAUTH_PKCE` per step 3, leave `PLANDAY_CLOCK_MODE_ENABLED` unset (each change redeploys that service; the names are already in `.railway/railway.ts`); (8) run the stage 8 release checks; (9) the customer connects with method C (works without any Planday involvement). |
| `docs/ENVIRONMENT.md`, `.env.example`, `apps/web/.env.production.example`, `turbo.json`, `.railway/railway.ts`                                   | New variables (appendix A); `turbo.json` `globalPassThroughEnv` gains the `PLANDAY_*` names; `.railway/railway.ts` lists the production names (stage 1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `docs/API.md`, `docs/openapi.json`                                                                                                               | New routes; "Not in the document": the OAuth callback and the dev mock routes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `docs/DATABASE.md`                                                                                                                               | New tables and columns, expand-only migration note, legacy column to drop later.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `docs/SECURITY.md`, `docs/TESTING.md`, `docs/DEPLOYMENT.md`, `docs/WORK_MODE_SERVER_JOB.md`, `docs/ARCHITECTURE.md`, `docs/LOCAL_DEVELOPMENT.md` | Section 11 summary; how to run the Planday suites and the e2e (mock server, web, worker); the integration runner, `integrations-upkeep` and the rewritten `integrations-sync` in the worker's job list, their log lines and `node main.mjs run integrations-sync`; `PLANDAY_ENABLED` as release and kill switch; running the mock server locally.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `apps/web/src/app/(dashboard)/help/planday/page.tsx` + `components/help/planday/*`                                                               | Customer article: overview; what ClockOff reads and never reads; method A, B and C with numbered steps and screenshot slots (`/help/planday/a-*.png`, `b-1…b-4`, `c-1…c-5`; `next/image` with a labelled placeholder until the file exists); after connecting (sync timing, "Managed in Planday", pending employees); troubleshooting (revoked access, missing permission, wrong portal, time zone); disconnecting. Linked from `/help`, the wizard's connect step and the card.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `apps/web/public/help/planday/README.md`                                                                                                         | List of expected screenshot filenames and what each shows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/shared/src/privacyStatements.ts` → `docs/PRIVACY.md`                                                                                   | Only if the build adds a Planday statement; `docs/PRIVACY.md` is regenerated from the source, never hand-edited.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## 15. Build stages

Eight stages, each sized for one workflow, in spec §14 order. Within a stage, agents marked ∥ run in parallel with
**disjoint file ownership**; → means after. Shared contract files (`schema.prisma`, `enums.ts`, `errors.ts`,
`packages/validation/src/*`, `openapi/routes.ts`, `server/events/EventBus.ts`) are owned by stage 1; a later stage
that finds a gap fixes it in its closing integration step, never inside a parallel agent. **Every stage deploys**,
so whatever a stage ships must be correct in production with `PLANDAY_ENABLED=false`.

**Gate G** (end of every stage, all must pass, run from the repo root):

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration \
  && pnpm --filter @clockoff/web build && pnpm format:check
```

`pnpm --filter @clockoff/web build` also bundles the worker (`scripts/build-worker.mjs` fails if Next.js or React
reach the bundle, so `@clockoff/integrations` must never import them). Plus `pnpm --filter @clockoff/db exec prisma
migrate status` against the local dev database (up to date) and, in stage 8, `pnpm --filter @clockoff/web test:e2e`
with the mock (13.4). Integration suites share `clockoff_test` behind an advisory lock, so parallel agents'
integration runs queue rather than collide. Each stage ends with a local commit on `feat/planday-integration`
listing its paths explicitly.

**Gate D** (deploy, after Gate G and the stage commit):

1. If `main` moved, rebase the branch on `origin/main` and rerun Gate G. Then `git checkout main && git merge
--ff-only feat/planday-integration && git push origin main && git checkout feat/planday-integration`.
   Railway rebuilds web and worker (their watch patterns cover `apps/web/**` and `packages/**`; a docs-only push
   rebuilds nothing), and web's pre-deploy step applies any new migration.
2. Wait with foreground polling commands that have timeouts (no `Monitor`, at most 20 minutes) until `railway
deployment list --service web` and `--service worker` show the pushed commit as `SUCCESS`. This needs the Railway
   CLI linked to project `clockoff`, environment `production`, with the owner's `RAILWAY_API_TOKEN` in the shell
   (never written to a file). Without it, poll `/api/health` and ask the owner to read the logs.
3. Checks for every stage: `curl -fsS https://app.clockoff.online/api/health` → `status: "ok"`, `migrations:
"up_to_date"`, `worker.status: "fresh"`, `worker.jobs: "ok"` (from stage 4 on also `worker.integrations: "ok"`,
   7.9 Monitoring), `realtime.listening: true`; `railway logs
--service worker --lines 300` shows `worker starting` with the new version, `jobs started`, a `job finished`
   `work-mode-tick` `ok` after the deploy and the previous worker's `worker stopped` without `jobs abandoned`;
   `railway logs --service web --lines 300` has no `error` or `fatal` line since the deploy.
4. The stage's own checks (below).
5. A failed check: roll both services back in Railway (service → Deployments → the previous successful deployment →
   Rollback; safe because migrations are expand-only), report, and fix forward on the branch.

### Stage 1 — Contracts, data model and build plumbing

- **1A (db)**: `packages/db/prisma/schema.prisma`, both migrations (2.1, hand-edited SQL 2.5),
  `packages/db/src/migrations.ts`, and the mechanical renames that keep the build green:
  `server/integrations/integrations.repository.ts`, `integrations.service.ts` (field names only; disconnect keeps
  the row), `server/compliance/compliance.repository.ts`, `compliance.service.ts`,
  `test/integration/integrations.test.ts`. Apply locally with `prisma migrate dev` (dev database), never `db push`.
- **1B (contracts and plumbing)** → after 1A: scaffold `packages/integrations` (package.json, tsconfig, eslint,
  vitest, empty barrels); `next.config.ts` `transpilePackages`; `apps/web/package.json` (`@clockoff/integrations`,
  `qrcode`, `@types/qrcode`); `pnpm install` (lockfile); `docker/web/Dockerfile` and `docker/worker/Dockerfile`
  (`COPY packages/integrations/package.json packages/integrations/` before `pnpm install --frozen-lockfile`);
  `.railway/railway.ts` (`PLANDAY_ENABLED`, `PLANDAY_MODE`, `PLANDAY_CLOCK_MODE_ENABLED` in `SHARED_VARIABLES`;
  `PLANDAY_CLIENT_ID`, `PLANDAY_APP_ID`, `PLANDAY_OAUTH_PKCE` in `WEB_VARIABLES`); `src/deploy/railwayConfig.test.ts`
  (both Dockerfiles copy every `packages/*/package.json`; the IaC lists the appendix A names);
  `packages/shared/src/enums.ts` (+ `enums.test.ts`), `errors.ts`,
  `providers/{workforceProvider,syncSink,credentialStore,resumable}.ts`; `packages/validation/src/{planday.ts (new),
integrations.ts, organisation.ts, notifications.ts, employees.ts, shifts.ts, locationsTeams.ts, compliance.ts,
realtime.ts, enumSchemas.ts, index.ts}`; `apps/web/src/server/events/EventBus.ts` (the four new event types,
  mirrored); `openapi/routes.ts` + `openapi.test.ts` + `docs/openapi.json`; DTO mappers emitting `managedBy: null` /
  `source` (`employees.mappers.ts`, `shifts.mappers.ts`, `locations.service.ts` `toLocationDto`,
  `teams.service.ts` `toTeamDto`); `lib/errorMessages.ts`; `lib/env.ts` (+ test: appendix A, including the
  production refusals), `lib/crypto.ts` (+ test), `lib/logger.ts`; `turbo.json`, `.env.example`,
  `apps/web/.env.production.example`, `docs/ENVIRONMENT.md`; ESLint dependency rules (3.2); the shared query keys
  `apps/web/src/components/integrations/integration-keys.ts` (new: `integrationKeys` moved here with the new
  `health` key, and `plandayKeys`) and `components/integrations/use-integrations.ts` (re-exports `integrationKeys`
  from it; nothing else changes). Later stages import `integration-keys.ts` and never edit it (a gap is fixed by
  the stage lead's closing step).
- Gate G (plus, where Docker is available, `docker build -f docker/web/Dockerfile .` and the worker equivalent:
  a new workspace package is the classic way to break `pnpm install --frozen-lockfile` in the image). Commit
  "Planday: data model, contracts and package scaffold". Gate D. Stage checks: `/api/health` reports
  `migrations: "up_to_date"`, which against the new `LATEST_MIGRATION` proves the pre-deploy step applied both
  migrations; at the next quarter hour the worker logs `integrations-sync` with `reason: "NO_AVAILABLE_PROVIDER"`.

### Stage 2 — Planday client and mock (`packages/integrations`, plus the mock server script)

- **2A (client)** ∥ **2B (mock)**.
  - 2A owns `src/core/{deadline,backoff,rateLimiter,hash,window}.ts` and `src/planday/{constants,errors,schemas,
mappers,time,tokens,http,pagination,client,authorizeUrl,logging,index}.ts` with their unit tests (4.x).
  - 2B owns `src/planday/mock/**` (12.1 to 12.4, including `httpServer.ts`) with `mock/mock.test.ts` and
    `mock/httpServer.test.ts`, written from the notes' raw shapes, plus `apps/web/scripts/mock-planday.mts` and the
    `mock:planday` script line in `apps/web/package.json`.
- **2C** → after both: `src/planday/client.contract.test.ts` (client × mock: tokens, rotation, revocation, 401
  retry, pagination with capped pages, 429 variants including the inline-wait and park thresholds, 5xx, malformed,
  abort by signal for API requests but never for token requests, unexpected-request assertion; one pass over HTTP
  through `httpServer.ts`).
- Gate G. Commit "Planday: API client and mock". Gate D. Stage checks: both images built (nothing imports the
  package at runtime yet); the common checks only.

### Stage 3 — Provider, sync engine, writers and the run executor

- **3A (engine + provider)** ∥ **3B (writers)**.
  - 3A owns `packages/integrations/src/core/{shiftDecisions,employeeDecisions,locationDecisions}.ts`,
    `src/planday/{phases,provider}.ts`, `src/planday/testing/memorySink.ts` and their tests (classification,
    decision-input hashing inputs, matching with `plandayNameCounts`, the `PlandayConnectCredentials` contract).
    `PROVIDERS.PLANDAY.status` stays `COMING_SOON`: availability comes from registration (3.4).
  - 3B owns `apps/web/src/server/shifts/{shifts.internal.ts (new), shifts.service.ts, shifts.integration.ts
(new)}`, `server/employees/{employees.integration.ts (new), employees.service.ts}`,
    `server/locations/{locations.integration.ts (new), locations.service.ts}`, `server/teams/{teams.integration.ts
(new), teams.service.ts}`, `server/departments/departments.service.ts` (target guard),
    `test/integration/planday/lockedFields.test.ts`; existing shifts, employees and locations suites stay green.
    Includes `bulkRescheduleIntegrationShifts`, `cancelReplacedShift`, the full-target `reinstateIntegrationShift`
    and the organisation filter in every writer (6.9).
- **3C (web sync)** → after both: `server/integrations/{providers,transport,credentials,status,hasher,health,
notifications}.ts` (`health.ts` with `enterAuthError()`; `notifications.ts` with its final signatures and a body
  that only logs until stage 4 completes it; `status.ts` with the compare-and-set `setConnectionStatus`;
  `credentials.ts` with the forced refresh, persist retries, `CredentialsWipedError` and `knownVersion()`),
  `server/integrations/sink/**` (including the database-only phases and re-adoption helpers used by stage 5),
  `server/integrations/runs/{constants,runs.repository,enqueue,progress,executor}.ts` (onboarding gate, pending
  slot, fenced terminal writes, first-slice priority),
  `src/deploy/processBoundaries.test.ts` (`runSyncSlice` → `server/integrations/runs/executor.ts`),
  `test/integration/planday/{plandayHarness,tokenRefresh,rateLimits,runQueue,runnerShutdown,progressEvents,
syncShifts,syncEmployees,idempotency,dataMinimisation,tenantIsolation}.test.ts` (the sync-level parts; HTTP-level
  parts come in stage 5).
- Gate G. Commit "Planday: provider, sync engine, integration writers and run executor". Gate D. Stage checks:
  the managed-record guards are live but match no row (no integration manages anything); common checks.

### Stage 4 — Worker runtime: runner, quarter-hour slot, upkeep, health and notifications

- **Prologue** (stage lead, before 4A and 4B start): write `server/integrations/scheduledSync.ts` and
  `server/integrations/upkeep.ts` with the exported types and signatures of 7.8 and 7.9 exactly and bodies that
  throw `not implemented`, so 4A compiles against them. 4B owns both files afterwards; the stage never deploys a
  throwing body.
- **4A (worker)** ∥ **4B (server)**.
  - 4A owns `apps/web/src/worker/{integrationRunner.ts (new), integrationRunner.test.ts (new), jobs.ts,
jobs.test.ts, lockKeys.ts, cli.ts, cli.test.ts, scheduler.ts, scheduler.test.ts, shutdown.ts,
shutdown.test.ts (new)}` (the runner's `integration.run.cancelled` handling; `ctx.signal` per lane pass;
    `laneLastCompletedAt`; heartbeat details), `server/health/workerHeartbeat.ts` (+ test) and
    `app/api/health/route.ts` (`worker.integrations`, 7.9 Monitoring), and `src/deploy/processBoundaries.test.ts`
    (`runIntegrationsUpkeep` → `server/integrations/upkeep.ts`).
  - 4B owns `server/integrations/{scheduledSync.ts, scheduledSync.test.ts, upkeep.ts, health.ts,
notifications.ts, index.ts}` (auth probes, `reconnectHref`, the paused banner, transactional auth-error
    alerts, missing-employee reviews), `app/api/integrations/health/route.ts`, `server/email/templates.ts` (+
    `email.test.ts`), `server/notifications/**` (new types, the opt-out exception for the auth-error alert),
    `server/compliance/**` (`rotaMayBeOutOfDate`), `test/integration/planday/{health,workerIntegrationJobs,
mockGuard}.test.ts`.
- Gate G. Commit "Planday: worker runner, scheduled slot, upkeep, health and notifications". Gate D. Stage checks:
  the worker logs `integration runner started { concurrency, poolSize }` (if `poolSize` is below 4, the stage report
  asks the owner to raise `connection_limit` in `DATABASE_URL`, a value only Railway holds); `integrations-upkeep`
  `job finished` `ok` every minute with `reason: "NO_AVAILABLE_PROVIDER"`; `/api/health` reports
  `worker.integrations: "ok"`; `railway restart --service worker` (or the next deploy) shows the old worker's
  runner halting and draining with `abandoned: []` and no `jobs abandoned` inside the grace.

### Stage 5 — Connection methods and the Planday API

- **5A (connect + API)** ∥ **5B (dev mock routes)**.
  - 5A owns `server/integrations/planday/{planday.service,oauthState,connectLinks,pendingEmployees.service,
settings.service,dto}.ts` (re-adoption, portal switch, previous-token revocation, body-id checks),
    `server/integrations/integrations.service.ts` (delegation; `connectIntegration` refuses Planday; the list's
    `paused` flag), `server/integrations/index.ts`, every route under `app/api/integrations/[provider]/**`
    (including the existing generic `connect/route.ts`, which answers 404 `CONNECT_METHOD_UNAVAILABLE` for Planday;
    connect-methods, connect/oauth, connect/token, callback, disconnect, sync, runs, runs/[runId], settings,
    pending-employees, pending-employees/resolve, connect-links, connect-links/[linkId], connect-links/resolve, the
    detail `route.ts`), `app/api/integrations/route.ts`, `server/organisations/members.ts` (`inviteMember`'s optional
    `next`) and the manager-invite template in `server/email/templates.ts`, `server/lifecycle/webShutdown.ts` (+ test:
    the draining flag), `test/integration/planday/{connectMethods,oauthState,reconnect,disconnect,connectLinks,
settingsAndSync}.test.ts`, `tenantCases/planday.ts` (including the body-id cases).
  - 5B owns `app/api/dev/mock-planday/{authorize,control}/route.ts` and `test/integration/planday/
mockDevRoutes.test.ts` (404 in production, in live mode and without `DEV_TOOLS_ENABLED` for control).
- Gate G. Commit "Planday: connection methods and API". Gate D. Stage checks: common checks; optionally, signed in as
  the owner, `GET /api/integrations/planday/connect-methods` answers 404 while `PLANDAY_ENABLED=false`.

### Stage 6 — Rota-source onboarding and the wizard

- **6A (server)** ∥ **6B (UI)**; the API contracts are fixed by stage 1.
  - 6A owns `server/organisations/{service,repository,mappers,index}.ts` (+ `organisations.test.ts`: checklist
    copy with both Planday availability rows), `app/api/organisations/current/rota-source/route.ts`,
    `server/integrations/planday/{onboarding.service,preview.service,starterPolicies}.ts` (release of session
    imports, Finish superseding a wizard run, sample-time confirmation), `app/api/integrations/[provider]/
onboarding/**`, `test/integration/planday/onboardingWizard.test.ts`.
  - 6B owns `app/(dashboard)/onboarding/**`, `app/(dashboard)/connect/planday/page.tsx`,
    `components/onboarding/**` (rota-source cards reading Planday's availability, `planday/` step components
    including the reusable `connect-form.tsx` with a `returnTo` prop, wizard frame with stepper and Mock badge,
    poster), `hooks/use-planday-onboarding.ts`, `hooks/use-planday-runs.ts` (`useSyncRun`, 7.11),
    `components/realtime/realtime-model.ts` (+ test: the four event types, keys from `integration-keys.ts`),
    `components/auth/{create-organisation-form.tsx (redirect), accept-invite-panel.tsx (validated next)}`,
    `components/overview/{onboarding-checklist.tsx, rota-source-prompt.tsx, overview-page.tsx (mounts the
rota-source prompt), index.ts}`, `config/navigation.ts` (+ `navigation.test.ts`: routes and
    `getPostAuthRedirect`), render tests.
- Gate G. Commit "Planday: rota-source onboarding and setup wizard". Gate D. This stage is the first visible change:
  new organisations are asked "How do you schedule your team?", with Planday shown as Coming soon (Notify me, then
  CSV) while `PLANDAY_ENABLED=false`, so nothing leads to a Planday route that answers 404. Stage checks (optional
  owner spot-check): a throwaway organisation lands on the question; "Spreadsheet or another system" leads to the
  CSV import; Planday leads to Notify me and the CSV import; the throwaway is cleaned up.

### Stage 7 — Integrations page, health banner and managed-record UI

- **7A** ∥ **7B**.
  - 7A owns `components/integrations/**` except `integration-keys.ts` (Planday card with the Paused state,
    reconnect panel, settings drawer, history, pending queue with the new reasons, disconnect dialog, connect links
    with the email field, view model and tests), `app/(dashboard)/integrations/page.tsx` (opens the reconnect panel
    for `?planday=reconnect`), `hooks/use-planday.ts`, `components/overview/integration-status-card.tsx`.
  - 7B owns `components/shell/{dashboard-shell.tsx,integration-health-banner.tsx}`, `components/employees/**`
    (lock UI, source badge; email unlocked when `importEmails` is off), `components/schedule/**` (Planday badge,
    read-only drawer), `components/locations/**` (managed names), `components/activity/**` (compliance badge, new
    activity types), `components/status/**` (new badge kinds), `components/settings/**` (the "always sent for a
    broken connection" note on the `INTEGRATION_ERROR` preference row, D-055),
    `components/overview/pending-employees-prompt.tsx`.
- **Closing step (lead)**: mount `PendingEmployeesPrompt` in `components/overview/overview-page.tsx` and export it
  from `components/overview/index.ts` (both owned by 6B in stage 6; no parallel agent edits them in stage 7).
- Gate G. Commit "Planday: Integrations page, health banner and managed-record UI". Gate D. Stage checks: common
  checks (nothing renders differently while no integration exists).

### Stage 8 — Documentation, help, end-to-end verification and release

- **8A (docs + help)** ∥ **8B (e2e)**.
  - 8A owns every file in section 14 except the e2e (help page, `components/help/planday/**`,
    `public/help/planday/README.md`, the `docs/**` files listed there; never `docs/DESIGN_SYSTEM.md` or
    `docs/design-tokens.json`).
  - 8B owns `apps/web/e2e/planday-onboarding.spec.ts` and `apps/web/playwright.config.ts` (13.4), and fixes the
    defects the run finds (reported to the stage lead when they touch another stage's files).
- **Closing step (lead)**: rewrite `PROVIDERS.PLANDAY.description` in `packages/shared/src/providers/registry.ts`
  in the present tense (no "Will sync"); full Gate G plus `pnpm --filter @clockoff/web test:e2e` (both specs);
  re-read the spec §15 table (1.3) and tick each line with its evidence in the stage report. Commit "Planday:
  documentation, help article and end-to-end test". Gate D (still dark).
- **Release (owner-gated)**:
  1. The owner sets `PLANDAY_ENABLED=true` on both services (`railway variable set --service web
PLANDAY_ENABLED=true`, then `--service worker`; each change redeploys that service). `PLANDAY_MODE` stays
     unset (live), `PLANDAY_CLOCK_MODE_ENABLED` unset (false); `PLANDAY_CLIENT_ID` and `PLANDAY_APP_ID` (web) only
     once the Planday apps exist and, for B, Planday has confirmed (STATUS.md checklist). Verify live: `/api/health`
     as in Gate D; at the next quarter hour the worker logs `integrations-sync` with `availableProviders: 1`;
     `integrations-upkeep` stays `ok`; the Integrations page shows Planday "Set up" with only method C offered (A
     and B hidden without their variables).
  2. **Demo-portal gate (hard; no real customer connects before it passes).** Connect a Planday demo portal with
     method C and complete the wizard. Record scrubbed fixtures (STATUS.md checklist step 3): a published shift
     across a DST change in a zone that observes DST, a shift starting within an hour of midnight, a draft before
     and after publishing, a hidden day, the portal and shift `timeZone` values. Compare ClockOff's stored instants
     with the times Planday shows, and confirm the `date` cross-check (4.8) passes on real data. Write the answers
     to notes §12 Q11, Q27, Q28, Q29, Q33 and Q35 into `PLANDAY_API_NOTES.md`; if any differs from the provisional
     rules, the fix ships (with the recorded fixture as a test) before step 3. The owner records D-040 and D-042.
  3. The customer connects with their own app (method C): the proof succeeds; the worker logs
     `integration slice finished` for the STRUCTURE, DIRECTORY, IMPORT_EMPLOYEES and first SYNC runs; the wizard
     shows live progress, the step 6 sample times are confirmed against Planday, and it completes; within 15
     minutes a SCHEDULED run appears in the card's History.
  4. Update the `docs/STATUS.md` rows with the commit and the observed results.
  - Kill switch: `PLANDAY_ENABLED=false` on both services pauses everything Planday (routes 404, no runs claimed,
    queued runs wait) without touching data; connected organisations see the paused banner and a "Paused" card,
    not silence (8.3, 10.1).

## 16. Open questions: the safe behaviour without an answer

### 16.1 Notes §12, question by question

"Verify" names where the answer comes from: the demo portal (`apisupport@planday.com`, STATUS.md checklist step 3)
or Planday support. Until then the code behaves as stated. Most behaviours below are safe whatever the answer.
Three are not, because a wrong guess would put every shift at the wrong time: Q27 (date-time encoding), Q28
(`timeZone` format) and Q29 (DST). For those the code adds a runtime check (the `date` cross-check, 4.8) and a
manager check (wizard step 6 sample times), and the stage 8 demo-portal gate must answer them before a real
customer connects. Q33 and Q35 are also verified at that gate; the code's behaviour for them is safe either way.

| Q     | Open question (notes §12)                                      | Behaviour in code without the answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Verify             |
| ----- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| 1     | Client secret                                                  | None is sent or configured (`PLANDAY_CLIENT_SECRET` does not exist). If Planday demands one, method A's exchange fails with `PLANDAY_AUTH_FAILED`, the wizard says so and offers C; B and C are unaffected.                                                                                                                                                                                                                                                                                                       | demo               |
| 2     | PKCE                                                           | `PLANDAY_OAUTH_PKCE=false`: the documented exchange without `code_verifier`; the flag adds S256 only after a demo test.                                                                                                                                                                                                                                                                                                                                                                                           | demo               |
| 3     | Refresh rotation and refresh response fields                   | `refresh_token`, `expires_in` and `scope` are optional; a returned `refresh_token` is persisted in the same `UPDATE` as the access token before use; `expires_in` defaults to 3600; refresh 5 minutes early.                                                                                                                                                                                                                                                                                                      | demo               |
| 4     | Token and revocation error bodies                              | Keyed on status only; bodies are never parsed, logged or stored; the revocation result is logged as success or failure. Because `invalid_grant` cannot be told from another 400, an `AUTH_ERROR` from the token endpoint is re-probed automatically (5 min, 15 min, then hourly for 7 days, 7.9), so a transient identity-server error heals without the manager.                                                                                                                                                 | —                  |
| 5     | Does revoking the refresh token kill live access tokens?       | ClockOff-initiated: disconnect wipes the cached access token together with the refresh token, so ClockOff never uses either again, and a 401 a slice meets during the disconnect never becomes `AUTH_ERROR` (7.6). Customer-initiated (Revoke button): every SYNC run starts with a forced refresh grant (4.3), so revocation is detected within one 15-minute cycle even if live access tokens keep working; the mock tests both behaviours. A previous token of the same app is not revoked on reconnect (5.7). | demo               |
| 6     | New token for B and C after revocation or loss                 | Reconnect asks the admin to authorise again in Planday and paste the new Token, from the card's reconnect panel (10.1); the help article, banner and email link there; the portal id must match (5.7).                                                                                                                                                                                                                                                                                                            | demo               |
| 7     | Redirect URI matching                                          | One exact URL, built once from `APP_URL` and sent identically in authorize and exchange; no custom schemes.                                                                                                                                                                                                                                                                                                                                                                                                       | demo               |
| 8     | Token claims                                                   | Never read; the portal comes from `GET /portal/v1.0/info`; `id_token` is discarded unparsed.                                                                                                                                                                                                                                                                                                                                                                                                                      | —                  |
| 9     | Child portals                                                  | Only the token's own portal is synced; step 2 notes child portals; no request targets another portal.                                                                                                                                                                                                                                                                                                                                                                                                             | —                  |
| 10    | Approval gate; may customers use Connect App with our App ID?  | Method B stays hidden until the owner sets `PLANDAY_APP_ID`, which STATUS.md allows only after Planday confirms; method C needs no Planday involvement.                                                                                                                                                                                                                                                                                                                                                           | support            |
| 11    | Scope of `GET /portal/v1.0/info`                               | A 403 fails the connect with `PLANDAY_SCOPE_MISSING` ("portal info") and instructions; checked on a demo app with only the read scopes before the production app is created.                                                                                                                                                                                                                                                                                                                                      | demo               |
| 12    | Scope descriptions                                             | Method C instructions name the grid rows; demo-portal screenshots replace the placeholders.                                                                                                                                                                                                                                                                                                                                                                                                                       | demo               |
| 13    | Special-field scopes; omitted or null                          | `special` is never sent; the allow-list drops `ssn`, `bankAccount`, `birthDate` whether absent, null or empty; the sentinel scan proves nothing persists.                                                                                                                                                                                                                                                                                                                                                         | —                  |
| 14    | 20 or 10 requests per second per portal                        | Budget 10/s and 600 per 60 s per portal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | support            |
| 15    | `Retry-After` on 429                                           | Wait `x-ratelimit-reset`; the longer of the two when both are present; neither → 60 s; waits over 30 s park the run (7.10).                                                                                                                                                                                                                                                                                                                                                                                       | demo               |
| 16    | Per-endpoint and identity-server limits                        | The same 429 rule on `id.planday.com`; at most one token request in flight per integration (lease plus the in-process refresh promise).                                                                                                                                                                                                                                                                                                                                                                           | —                  |
| 17    | Punch Clock maximum `limit`; default 0                         | Always `limit=50`; `offset += data.length`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | —                  |
| 18    | Sort order                                                     | Upsert by id, de-duplicate per run; absence alone never cancels or deactivates; the next run catches anything missed.                                                                                                                                                                                                                                                                                                                                                                                             | —                  |
| 19    | Size of the unpaged membership endpoints                       | Not called: membership comes from `departments[]` and `employeeGroups[]` on `/employees`.                                                                                                                                                                                                                                                                                                                                                                                                                         | —                  |
| 20    | Excluding personal fields from responses                       | Not possible, so: allow-list parsing at the client boundary, no body logging, by-id employee reads capped at 20 per run, sentinel test.                                                                                                                                                                                                                                                                                                                                                                           | —                  |
| 21    | Is `email` a work address?                                     | Not assumed. Wizard step 1 says the address may be personal; the "Import email addresses" toggle (default pending owner decision D-042) decides whether it is stored; off → used in memory for matching only. `PLANDAY_DATA.md` states the caveat.                                                                                                                                                                                                                                                                | owner              |
| 22    | Do membership endpoints include deactivated employees?         | Not called.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | —                  |
| 23    | Future deactivation still on the active list                   | No action until `deactivationDate` has passed, also when the person is on both lists in one run (decided by the date; reactivation waits for the deactivation phases, 6.5).                                                                                                                                                                                                                                                                                                                                       | demo               |
| 24    | By-id read of a deactivated employee                           | Only `isDeactivated: true` (date passed) deactivates. 400, 404 or an active body → warning `EMPLOYEE_NOT_VISIBLE`, devices untouched, and after 24 h a `MISSING_IN_PLANDAY` review for the manager (6.5, D-045).                                                                                                                                                                                                                                                                                                  | demo               |
| 25    | Deleted departments; groups without a deleted flag             | Missing from a complete list → `upstreamRemovedAt` and a warning; never deleted.                                                                                                                                                                                                                                                                                                                                                                                                                                  | —                  |
| 26    | Serialisation of `special`                                     | Never sent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | —                  |
| 27    | Shift date-time encoding                                       | `Z` or an offset → instant; no offset → wall-clock in the shift's zone; all three encodings tested. Not safe if wrong (an hour off during summer time), so: the `date` cross-check fails a page whose `date` disagrees with the parsed local start (4.8), the manager confirms sample times at step 6, and the demo-portal gate is required before a real customer (section 15).                                                                                                                                  | demo (gate)        |
| 28    | `timeZone` format                                              | IANA only: a non-IANA shift zone skips the record (`INVALID_TIME`); a non-IANA portal zone blocks step 2 with a support message; no Windows mapping. Recorded at the demo-portal gate.                                                                                                                                                                                                                                                                                                                            | demo (gate)        |
| 29    | DST                                                            | Shared resolver (gap → shifted forward, overlap → first occurrence, warnings kept); at most 24 h of wall-clock time, so up to 25 h real time across a fall-back (D-049). A DST-crossing shift is recorded at the gate.                                                                                                                                                                                                                                                                                            | demo (gate)        |
| 30    | Zone of `dateTimeCreated` / `Modified` / `Deleted`             | `modifiedFrom` is not used (every SYNC re-reads the whole window); `deletedFrom` starts one day before `deletedShiftsCheckedAt`, which moves only when `DELETED_SHIFTS` completes (6.6); duplicates are idempotent.                                                                                                                                                                                                                                                                                               | —                  |
| 31    | Drafts when `shiftStatus` is omitted                           | `shiftStatus` is never sent; drafts are filtered client-side either way.                                                                                                                                                                                                                                                                                                                                                                                                                                          | demo               |
| 32    | Draft signal                                                   | `status == "Draft"` → excluded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | demo               |
| 33    | Status after publishing; back to draft                         | Notes §10.1 rule 1: any non-`Draft` status with an employee is imported, `Open` included, so a published draft is imported whether it reads back as `Open` or `Assigned`; only `employeeId == null` makes a shift unassigned (6.6). A synced shift that reads back as `Draft` is cancelled (removal `DRAFT`).                                                                                                                                                                                                     | demo (gate)        |
| 34    | Publish endpoint semantics                                     | Never called (read-only integration).                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | —                  |
| 35    | Hidden days                                                    | `respectHiddenDays` defaults **off** until the owner signs off notes §10.1 rule 3 and the gate confirms what `isVisible` means (D-040, owner decision). When on: future shifts on hidden days are cancelled and reinstated on unhide; an in-progress shift is never cancelled for it; a `scheduleDay` 400 or 404 for a department skips the filter for it in that run with warning `HIDDEN_DAYS_UNAVAILABLE`; 429 and 5xx follow the normal retry rules.                                                          | demo (gate), owner |
| 36    | Meaning of each status                                         | Imported: every documented non-`Draft` status (`Open`, `Assigned`, `Approved`, `ForSale`, `OnDuty`, `PendingSwapAcceptance`, `PendingApproval`, `Punchclock*`) when the shift has an employee (notes §10.1 rule 1); an undocumented value is skipped with a warning and never creates or cancels.                                                                                                                                                                                                                 | support            |
| 37    | Maximum `/shifts` range                                        | Requests cover the window plus one day on each side (at most 59 days); a 400 switches the phase cursor to 14-day slices.                                                                                                                                                                                                                                                                                                                                                                                          | demo               |
| 38    | What `from` / `to` filter on; overnight shifts                 | Query one day wider on each side; filter on computed instants.                                                                                                                                                                                                                                                                                                                                                                                                                                                    | demo               |
| 39    | Department time zone                                           | Locations get the portal zone; shifts keep their own zone.                                                                                                                                                                                                                                                                                                                                                                                                                                                        | —                  |
| 40–42 | Payroll scope; Scheduling version list; draft endpoint history | Not relevant: Payroll and draft endpoints are unused; the base path `v1.0` is fixed in `constants.ts`.                                                                                                                                                                                                                                                                                                                                                                                                            | —                  |
| 43    | Punch Clock time zone; "today"                                 | No offset → wall-clock in the matched shift's zone, else the portal zone; `/employeeshifts/today` is not called.                                                                                                                                                                                                                                                                                                                                                                                                  | demo (Beta)        |
| 44    | Punch Clock window semantics                                   | Overlapping window `now − 3 h` to `now + 1 h` every 2 minutes; idempotent on the external id.                                                                                                                                                                                                                                                                                                                                                                                                                     | demo (Beta)        |
| 45    | `endDateTime == null`                                          | Means "no punch-out yet" for reconciliation; only a non-null punch-out can end a shift early.                                                                                                                                                                                                                                                                                                                                                                                                                     | demo (Beta)        |
| 46    | Punch latency                                                  | Stated plainly in PLANDAY.md; the Beta flag is off by default; scheduled activation stays the fallback.                                                                                                                                                                                                                                                                                                                                                                                                           | —                  |
| 47    | `deviceCode`                                                   | Unused (write endpoints only).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | —                  |
| 48    | Webhooks                                                       | Polling only: quarter-hour SYNC runs, 2-minute CLOCK runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                        | —                  |
| 49    | Versioning policy                                              | A changed response fails Zod → `PLANDAY_INVALID_RESPONSE`: the run fails without writing that page, the card shows the error, `DEGRADED` follows after 60 minutes.                                                                                                                                                                                                                                                                                                                                                | —                  |
| 50    | Base URL                                                       | Constants from the guides: `https://openapi.planday.com`, `https://id.planday.com`.                                                                                                                                                                                                                                                                                                                                                                                                                               | —                  |
| 51    | Sandbox                                                        | Demo portals for manual checks; Mock Planday for every automated test.                                                                                                                                                                                                                                                                                                                                                                                                                                            | —                  |
| 52    | Retention and GDPR on Planday's side                           | ClockOff's own retention (PLANDAY_DATA.md): staging purged at Finish, abandon and disconnect; runs kept 90 days; secrets wiped on disconnect.                                                                                                                                                                                                                                                                                                                                                                     | —                  |

### 16.2 Platform and implementation risks

| Risk                                                                                                             | Handling                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The per-client-id budget (methods A and B share ClockOff's App ID) is enforced per process                       | Nearly all traffic is the single worker replica's; web adds only connect proofs. If the worker is scaled out or A/B customers grow, move the client-id window into Postgres (16.3).                                                                                                                  |
| The worker's Prisma pool size (`connection_limit` in the shared `DATABASE_URL`) is not visible in the repository | The runner caps its concurrency from it and logs it (7.5); stage 4's checks ask the owner to raise it if it is below 4.                                                                                                                                                                              |
| Planday rotates a refresh token and ClockOff dies before its `UPDATE` commits                                    | The stored token may be dead: the next refresh gets 400 → `AUTH_ERROR` → red banner, email, reconnect. Unavoidable without documentation; shutdown never aborts token requests (7.7).                                                                                                                |
| A lease holder pauses longer than 90 s while still alive                                                         | Fencing in every write transaction and in the credential `UPDATE`: it can no longer write; the new holder resumes from the last cursor.                                                                                                                                                              |
| NOTIFY is lost (listener reconnect, stream rotation, deploy)                                                     | Progress events are hints; runs and the card fall back to polling; the runner polls every 10 s.                                                                                                                                                                                                      |
| A deploy cuts a connect proof                                                                                    | Draining web refuses new proofs and a running one is bounded by `SHUTDOWN_GRACE_MS − 2 s` (5.6), so this needs a stalled database. Nothing is persisted before the proof's last step; the manager connects again. For method A the authorisation code is spent, so the OAuth round trip is repeated. |
| Neon free-plan compute (worker keeps it awake)                                                                   | Existing risk recorded in `docs/STATUS.md`; the runner's poll adds one indexed query every 10 s.                                                                                                                                                                                                     |
| Revoking one refresh token of an app might end every grant of that app on the portal (undocumented, Q5)          | ClockOff revokes a previous token on reconnect only when its client id differs from the new one (5.7); the demo-portal gate checks whether same-app revocation is safe, after which the rule can be widened.                                                                                         |
| One Planday portal per ClockOff organisation (D-054)                                                             | A customer that runs two ClockOff organisations on one Planday portal is refused with `INTEGRATION_PORTAL_IN_USE`; if that need appears, the lease moves to a per-portal table and the index is dropped (16.3).                                                                                      |

### 16.3 Follow-ups after release

- A contract migration dropping `integration_connections.encrypted_credentials` once Planday has run in
  production for a while (the code stops reading it in stage 1; never in the same deploy as a reader).
- Record the demo-portal answers in `PLANDAY_API_NOTES.md` and retire the provisional rules they settle (the
  gate in section 15 does this for Q27 to Q29, Q33 and Q35 before the first customer).
- If a customer needs several ClockOff organisations on one portal: a `planday_portal_leases(portal_id)` lease row
  replaces the partial unique index of D-054.
- A Postgres-backed per-client-id request window if the worker is scaled out or methods A/B gain many portals.
- Planday partner certification (notes §3.1), needed only for a public listing.

## Appendix A — Environment variables

| Variable                     | Values and default                                                        | Services (`.railway/railway.ts`)               | Purpose and validation                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLANDAY_ENABLED`            | `true` / `false`; default `false` when `NODE_ENV=production`, else `true` | web + worker (`SHARED_VARIABLES`)              | Release switch and kill switch (D-044): registers the Planday provider. Off → Planday routes 404, the rota-source card and checklist offer Notify me and the CSV path, organisations with a live connection see the paused banner and a "Paused" card, both integration jobs report `NO_AVAILABLE_PROVIDER` (upkeep `PAUSED` when connections exist), the runner claims no Planday run; data stays. |
| `PLANDAY_MODE`               | `mock` / `live`; default `live` in production, `mock` otherwise           | web + worker (`SHARED_VARIABLES`)              | `mock` is refused in production: `parseEnv` throws, so the worker exits 1 and web fails its health check.                                                                                                                                                                                                                                                                                           |
| `PLANDAY_MOCK_URL`           | URL; default `http://127.0.0.1:4010` in `mock` mode outside tests         | development and Playwright only (never listed) | The shared mock server (12.1). Refused in production.                                                                                                                                                                                                                                                                                                                                               |
| `PLANDAY_MOCK_PORT`          | default `4010`                                                            | `apps/web/scripts/mock-planday.mts` only       | Port of the mock server.                                                                                                                                                                                                                                                                                                                                                                            |
| `PLANDAY_CLIENT_ID`          | ClockOff's App ID (UUID); unset                                           | web (`WEB_VARIABLES`)                          | Enables method A (authorize URL, code exchange). The worker never reads it: every connection stores its own encrypted client id.                                                                                                                                                                                                                                                                    |
| `PLANDAY_APP_ID`             | UUID; unset                                                               | web (`WEB_VARIABLES`)                          | Enables method B; shown to the customer (not a secret). Set only after Planday support confirms (16.1 Q10).                                                                                                                                                                                                                                                                                         |
| `PLANDAY_CLOCK_MODE_ENABLED` | `true` / `false`; default `false`                                         | web + worker (`SHARED_VARIABLES`)              | Beta clock-in mode: wizard step 8 option, `CLOCK` runs, the `punchclockshift:read` probe.                                                                                                                                                                                                                                                                                                           |
| `PLANDAY_OAUTH_PKCE`         | `true` / `false`; default `false`                                         | web (`WEB_VARIABLES`)                          | S256 PKCE on method A after the demo-portal test (16.1 Q2).                                                                                                                                                                                                                                                                                                                                         |
| `INTEGRATION_ENCRYPTION_KEY` | existing (32 random bytes, base64)                                        | web + worker (already shared)                  | AES-256-GCM for integration secrets with per-column AAD (4.3.1) and the HKDF key of `lastHash` (6.2).                                                                                                                                                                                                                                                                                               |

Existing variables the integration relies on: `DATABASE_URL` (its `connection_limit` sizes the runner, 7.5),
`DIRECT_URL` (the event bus and the worker's lock session), `SHUTDOWN_GRACE_MS` (7.7), `WORKER_JOBS_ENABLED` (also
pauses the runner), `APP_URL` (redirect URI, links), `SESSION_SECRET` (OAuth state HMAC key derivation),
`DEV_TOOLS_ENABLED` (mock control route), `REALTIME_STREAM_MAX_LIFETIME_MS` (SSE rotation, 7.11).

Not added: `PLANDAY_CLIENT_SECRET` (notes §3.4), `INTEGRATION_EXECUTOR` and `CRON_SECRET` (the Netlify design;
`CRON_SECRET` is retired and only warned about by `parseEnv`). `turbo.json` `globalPassThroughEnv` gains
`PLANDAY_ENABLED`, `PLANDAY_MODE`, `PLANDAY_MOCK_URL`, `PLANDAY_CLIENT_ID`, `PLANDAY_APP_ID`,
`PLANDAY_CLOCK_MODE_ENABLED` and `PLANDAY_OAUTH_PKCE`.

## Appendix B — Audit actions

Written with `writeAudit` in the same transaction as the change, actor = the manager. `before` / `after` never
contain a token, App ID, code, state value or Planday personal data. Worker-side transitions (health, runs) are not
audited; they produce activity rows and notifications instead (spec §10 audits manager actions). The one worker-side
audit row is `integration.conflicting_shift_replaced`, because it carries out a manager's explicit choice on a
manager's own shift.

| Action                                   | Entity                   | When                                                                                                                                                                          | `before` / `after`                                                                                |
| ---------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `organisation.rota_source_set`           | organisation             | `PUT …/rota-source`                                                                                                                                                           | `{ rotaSource, otherText }`                                                                       |
| `integration.connected`                  | integration              | first successful connect                                                                                                                                                      | after `{ method, portalId, portalName }`                                                          |
| `integration.reconnected`                | integration              | reconnect to the same portal                                                                                                                                                  | after `{ method, portalId, readopted: { employees, locations, teams, shifts }, revokedPrevious }` |
| `integration.connect_failed`             | integration              | a failed proof (also counted by the paste rate limit, 5.4)                                                                                                                    | after `{ method, errorCode }`                                                                     |
| `integration.disconnected`               | integration              | disconnect                                                                                                                                                                    | after `{ mode, revokedAtPlanday, cancelledShifts }`                                               |
| `integration.portal_switched`            | integration              | mappings reset to connect a different portal (5.7)                                                                                                                            | `{ previousPortalId }` / `{ portalId }`                                                           |
| `integration.mappings_saved`             | integration              | wizard steps 3 and 4                                                                                                                                                          | department and group mappings, included department ids                                            |
| `integration.employees_selected`         | integration              | wizard step 5                                                                                                                                                                 | counts selected, excluded and linked; `autoIncludeNewEmployees`                                   |
| `integration.settings_updated`           | integration              | settings drawer save, activation mode                                                                                                                                         | the `PlandaySettings` fields that changed                                                         |
| `integration.sync_requested`             | integration              | Sync now, `retryAuth`                                                                                                                                                         | after `{ runId, alreadyRunning, followUpQueued, retryAuth }`                                      |
| `integration.onboarding_completed`       | integration              | wizard Finish                                                                                                                                                                 | after `{ runId, employees, locations, teams, conflictsToReplace }`                                |
| `integration.conflicting_shift_replaced` | shift                    | the INITIAL SYNC cancels a ticked conflict as its Planday replacement is created (6.6); written by the worker on behalf of the manager who finished (`run.requestedByUserId`) | before `{ status }` / after `{ status: "CANCELLED", replacedByExternalShiftId }`                  |
| `integration.pending_employee_resolved`  | integration              | each pending-queue item resolved                                                                                                                                              | after `{ externalId, action, employeeId }`                                                        |
| `integration.connect_link_created`       | integration_connect_link | link created                                                                                                                                                                  | after `{ expiresAt, invited }` (never the email: the invite has its own `member.invited` row)     |
| `integration.connect_link_used`          | integration_connect_link | link resolved by an OWNER/ADMIN                                                                                                                                               | after `{ useCount }`                                                                              |
| `integration.connect_link_revoked`       | integration_connect_link | link revoked                                                                                                                                                                  | none                                                                                              |
| `integration.notify_requested`           | integration              | existing (Coming soon cards)                                                                                                                                                  | unchanged                                                                                         |

## Appendix C — Decisions to record in `docs/DECISIONS.md`

Numbers assume `DECISIONS.md` ends at D-029 (checked 2026-10-08: D-023 to D-029 record the Railway move, among
them D-024, the worker with one advisory lock and one slot claim per job, and D-025, realtime over LISTEN/NOTIFY).
If more entries land first, stage 1 renumbers these by the same offset and updates this plan's references in the
same commit.

| ID    | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Sections          |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| D-030 | Provider-agnostic core, the Planday client and the mock live in a new workspace package, `@clockoff/integrations`, free of Prisma, Next.js and pino; web adapts it.                                                                                                                                                                                                                                                                                                                                                    | 3.1, 3.2          |
| D-031 | Every sync executes in the worker: web services and the worker's jobs enqueue `IntegrationSyncRun` rows; the worker's integration runner claims them and runs resumable slices; there is no HTTP job endpoint. Replaces the Netlify background-function design of 2026-10-07.                                                                                                                                                                                                                                          | 7.1 to 7.6        |
| D-032 | Runs are resumable: phases with cursors written in the same transaction as each page's writes; replaying a step is a no-op.                                                                                                                                                                                                                                                                                                                                                                                            | 6.1, 7.6          |
| D-033 | Deactivation follows Planday: deactivated or removed employees are soft-deactivated with device and token revocation, never hard-deleted.                                                                                                                                                                                                                                                                                                                                                                              | 6.5               |
| D-034 | Overlapping Planday shifts are created and flagged `CONFLICT`; onboarding offers to replace overlapping manual and CSV shifts.                                                                                                                                                                                                                                                                                                                                                                                         | 6.6               |
| D-035 | The activation mode lives on `Integration.activationMode` (the spec's `IntegrationMappingConfig.activation_mode`).                                                                                                                                                                                                                                                                                                                                                                                                     | 2.3               |
| D-036 | Expand-only migrations: existing columns reused through `@map`; `encrypted_credentials` kept nullable until a later contract migration.                                                                                                                                                                                                                                                                                                                                                                                | 2.1               |
| D-037 | Mock Planday is ClockOff's own fetch-level fake (no MSW), served over HTTP in development and Playwright so web and worker share its state; it cannot run in production.                                                                                                                                                                                                                                                                                                                                               | 12                |
| D-038 | Integration secrets use AES-256-GCM with per-column associated data `integration:<id>:<column>`.                                                                                                                                                                                                                                                                                                                                                                                                                       | 4.3.1             |
| D-039 | No client secret; PKCE stays off until verified on a demo portal (`PLANDAY_OAUTH_PKCE`).                                                                                                                                                                                                                                                                                                                                                                                                                               | 4.3, 5.2, 16      |
| D-040 | **Owner decision** (notes §10.1 rule 3 is "pending product sign-off"). Question: should ClockOff skip published shifts on days Planday hides from employees? Plan default until the owner answers and the demo-portal gate confirms what `scheduleDay.isVisible` means: `respectHiddenDays = false`. When on, future shifts on hidden days are cancelled and reinstated on unhide, an in-progress shift is never cancelled for it, and the filter is skipped for a department whose `scheduleDay` read is unavailable. | 2.4, 6.6, 16      |
| D-041 | Shift statuses: every documented non-`Draft` status with an employee is imported (notes §10.1 rule 1, `Open` included); `employeeId == null` is unassigned whatever the status; undocumented statuses are skipped with a warning and never create or cancel a synced shift.                                                                                                                                                                                                                                            | 6.6               |
| D-042 | **Owner decision** (spec §8 keeps the work email and strips private email; notes §12 Q21: Planday's `email` may be personal). Question: should ClockOff store Planday's `email` by default? Plan default: the "Import email addresses" toggle (wizard step 5, settings) defaults on, the wizard says the address may be personal, and with it off the address is used in memory for matching only and never stored.                                                                                                    | 2.4, 6.5, 9.5, 16 |
| D-043 | One per-portal row lease (database clock, holder uuid as fencing token) serialises every Planday request stream across web and worker; no database transaction spans a Planday call; token refresh is persisted by a version- and lease-guarded `UPDATE`.                                                                                                                                                                                                                                                              | 4.3, 7.4          |
| D-044 | `PLANDAY_ENABLED` dark-launches Planday so every stage can deploy, and remains the kill switch after release.                                                                                                                                                                                                                                                                                                                                                                                                          | 0, 15, A          |
| D-045 | Absence alone never cancels a shift or deactivates an employee. A shift needs the deleted list or a by-id 404 (notes §8). An employee needs positive evidence: the deactivated list or `isDeactivated: true` by id, with `deactivationDate` passed; a by-id 400 or 404 only warns (`EMPLOYEE_NOT_VISIBLE`) and, after 24 h, asks the manager (`MISSING_IN_PLANDAY`).                                                                                                                                                   | 6.5, 6.6          |
| D-046 | Rate limits budget the lower documented figures (10/s and 600/min per portal; 50/s and 1500/min per client id); 429 waits follow `x-ratelimit-reset` (the longer of it and `Retry-After`), default 60 s; waits over 30 s park the run.                                                                                                                                                                                                                                                                                 | 4.5, 7.10         |
| D-047 | Scheduled syncs run on quarter-hour slots with a deterministic 0–119 s per-integration jitter, created by the existing `integrations-sync` job; recovery, clock and catch-up runs come from the per-minute `integrations-upkeep` job.                                                                                                                                                                                                                                                                                  | 7.8, 7.9          |
| D-048 | Sync progress reaches dashboards as `integration.sync.progress` hints on the Postgres event bus (SSE), with polling as the fallback; payloads carry no personal data.                                                                                                                                                                                                                                                                                                                                                  | 7.11              |
| D-049 | A shift may last at most 24 h of wall-clock time, so up to 25 h of real time across a DST fall-back.                                                                                                                                                                                                                                                                                                                                                                                                                   | 4.8               |
| D-050 | External ids written by the Planday sync are portal-qualified: `PLANDAY:<portalId>:<id>` for employees and shifts, `<portalId>:<id>:<suffix>` for clock events; a raw CSV id matches only with email or name corroboration.                                                                                                                                                                                                                                                                                            | 2.6, 6.5          |
| D-051 | `SYNC` and `CLOCK` runs require wizard Finish (`onboardingCompletedAt`); wizard runs never count as sync failures or schedule recovery; a request made while another kind of run is active waits in a one-slot pending queue instead of being dropped.                                                                                                                                                                                                                                                                 | 7.2, 7.3, 7.6     |
| D-052 | Idempotency hashes cover the decision inputs (record, classification, resolved targets), not a global mapping version; a hash change with no visible change is `REHASH_ONLY` (no version bump); a sync-cancelled shift is never short-circuited.                                                                                                                                                                                                                                                                       | 6.2, 6.6          |
| D-053 | A same-portal reconnect after a disconnect re-adopts the mapped ClockOff records and re-decides every record; a different portal needs an explicit "Use a different portal" from `DISCONNECTED`.                                                                                                                                                                                                                                                                                                                       | 5.7               |
| D-054 | One live, non-mock connection per Planday portal across all organisations (partial unique index), which makes the per-connection lease a per-portal lease.                                                                                                                                                                                                                                                                                                                                                             | 2.5, 7.4          |
| D-055 | The auth-error alert (email and in-app notification to every OWNER and ADMIN) is transactional and ignores opt-outs (spec §6); `AUTH_ERROR` is re-probed automatically (5 min, 15 min, then hourly for 7 days).                                                                                                                                                                                                                                                                                                        | 7.9, 8.4          |
| D-056 | Every id in a request body (location, department, team, employee, policy, shift) is checked against the caller's organisation when saved, and worker writers filter by the run's organisation as well.                                                                                                                                                                                                                                                                                                                 | 9.2, 11           |

## Review log

### Review 1 (2026-10-08): correctness and platform/security/UX lenses

Each finding was checked against the spec, the notes and the code (`apps/web/src/worker/*`,
`server/integrations/{integrations.service,scheduledSync}.ts`, `[provider]/connect/route.ts`,
`packages/shared/src/providers/registry.ts`, `server/employees/employeeAccess.ts`, `schema.prisma`,
`server/organisations/members.ts`, `config/navigation.ts`, `server/lifecycle/webShutdown.ts`,
`server/health/workerHeartbeat.ts`, `components/integrations/use-integrations.ts`,
`components/overview/overview-page.tsx`). C = correctness lens, P = platform/security/UX lens. Findings C1 and P1,
C7 and P16, and C12 and P4 describe the same defect and share one change.

| #   | Sev.   | Finding                                                                                                                 | Verdict  | What changed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------ | ----------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | high   | A SYNC can run before Finish (FINALISE follow-up, recovery, `/sync`); a run of another kind silently swallows a request | accepted | Onboarding gate for `SYNC`/`CLOCK` in `enqueueRun`, the slice, upkeep and `/sync` / settings (7.3, 7.6, 7.9, 7.10; 409 `INTEGRATION_ONBOARDING_INCOMPLETE`); FINALISE follow-ups are of the run's own kind (DIRECTORY → DIRECTORY, 7.2); wizard runs never touch the failure count or schedule recovery (7.6); one-slot pending queue on the connection with outcomes `QUEUED` / `ALREADY_RUNNING` / `FOLLOW_UP_QUEUED` / `REFUSED`, drained by FINALISE and `failRun` (2.3, 7.2, 7.3); Finish supersedes an active wizard run (9.5); tests in `onboardingWizard` and `runQueue` (13.2); D-051. |
| C2  | high   | `status: "Open"` with an employee treated as unassigned, against notes §10.1/§10.2                                      | accepted | Unassigned only when `employeeId === null`; `Open` joins the published allow-list (every documented non-`Draft` status, notes rule 1); undocumented statuses still never create or cancel (6.6, D-041, Q33/Q36); classifier tests for both `Open` cases (13.1).                                                                                                                                                                                                                                                                                                                                 |
| C3  | high   | The hash short-circuit prevents reinstatement (hidden day, deactivation, X → Y → X, settings save)                      | accepted | Hash over decision inputs (record, class, resolved targets, hidden-day flag), no global `mappingVersion` (6.2, 2.4); never short-circuit a sync-cancelled shift that is published again; incoming hash written on cancel; `REHASH_ONLY` outcome (6.2, 6.6 row 4a); mapped `INACTIVE` employees keep their shifts, matching `employeeAccess.ts` (6.5, 6.6); idempotency cases added (6.2, 13.2); D-052.                                                                                                                                                                                          |
| C4  | high   | Reconnecting the same portal after a disconnect leaves records unmanaged and shifts cancelled                           | accepted | Re-adoption in the connect transaction: managed flags restored for live mapped entities, map rows of deleted ones dropped, non-ended cancelled shifts marked `upstreamRemovedAt`, every `lastHash` nulled (5.7); `CANCEL_FUTURE_SHIFTS` marks map rows too (5.8); reconnect tests for both modes and edits made while disconnected (13.2); D-053.                                                                                                                                                                                                                                               |
| C5  | high   | Namesakes on different pages can be auto-merged                                                                         | accepted | Wizard: `EMPLOYEES` only stages, the database-only `MATCH_EMPLOYEES` phase matches over the complete staged set with `plandayNameCounts` (6.5, 7.2). SYNC: a name-only match never auto-links, it becomes `POSSIBLE_MATCH` (new reason, 2.2, 6.5, 10.4). The HMAC name census in the cursor was not needed. Tests with `capPageSize(1)` and `fixtureNamesake` (12.3, 13.2).                                                                                                                                                                                                                     |
| C6  | medium | A portal switch collides on `PLANDAY:<id>` external ids                                                                 | accepted | Portal-qualified ids for employees, shifts and clock events (2.6, D-050); rule 2a accepts only the current portal's ids (6.5); switch test with overlapping ids 4100001 → 4100002 (13.2).                                                                                                                                                                                                                                                                                                                                                                                                       |
| C7  | medium | A raw CSV employee id equal to a Planday id auto-links and overwrites the person                                        | accepted | Raw-id match needs email or exact-name corroboration; otherwise "possible match: confirm" in the wizard and `POSSIBLE_MATCH` after onboarding (6.5); `fixtureCsvCollision` test (12.3, 13.2). Same change for P16.                                                                                                                                                                                                                                                                                                                                                                              |
| C8  | medium | A by-id 400/404 deactivates the employee and revokes devices (notes §8 says skip; Q24 open)                             | accepted | Deactivation only on positive evidence (deactivated list or `isDeactivated: true` with the date passed); 400/404 → `EMPLOYEE_NOT_VISIBLE`, `upstreamMissingSince`, and after 24 h a `MISSING_IN_PLANDAY` review with Deactivate / Keep (2.4, 6.5, 7.9 step 7, 10.4); D-045 and Q24 rewritten; 4.6 table updated.                                                                                                                                                                                                                                                                                |
| C9  | medium | A future-dated dismissal deactivates early or flaps every 15 minutes                                                    | accepted | `deactivationDate` > now → `DEACTIVATION_SCHEDULED` warning, no change; reactivation deferred to the `REACTIVATIONS` phase after the deactivation phases (6.5, 7.2); mock `deactivateEmployee({ effectiveDate, stayOnActiveList })` and a two-syncs-no-change test (12.4, 13.2); Q23 updated.                                                                                                                                                                                                                                                                                                   |
| C10 | medium | REINSTATE gives the shift back to the old employee                                                                      | accepted | Row 15 applies the full incoming target (employee, location, times) with `SCHEDULE_CHANGED` for both employees (6.6); `reinstateIntegrationShift` signature (6.9); A → Y → C test (13.2).                                                                                                                                                                                                                                                                                                                                                                                                       |
| C11 | medium | The hidden-day filter is on by default although notes rule 3 is pending sign-off                                        | accepted | `respectHiddenDays` defaults to false; an in-progress shift is never cancelled for a hidden day (row 14a); D-040 is an owner decision; Q35 updated; wizard and settings copy follow (2.4, 6.6, 9.5, 10.2).                                                                                                                                                                                                                                                                                                                                                                                      |
| C12 | medium | A slice racing a disconnect can set `AUTH_ERROR`, email everyone, or bump failure counts                                | accepted | Every terminal and status write of a slice goes through the fenced transaction; connection writes are compare-and-set on status and the `credential_version` the slice knows; `CredentialsWipedError`; disconnect clears the lease and publishes `integration.run.cancelled` (2.2, 4.3, 5.8, 7.5, 7.6); race test in `disconnect.test.ts`. Same change for P4.                                                                                                                                                                                                                                  |
| C13 | medium | Detecting a customer-side Revoke depends on undocumented Q5                                                             | accepted | Forced refresh grant in every SYNC's `PORTAL_CHECK` (4.3, 7.2); mock `revokeRefreshToken({ keepAccessTokens })`; health test for that variant (12.4, 13.2); Q5 rewritten.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| C14 | medium | Shift time encoding (Q27) need not be verified before a customer goes live                                              | accepted | Hard demo-portal gate in the release (section 15 release step 2, STATUS.md checklist); runtime `date` cross-check failing a page with `TIME_ENCODING_MISMATCH` (4.6, 4.8); step 6 sample-time confirmation (9.5); 16.1 header and Q27–Q29 rows corrected.                                                                                                                                                                                                                                                                                                                                       |
| C15 | low    | Null `paging` stops at the first short page                                                                             | accepted | Requested limit is never a stop condition; null paging continues to an empty page; `paging.total` otherwise (4.4); `setPagingNull` mock control and tests (12.2, 12.4, 13.1, 13.2).                                                                                                                                                                                                                                                                                                                                                                                                             |
| C16 | low    | The persistence-failure test expects an impossible outcome; a DB blip throws away a rotated token                       | accepted | Guarded `UPDATE` retried with the same in-memory credentials (3 attempts, ≤ 5 s) on transient errors; the test asserts the real end states per mock behaviour (4.3); 7.7 worst case updated.                                                                                                                                                                                                                                                                                                                                                                                                    |
| C17 | low    | No behaviour for a portal without departments                                                                           | accepted | Pseudo-department `"none"` ("Not in any department") for empty `departments[]` and `departmentId: null` (2.4, 6.3, 6.5, 6.6, 9.5 step 3); mock portal 4100003 without departments (12.3).                                                                                                                                                                                                                                                                                                                                                                                                       |
| C18 | low    | The minimisation test misses out-of-scope people; punch records are not filtered by department                          | accepted | `CLOCK_EVENTS` drops records outside included departments or unmapped employees (6.8); test extended to names, emails and ids of 1010, 1011 and an unticked employee, and to clock events (13.2).                                                                                                                                                                                                                                                                                                                                                                                               |
| C19 | low    | D-042 decides on its own that Planday's `email` is a work email                                                         | accepted | D-042 is an owner decision; step 1 discloses the address may be personal; "Import email addresses" toggle in step 5 and settings, with in-memory-only matching when off (2.4, 6.5, 9.5, 10.2); Q21 updated.                                                                                                                                                                                                                                                                                                                                                                                     |
| C20 | low    | The deleted-shift watermark moves even when `DELETED_SHIFTS` did not finish                                             | accepted | Separate `deletedShiftsCheckedAt`, moved only when the phase completes, with a one-day overlap (2.3, 6.6, 7.2); Q30 updated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| P1  | high   | Full SYNC runs before Finish bypass step 5                                                                              | accepted | See C1 (also: reconnect during onboarding re-queues only the wizard kind it needs, 5.6).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| P2  | high   | No reconnect path once onboarding is complete                                                                           | accepted | Reconnect panel on the card (`/integrations?planday=reconnect`) reusing the wizard's connect form, with "Try again" and "Use a different portal" (10.1); `reconnectHref()` for banner, email, notification and connect link (8.3, 9.3, 9.7); explicit `allowPortalSwitch` (5.2, 5.7); e2e step 11 (13.4).                                                                                                                                                                                                                                                                                       |
| P3  | high   | The generic `POST /api/integrations/:provider/connect` would accept unverified codes for Planday                        | accepted | The generic route and `connectIntegration` answer 404 `CONNECT_METHOD_UNAVAILABLE` for Planday (section 5, 5A ownership); `PlandayProvider.connect()` accepts only `PlandayConnectCredentials` with a `VerifiedAuthorizationCode` produced by `consumeOAuthState` and never returns `REDIRECT_REQUIRED` (3.3, 5.2); tests (13.1, 13.2); section 11 row.                                                                                                                                                                                                                                         |
| P4  | medium | Unconditional status and terminal writes race disconnect, reconnect and FINALISE                                        | accepted | See C12; plus health transitions compare-and-set on the `status` and `last_sync_at` they read (7.9 step 1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| P5  | medium | Hundreds of per-row writes in one 10 s transaction; `mappingVersion` in every hash                                      | accepted | Page limit 100 for `/shifts` and `/shifts/deleted`, so a step never applies more than 100 records; batched `UPDATE … FROM (VALUES …)` and `createMany` (4.4, 6.1, 6.9); hash without `mappingVersion` and `REHASH_ONLY` (see C3); 500-changed-shifts statement-count test (13.2). A `{ offset, indexInPage }` cursor was rejected: list order is undocumented (notes §7), so an index into a re-fetched page could skip records.                                                                                                                                                                |
| P6  | medium | Ids inside request bodies are not checked against the organisation                                                      | accepted | Rule for every body id, worker writers filter by the run's organisation (9.2, 6.9, 11); body-id tenant cases (13.2); D-056.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| P7  | medium | `retryAuth` has no column, does not restore `CONNECTED`, and breaks the alert dedupe                                    | accepted | `retry_auth` column (2.4); only such runs start on `AUTH_ERROR`; a successful `PORTAL_CHECK` moves `AUTH_ERROR → CONNECTED` (7.2); every exit from `AUTH_ERROR` clears `authErrorNotifiedAt` (8.1, 8.4); tests (13.2).                                                                                                                                                                                                                                                                                                                                                                          |
| P8  | medium | One transient identity-server error stops every A/B customer until a manager acts                                       | partly   | Accepted: automatic auth probes (5 min, 15 min, then hourly for 7 days; one token request per hour at most) and an `INTEGRATION_RECOVERED` notification (7.9 step 3, 7.10, 8.4, D-055). Rejected: requiring two failures before `AUTH_ERROR`, because spec §6 asks for `AUTH_ERROR` immediately.                                                                                                                                                                                                                                                                                                |
| P9  | medium | Finish cancels conflicting shifts before their replacements exist                                                       | accepted | Ticked ids stored on the INITIAL run (`replace_shift_ids`); `cancelReplacedShift` cancels each one in the transaction that creates its overlapping Planday shift, never in-progress ones, nothing without a replacement; unresolved conflicts in the run summary (2.4, 6.6, 6.9, 9.5, appendix B).                                                                                                                                                                                                                                                                                              |
| P10 | medium | The connect link fails for a Planday admin who is not yet an ADMIN of the organisation                                  | accepted | "Send a connect link" takes an email and sends an ADMIN manager invite whose acceptance continues to the link (`next`, `safeConnectNext`, `getPostAuthRedirect`); non-admin landing message; `managerInviteId` on the link (2.4, 9.2, 9.7, 11); tests (13.2).                                                                                                                                                                                                                                                                                                                                   |
| P11 | medium | Dark launch and the kill switch give dead ends or silence                                                               | accepted | Rota-source card and checklist read Planday's availability and fall back to Notify me + CSV (9.4, 9.6); the health endpoint shows a "paused" banner and the card a "Paused" state under the kill switch (8.3, 9.2, 10.1, appendix A); tests (13.1, 13.2).                                                                                                                                                                                                                                                                                                                                       |
| P12 | medium | Stage ownership overlaps on query keys; `overview-page.tsx` owned by nobody                                             | accepted | Stage 1 creates `components/integrations/integration-keys.ts` (`integrationKeys` incl. `health`, `plandayKeys`) and re-exports from `use-integrations.ts` (7.11, stage 1); 6B owns `overview-page.tsx` and `components/overview/index.ts`; the stage 7 lead mounts the pending prompt; 7A excludes the keys file (section 15).                                                                                                                                                                                                                                                                  |
| P13 | low    | Priority 0 lets a long initial sync starve other portals                                                                | accepted | Priority applies to a run's first slice only; started runs compete at `GREATEST(priority, 3)` round-robin by `COALESCE(last_slice_at, created_at)` (2.4, 7.3); test (13.2). The reserved-slot alternative was not needed.                                                                                                                                                                                                                                                                                                                                                                       |
| P14 | low    | Nothing reports a stalled or failing integrations lane; upkeep budget exceeds the grace                                 | accepted | `worker.integrations` in `/api/health` from the upkeep job's `last_ok_at` and the lane's last pass (7.9 Monitoring), checked in Gate D from stage 4; upkeep budget 15 s with 5 s per step; the scheduler sets and aborts `ctx.signal` (7.9, 7.12, stage 4A).                                                                                                                                                                                                                                                                                                                                    |
| P15 | low    | CLOCK runs block "Sync now", flap `SYNCING` and refetch compliance                                                      | accepted | Pending slot turns "Sync now" and the quarter-hour slot into follow-ups during a `CLOCK` run (7.3, 7.8); `SYNCING` only for `SYNC` (7.6, 8.1); `integration.health.changed` only for banner-relevant transitions (7.11).                                                                                                                                                                                                                                                                                                                                                                        |
| P16 | low    | Raw-id match links without review after onboarding                                                                      | accepted | See C7.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| P17 | low    | Reconnect discards the old non-expiring token without revoking it                                                       | partly   | Accepted when the client id changes (for example C → A): the previous token is revoked best effort and audited (5.7, appendix B). Rejected for the same client id until the demo portal shows that revoking one token of an app leaves the app's new grant intact (undocumented, notes §12 Q5; 16.2).                                                                                                                                                                                                                                                                                           |
| P18 | low    | Two organisations can connect the same portal, so the "per-portal" lease is per connection                              | accepted | Partial unique index on live, non-mock `external_portal_id` → `INTEGRATION_PORTAL_IN_USE` (2.3, 2.5, 4.6, 7.4, 11, D-054); a lease table is the follow-up if several organisations per portal are ever needed (16.2, 16.3).                                                                                                                                                                                                                                                                                                                                                                     |
| P19 | low    | Wizard dead ends on `PARTIAL`; step 5 imports stay locked when departments are dropped or the session is abandoned      | accepted | Continue on `PARTIAL` with warnings, Retry on failure (9.5); `releaseOnboardingImports` on a step 3 re-save, abandonment and disconnect before Finish (9.3, 5.8, 7.9). Deferring the import to Finish was rejected: steps 6 and 9 need the imported employees.                                                                                                                                                                                                                                                                                                                                  |
| P20 | low    | The `globalThis` registration flag can outlive the module-scoped registry                                               | accepted | `ensureProvidersRegistered()` checks the registry itself (`isResumableProvider(getProvider("PLANDAY"))`) (3.4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| P21 | low    | Connect-proof bounds are Netlify leftovers that exceed web's shutdown grace                                             | accepted | `CONNECT_BUDGET_MS = SHUTDOWN_GRACE_MS − 2 s`, lease wait 3 s, per-request timeouts adapt to the time left with a 3 s floor, the lease released in `finally`, new proofs refused while web drains (4.1, 4.5, 5.6, 7.4, 7.7, 16.2).                                                                                                                                                                                                                                                                                                                                                              |
| P22 | low    | Opt-outs can leave nobody emailed when Planday disconnects                                                              | accepted | The auth-error email and notification are transactional and go to every OWNER and ADMIN regardless of preferences; opt-outs still apply elsewhere (8.4, stage 7B note, D-055).                                                                                                                                                                                                                                                                                                                                                                                                                  |
