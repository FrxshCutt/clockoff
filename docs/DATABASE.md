# Database

PostgreSQL 16, accessed through Prisma 6. Schema: `packages/db/prisma/schema.prisma`. Migrations:
`packages/db/prisma/migrations/*`. Client singleton: `packages/db/src/client.ts` (`import { prisma } from "@clockoff/db"`).

## Conventions

- UUID primary keys (`gen_random_uuid()` via `pgcrypto`), `created_at` / `updated_at` on every table,
  `deleted_at` soft delete on User, Organisation, Employee, Location, Policy, BreakPolicy, Shift.
- Tables and columns are `snake_case` in SQL and `camelCase` in TypeScript (`@map`/`@@map`).
- Every tenant-owned table carries `organisation_id` with composite indexes on the common access paths.
  Repositories take `organisationId` as an explicit argument; it always comes from the authenticated
  membership, never from the request.
- Emails are `citext` (case-insensitive unique).
- All timestamps are `timestamptz`; shifts additionally store the IANA `timezone` they were entered in.
- JSON columns are validated by Zod at the service boundary (`restriction_config`, `onboarding_state`,
  `column_mapping`, `problems`, `metadata`, `payload`).

## Hand-written SQL (in `…_init/migration.sql`)

| Object                                                                                   | Purpose                                                                                     |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `shifts_ends_after_starts` CHECK                                                         | `ends_at > starts_at`                                                                       |
| `break_sessions_planned_end_after_start` CHECK                                           | planned end after start                                                                     |
| `scheduled_breaks_duration_positive` CHECK                                               | positive duration, non-negative offset                                                      |
| `manager_overrides_expires_after_starts` CHECK                                           | expiry after start                                                                          |
| `employees_org_lower_name_idx`                                                           | `(organisation_id, lower(first_name), lower(last_name))` for join lookup / CSV matching     |
| `company_join_codes_one_active_per_org`                                                  | partial unique: one `ACTIVE` join code per organisation                                     |
| `policy_assignments_active_scope_unique`, `break_policy_assignments_active_scope_unique` | partial unique: one active assignment per `(scope_type, scope_id)` (`effective_to IS NULL`) |
| `break_sessions_one_active_per_shift`                                                    | partial unique: one `ACTIVE` break per shift                                                |
| `employee_user_links_one_active_per_mobile_user`                                         | partial unique: a phone is linked to one employee at a time                                 |

When you add a migration that needs such an object, run `pnpm db:migrate -- --create-only --name <x>`, append
the SQL, then `pnpm db:migrate`.

## Local databases

`docker compose up -d postgres` starts a container with two databases created by `docker/postgres-init.sql`:

| Database        | URL variable        | Used by                                                    |
| --------------- | ------------------- | ---------------------------------------------------------- |
| `clockoff`      | `DATABASE_URL`      | dev server, worker, seed, Prisma Studio                    |
| `clockoff_test` | `TEST_DATABASE_URL` | integration tests — **dropped and recreated on every run** |

The integration global setup refuses to run unless `TEST_DATABASE_URL` contains `_test`.

## Seed

`pnpm db:seed` runs `packages/db/prisma/seed.ts` (idempotent: wipes and recreates the demo organisations).
It creates Harpenden Coffee Co. (owner `owner@harpendencoffee.test` / `Password123!`, join code `BREW-4821`,
three locations, departments, teams, six policies, three break policies, 16 employees in every lifecycle
state, two weeks of shifts, break sessions, 50+ activity events, a CSV import record, an expired override,
audit logs) and a second organisation "Other Co" used by tenant-isolation tests.

## Worker tables

Migration `20261008090000_worker_runtime` adds two operational tables for the background worker. Neither holds
tenant data or PII.

| Table               | Key           | Purpose                                                                                                                                                                                                         |
| ------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worker_heartbeats` | `instance_id` | One row per worker process, upserted every minute (`last_beat_at`, counters and flags in `details`); `stopped_at` is set by a graceful shutdown. `GET /api/health` reads it; rows older than 7 days are pruned. |
| `worker_job_runs`   | `job`         | The last minute slot each job claimed (`last_slot`) and its outcome. The claim makes a scheduled slot run once across workers; `last_ok_at` of `work-mode-tick` feeds `worker.jobs` in `/api/health`.           |

## Workforce integration tables (Planday)

Two migrations add the Planday data model (`docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md` section 2). Both are
expand-only: they add enums, nullable or defaulted columns, tables, indexes and checks, and drop or rename nothing.

| Migration                                | Content                                                                                                                                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20261008140000_integration_enum_values` | Five `ActivityEventType` values (`INTEGRATION_CONNECTED`, `_DISCONNECTED`, `_SYNCED`, `EMPLOYEE_DEACTIVATED`, `_REACTIVATED`), alone: PostgreSQL cannot use an enum value in the transaction that adds it. |
| `20261008140100_planday_integration`     | New enums, columns, tables, partial unique indexes, check constraints and the backfill below.                                                                                                              |

New tables (all tenant-owned through `organisation_id`; all but `integration_connect_links` also carry
`integration_id` and are deleted with their integration):

