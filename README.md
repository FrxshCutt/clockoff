# Work Mode

**Automatically create distraction-free shifts.** Your rota manages when your team works. Work Mode makes
sure their phones know they're working too — without monitoring employees.

- **Managers** (web dashboard) define Work Policies (which app categories are restricted during shifts) and
  Break Rules, schedule shifts (manually or via CSV), invite employees with a company code, and see
  operational status only: connected, permissions OK, working, on break, last sync.
- **Employees** (iOS app) join with a company code, grant Apple Screen Time authorisation once, choose the
  apps/categories to shield, and the app does the rest — shields activate when a shift starts, relax during
  policy-compliant breaks, and lift when the shift ends. The employer never sees messages, photos, browsing
  history, notifications, app usage or which specific apps were selected.

> Privacy principle: **Block distractions. Don't spy on employees.** See `docs/PRIVACY.md`.

## Repository layout

```
apps/web          Next.js 15 (App Router) — manager dashboard, marketing pages, all API route handlers
apps/ios          Xcode project (Swift, SwiftUI, iOS 16.4+) — app + DeviceActivityMonitor + Shield extensions
packages/db       Prisma schema, migrations, client, seed
packages/shared   Pure TypeScript domain logic (Work Mode state machine, policy resolution, break rules, CSV, time)
packages/validation  Zod schemas shared by API + forms; OpenAPI generator for the iOS client
packages/config   tsconfig / eslint presets
docs/             Architecture, setup, privacy, security, status, decisions
```

## Quick start

```bash
pnpm install              # installs everything and generates the Prisma client
pnpm setup:env            # creates .env from .env.example with generated secrets
pnpm db:up                # Postgres 16 on localhost:5433 (docker compose)
pnpm db:migrate           # applies migrations
pnpm db:seed              # Harpenden Coffee Co. demo data (owner@harpendencoffee.test / Password123!)
pnpm dev                  # web app on http://localhost:3000
pnpm jobs                 # minute scheduler (Work Mode server job) in a second terminal
```

iOS: open `apps/ios/WorkMode.xcodeproj` (regenerate with `make -C apps/ios generate`). Screen Time APIs
require a real device; the simulator uses `MockRestrictionProvider`. See `docs/IOS_SETUP.md`.

## Quality gates

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm build
make -C apps/ios build test build-release
```

Full documentation index: `docs/`. Current state of the build: `docs/STATUS.md`.
