# Local Development

## Prerequisites

| Tool           | Version                | Notes                                          |
| -------------- | ---------------------- | ---------------------------------------------- |
| Node.js        | 24 (`.node-version`)   | `nvm use` or fnm                               |
| pnpm           | 11.10                  | `corepack enable` or `npm i -g pnpm@11`        |
| Docker Desktop | any recent             | for Postgres (`pnpm db:up`)                    |
| Xcode          | 16.4+ (26.x used here) | iOS only; XcodeGen via `brew install xcodegen` |

## First run

```bash
git clone https://github.com/FrxshCutt/clockoff.git clockoff && cd clockoff
pnpm install                 # also runs `prisma generate`
pnpm setup:env               # .env with generated secrets (edit if needed)
pnpm db:up                   # Postgres 16 on localhost:5433 → databases `clockoff` and `clockoff_test`
pnpm db:migrate:deploy       # apply committed migrations (or `pnpm db:migrate` to create new ones)
pnpm db:seed                 # Harpenden Coffee Co. demo data
pnpm dev                     # http://localhost:3000
```

Seeded manager login: `owner@harpendencoffee.test` / `Password123!`. Join code: `BREW-4821`.

Run the worker in another terminal when you want Work Mode states, overrides, break expiry and recurring shifts
to move on their own (the web app runs no jobs):

```bash
pnpm worker                      # the jobs every minute, the heartbeat and the push bridge, until Ctrl-C
pnpm worker list                 # the jobs, their intervals and lock keys
pnpm worker run work-mode-tick   # one run now (also override-expiry, schedule-upkeep, integrations-sync)
```

With `DIRECT_URL` set (the `.env.example` value equals `DATABASE_URL`), `pnpm dev` and `pnpm worker` share
realtime events through Postgres LISTEN/NOTIFY, so the dashboard updates live when the worker changes something.
Without it each process keeps its events to itself, and the dashboard only sees the worker's changes through its
30-second refresh. `/api/health` shows the worker's heartbeat (`worker.status`, `worker.jobs`).

Emails (verification, password reset, invites) are printed to the web server console by
`ConsoleEmailProvider` — look for the boxed block containing the link.

## Upgrading an existing checkout

Checkouts from before the rename to ClockOff (`docs/DECISIONS.md` D-022) ran Postgres as the `workmode-postgres`
container with a `workmode` role, `workmode` / `workmode_test` databases and the `workmode_workmode-pgdata`
volume. The compose project is now `clockoff`: container `clockoff-postgres`, role and password `clockoff`,
databases `clockoff` / `clockoff_test`, volume `clockoff_clockoff-pgdata`. After pulling, run `pnpm install`.

`pnpm db:down` is not enough: it now acts on the `clockoff` project, so it neither stops the old container (which
still holds port 5433) nor moves its data. Stop `pnpm dev`, the job runner (`pnpm worker`; `pnpm jobs` in older
checkouts) and Prisma Studio, then pick one:

- **Recreate (simplest; local data is lost).** The old volume is left alone.

  ```bash
  docker compose -p workmode down     # removes the old container, keeps its volume
  pnpm db:up                          # clockoff-postgres on a fresh clockoff_clockoff-pgdata volume
  pnpm db:migrate && pnpm db:seed
  ```

- **Rename in place (keeps local data).** With the old container running (`docker start workmode-postgres`):

  ```bash
  # A temporary superuser does the renames: Postgres cannot rename the role or database you are connected as.
  docker exec workmode-postgres psql -U workmode -d postgres -c "CREATE ROLE clockoff_upgrade SUPERUSER LOGIN"
  docker exec workmode-postgres psql -U clockoff_upgrade -d postgres \
    -c "ALTER ROLE workmode RENAME TO clockoff" \
    -c "ALTER ROLE clockoff PASSWORD 'clockoff'" \
    -c "ALTER DATABASE workmode RENAME TO clockoff" \
    -c "ALTER DATABASE workmode_test RENAME TO clockoff_test"
  docker exec workmode-postgres psql -U clockoff -d postgres -c "DROP ROLE clockoff_upgrade"
  docker compose -p workmode down     # removes the old container, keeps its volume
  # Copy the data directory into the new volume (ownership preserved).
  docker run --rm -v workmode_workmode-pgdata:/from:ro -v clockoff_clockoff-pgdata:/to \
    postgres:16-alpine sh -c "cp -a /from/. /to/"
  pnpm db:up                          # clockoff-postgres on the copied volume
  ```

  Compose may warn that `clockoff_clockoff-pgdata` was not created by Compose; that is harmless. The old volume
  stays as a backup until you remove it with `docker volume rm workmode_workmode-pgdata`.

