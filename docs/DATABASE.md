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
| `workmode`      | `DATABASE_URL`      | dev server, jobs, seed, Prisma Studio                      |
| `workmode_test` | `TEST_DATABASE_URL` | integration tests — **dropped and recreated on every run** |

The integration global setup refuses to run unless `TEST_DATABASE_URL` contains `_test`.

## Seed

`pnpm db:seed` runs `packages/db/prisma/seed.ts` (idempotent: wipes and recreates the demo organisations).
It creates Harpenden Coffee Co. (owner `owner@harpendencoffee.test` / `Password123!`, join code `BREW-4821`,
three locations, departments, teams, six policies, three break policies, 16 employees in every lifecycle
state, two weeks of shifts, break sessions, 50+ activity events, a CSV import record, an expired override,
audit logs) and a second organisation "Other Co" used by tenant-isolation tests.

## Backups / production

Use managed Postgres with PITR. Run `prisma migrate deploy` on release. Never run `migrate dev`,
`migrate reset` or `db push` against production.
