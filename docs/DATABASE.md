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