Then:

- Update `DATABASE_URL`, `DIRECT_URL` and `TEST_DATABASE_URL` in your `.env` to the `.env.example` values
  (`postgresql://clockoff:clockoff@localhost:5433/clockoff?schema=public` and `…/clockoff_test?schema=public`).
- Rename any `WORKMODE_*` settings in the git-ignored `apps/ios/Config/Local.xcconfig` and
  `apps/ios/Config/Signing.local.xcconfig` to `CLOCKOFF_*` (the committed xcconfigs already use `CLOCKOFF_*`).
- Sign in to the local dashboard again: the session cookie is now `clockoff_session`. The seed hash salt changed
  too, so the next `pnpm db:seed` gives the demo records new ids.
- Optional: point the remote at the new name with `git remote set-url origin https://github.com/FrxshCutt/clockoff.git`
  (GitHub redirects the old URL either way) and rename the folder to `clockoff`.

## Everyday commands

| Command                                              | What                                                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| `pnpm typecheck` / `pnpm lint` / `pnpm test`         | all packages via Turborepo                                                        |
| `pnpm test:integration`                              | API + service tests against `clockoff_test` (reset on every run)                  |
| `pnpm --filter @clockoff/web test:e2e`               | Playwright smoke (needs `pnpm dev` running)                                       |
| `pnpm build`                                         | production build of the web app and the worker bundle (typechecks packages first) |
| `pnpm openapi`                                       | regenerate `docs/openapi.json` from the Zod schemas                               |
| `pnpm db:studio`                                     | Prisma Studio                                                                     |
| `make -C apps/ios generate build test build-release` | iOS project regen, build, test, release compile                                   |

## Database workflow

- Change `packages/db/prisma/schema.prisma`, then `pnpm db:migrate -- --name <change>` (creates + applies a
  migration). Never `db push`. Commit the migration folder.
- Constraints Prisma can't express (partial unique indexes, check constraints, functional indexes) are
  hand-written SQL in the migration — see `docs/DATABASE.md`.
- `prisma migrate reset` is intentionally not used by tooling or tests (it refuses to run from automation);
  the integration suite resets the dedicated `clockoff_test` schema itself.

## iOS

- Open `apps/ios/ClockOff.xcodeproj`. Regenerate after editing `project.yml` with `make -C apps/ios generate`.
- Simulator builds use `MockRestrictionProvider` (banner "DEVELOPMENT MODE — restrictions are simulated").
  Screen Time APIs (FamilyControls / ManagedSettings / DeviceActivity) only work on a **real device** with the
  Family Controls entitlement on your team — see `docs/IOS_SETUP.md`.
- `API_BASE_URL` is the root of the mobile API, not the server origin. The simulator uses the Debug default,
  `http://localhost:3000/api/mobile/v1`.
- Point a device at your Mac: in the git-ignored `apps/ios/Config/Local.xcconfig`, set `API_BASE_URL` to your
  Mac's Bonjour name or LAN IP **including `/api/mobile/v1`**, written with `/$()/` because `//` starts an
  xcconfig comment: `API_BASE_URL = http:/$()/my-mac.local:3000/api/mobile/v1` (or
  `http:/$()/192.168.x.x:3000/api/mobile/v1`). Without the path the app stops at launch. Details in
  `docs/IOS_SETUP.md` › "Pointing a device at a local API".

## Troubleshooting

- **pnpm refuses a package published < 24 h ago** — the `minimumReleaseAge` policy is deliberate; pin the
  previous version (see DECISIONS D-003).
- **Port 5433 in use** — change the host port in `docker-compose.yml` and `DATABASE_URL`/`TEST_DATABASE_URL`.
- **Prisma "Environment variable not found: DATABASE_URL"** — scripts load the root `.env` via `dotenv-cli`;
  run package scripts through `pnpm --filter …` or from the repo root.
- **`prisma migrate dev` wants to reset** — happens when the dev DB has objects but no migration history.
  Drop and recreate the `clockoff` database (it is local), then `pnpm db:migrate:deploy`.
