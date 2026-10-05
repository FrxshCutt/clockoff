# Local Development

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 24 (`.node-version`) | `nvm use` or fnm |
| pnpm | 11.10 | `corepack enable` or `npm i -g pnpm@11` |
| Docker Desktop | any recent | for Postgres (`pnpm db:up`) |
| Xcode | 16.4+ (26.x used here) | iOS only; XcodeGen via `brew install xcodegen` |

## First run

```bash
git clone <repo> workmode && cd workmode
pnpm install                 # also runs `prisma generate`
pnpm setup:env               # .env with generated secrets (edit if needed)
pnpm db:up                   # Postgres 16 on localhost:5433 → databases `workmode` and `workmode_test`
pnpm db:migrate:deploy       # apply committed migrations (or `pnpm db:migrate` to create new ones)
pnpm db:seed                 # Harpenden Coffee Co. demo data
pnpm dev                     # http://localhost:3000
```

Seeded manager login: `owner@harpendencoffee.test` / `Password123!`. Join code: `BREW-4821`.

Run the minute scheduler in another terminal when you want Work Mode states, overrides and break expiry to
move on their own:

```bash
pnpm jobs
```

Emails (verification, password reset, invites) are printed to the web server console by
`ConsoleEmailProvider` — look for the boxed block containing the link.

## Everyday commands

| Command | What |
| --- | --- |
| `pnpm typecheck` / `pnpm lint` / `pnpm test` | all packages via Turborepo |
| `pnpm test:integration` | API + service tests against `workmode_test` (reset on every run) |
| `pnpm --filter @workmode/web test:e2e` | Playwright smoke (needs `pnpm dev` running) |
| `pnpm build` | production build of the web app (typechecks packages first) |
| `pnpm openapi` | regenerate `docs/openapi.json` from the Zod schemas |
| `pnpm db:studio` | Prisma Studio |
| `make -C apps/ios generate build test build-release` | iOS project regen, build, test, release compile |

## Database workflow

- Change `packages/db/prisma/schema.prisma`, then `pnpm db:migrate -- --name <change>` (creates + applies a
  migration). Never `db push`. Commit the migration folder.
- Constraints Prisma can't express (partial unique indexes, check constraints, functional indexes) are
  hand-written SQL in the migration — see `docs/DATABASE.md`.
- `prisma migrate reset` is intentionally not used by tooling or tests (it refuses to run from automation);
  the integration suite resets the dedicated `workmode_test` schema itself.

## iOS

- Open `apps/ios/WorkMode.xcodeproj`. Regenerate after editing `project.yml` with `make -C apps/ios generate`.
- Simulator builds use `MockRestrictionProvider` (banner "DEVELOPMENT MODE — restrictions are simulated").
  Screen Time APIs (FamilyControls / ManagedSettings / DeviceActivity) only work on a **real device** with the
  Family Controls entitlement on your team — see `docs/IOS_SETUP.md`.
- Point the Debug build at your machine: set `API_BASE_URL` in `apps/ios/Config/Debug.xcconfig` to your LAN
  IP (`http://192.168.x.x:3000`).

## Troubleshooting

- **pnpm refuses a package published < 24 h ago** — the `minimumReleaseAge` policy is deliberate; pin the
  previous version (see DECISIONS D-003).
- **Port 5433 in use** — change the host port in `docker-compose.yml` and `DATABASE_URL`/`TEST_DATABASE_URL`.
- **Prisma "Environment variable not found: DATABASE_URL"** — scripts load the root `.env` via `dotenv-cli`;
  run package scripts through `pnpm --filter …` or from the repo root.
- **`prisma migrate dev` wants to reset** — happens when the dev DB has objects but no migration history.
  Drop and recreate the `workmode` database (it is local), then `pnpm db:migrate:deploy`.