| Table                             | Purpose                                                                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `external_entity_maps`            | Provider id ↔ ClockOff id for every synced employee, location, department, team and shift, with the `last_hash` that makes syncs idempotent.      |
| `integration_mapping_configs`     | One per integration: included departments, department and group mappings, excluded employees, sync window (7 to 56 days) and the sync options.    |
| `integration_sync_runs`           | The run queue the worker's integration runner claims; at most one `RUNNING` run per integration. Holds counts, warnings and the resumable cursor. |
| `pending_external_employees`      | Provider employees waiting for a manager decision. A row exists only while pending; resolving it deletes it.                                      |
| `integration_preview_shifts`      | The wizard's 14-day shift preview, purged at finish, abandon and disconnect.                                                                      |
| `integration_onboarding_sessions` | The resumable connect wizard; at most one `ACTIVE` session per organisation and provider.                                                         |
| `integration_oauth_states`        | Single-use OAuth `state` rows (10-minute expiry) bound to an organisation and user.                                                               |
| `integration_connect_links`       | Shareable "connect Planday" links for an organisation's owners and admins.                                                                        |

Changed tables:

- `integration_connections`: one row per integration for its lifetime. Disconnect wipes the secrets
  (`encrypted_access_token`, `encrypted_refresh_token`, `encrypted_client_id`, all AES-256-GCM with per-column
  associated data) and keeps the row and `external_portal_id`. Adds the fine-grained `status`, portal fields, auth
  method, `credential_version`, the per-portal sync lease (`sync_lease_*`), the pending-run slot (`pending_run_*`)
  and the health bookkeeping (`*_notified_at`, `consecutive_failure_count`). The existing `token_expires_at`,
  `last_sync_at` and `last_error` columns are reused under the Prisma names `accessTokenExpiresAt`,
  `lastSuccessfulSyncAt` and `lastErrorMessage`, so older deployments keep reading them.
- `employees`, `locations`, `teams`: `source` (`MANUAL`, `CSV_IMPORT`, `INTEGRATION`) and
  `managed_by_integration_id`. `shifts`: `managed_by_integration_id` (shifts keep their own `source`).
- `organisations`: `rota_source` and `rota_source_other_text` (the onboarding answer, null until answered).

Hand-written SQL in `20261008140100_planday_integration`:

| Object                                               | Purpose                                                                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `integration_sync_runs_one_running`                  | partial unique: one `RUNNING` (queued or started) run per integration                                      |
| `external_entity_maps_internal_unique`               | partial unique: one external record per ClockOff employee or shift (`entity_type IN ('EMPLOYEE','SHIFT')`) |
| `integration_onboarding_sessions_one_active`         | partial unique: one `ACTIVE` wizard per organisation and provider                                          |
| `integration_connections_one_live_portal`            | partial unique: one live, non-mock connection per Planday portal across organisations                      |
| `integration_mapping_configs_sync_window_days_check` | `sync_window_days BETWEEN 7 AND 56`                                                                        |
| `organisations_rota_source_other_text_check`         | free text only with `rota_source = 'OTHER'` (null-safe)                                                    |
| `integration_connections_credential_hint_check`      | `credential_hint` at most four characters                                                                  |
| `integration_sync_runs_priority_check`               | `priority BETWEEN 0 AND 3`                                                                                 |

Backfill: every existing employee, location and team takes `source = MANUAL`. Employees created by a CSV import
cannot be told apart reliably (imports create them through the ordinary create path), so they stay `MANUAL`.
`managed_by_integration_id` and `rota_source` stay null. Any pre-existing `integration_connections` row is marked
`DISCONNECTED`; the migration only reports their count with `RAISE NOTICE` (production had none).

Legacy column: `integration_connections.encrypted_credentials` (Prisma `legacyEncryptedCredentials`) is now
nullable and written only by the generic connect path of providers that are still `COMING_SOON`. A contract
migration drops it after the Planday release, once no deployed image reads it.

Lock timeout: `20261008140100_planday_integration` starts with `SET lock_timeout = '5s'`. Its `ADD COLUMN`s lock
`employees`, `locations`, `teams`, `shifts`, `organisations` and `integration_connections` exclusively until the
script commits, and web's pre-deploy step runs it while the previous deployments still serve traffic. If a lock is
not granted within 5 seconds the whole script rolls back (PostgreSQL runs it as one transaction), the pre-deploy
step fails and Railway keeps the previous web deployment; the new worker waits at its migration gate
(`worker.jobs: "waiting_for_migrations"` on `/api/health`). Prisma records the attempt as failed, so the next
`prisma migrate deploy` stops with P3009 until it is marked rolled back. To retry, from a trusted machine with
the production `DIRECT_URL` (as in `docs/DEPLOYMENT.md`, Migrations):

```bash
DATABASE_URL="$DIRECT_URL" pnpm --filter @clockoff/db exec prisma migrate resolve --rolled-back 20261008140100_planday_integration
```

Then redeploy web (Railway → web → the failed deployment → Redeploy).

## Connections

`DATABASE_URL` is Prisma's connection (in production Neon's **pooled** URL, PgBouncer in transaction mode).
`DIRECT_URL` is the **direct** connection, read at runtime by the web app and the worker for the realtime LISTEN
session and the worker's advisory-lock session (neither works through PgBouncer), and used by migrations.
Locally both point at the same database.

## Backups / production

Production is Neon Postgres 17 in London (`docs/DEPLOYMENT.md` › Database). Migrations run as the web service's
pre-deploy step on Railway (`/app/migrate.sh`, `prisma migrate deploy` over `DIRECT_URL`), so keep them additive:
the previous web and worker images must keep working against the new schema during a deploy and after a rollback.
Never run `migrate dev`, `migrate reset` or `db push` against production. Neon's free plan keeps a 6-hour restore
window; see `docs/DEPLOYMENT.md` › Backups and restore.
