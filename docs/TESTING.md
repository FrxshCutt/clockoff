# Testing

ClockOff has four test layers. Each one has a single place for its files, a single command, and a rule
about what it may touch.

| Layer              | Where                                                                                  | Runner                                | Touches                                                          |
| ------------------ | -------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------- |
| Unit               | `packages/*/src/**/*.test.ts`, `apps/web/src/**/*.test.ts` (next to the source)        | Vitest (`unit` project in `apps/web`) | Nothing outside the process: no database, no network             |
| Integration        | `apps/web/test/integration/**/*.test.ts` (and `apps/web/src/**/*.integration.test.ts`) | Vitest (`integration` project)        | The dedicated `TEST_DATABASE_URL` database (reset every run)     |
| End-to-end (smoke) | `apps/web/e2e/**`                                                                      | Playwright                            | A running dev server on `:3000` with a seeded dev database       |
| iOS                | `apps/ios/Packages/ClockOffCore/Tests/**` and the app's XCTest targets                 | XCTest (`make -C apps/ios test`)      | Simulator only; `MockRestrictionProvider` instead of Screen Time |

The pure state-machine fixtures in `docs/fixtures/workmode-cases.json` are run by both the TypeScript
unit tests (`packages/shared`) and XCTest, so the server and the phone cannot disagree about Work Mode
states.

## Commands

From the repo root:

```bash
pnpm test                      # unit tests in every package (Turborepo)
pnpm test:integration          # apps/web integration suite against clockoff_test
pnpm --filter @clockoff/web test:e2e   # Playwright smoke (starts/reuses pnpm dev)
make -C apps/ios test          # iOS unit tests on the simulator
```

Inside `apps/web` (useful while iterating; `dotenv` loads the single root `.env`):

```bash
npx dotenv -e ../../.env -c -- npx vitest run --project unit src/server/http
npx dotenv -e ../../.env -c -- npx vitest run --project integration test/integration/auth.test.ts
TEST_LOG_LEVEL=debug npx dotenv -e ../../.env -c -- npx vitest run --project integration   # show server logs
```

Packages: `cd packages/shared && pnpm typecheck && pnpm lint && pnpm test` (same for `validation`).

## Unit tests

- Pure functions and classes only. Inject time (`now: () => number`, `random`) instead of mocking
  globals; see `MemoryRateLimiter` and `generateCompanyJoinCode`.
- Modules that read configuration call `env()` lazily; tests that change configuration mutate
  `process.env` and call `resetEnvCache()` (restore it in `afterEach`).
- Network-facing code is tested against local servers, never the internet (e.g. the APNs client is
  exercised against an in-process HTTP/2 server in `src/server/push/push.test.ts`).
- Logs are silent whenever `NODE_ENV=test`; set `TEST_LOG_LEVEL` to see them.

## Integration tests

### Database policy

- The suite only ever talks to `TEST_DATABASE_URL`. `test/helpers/testDatabase.ts` refuses to run unless
  that URL names a database whose name **ends in `_test`** (e.g. `clockoff_test`) and that differs from
  `DATABASE_URL` (same host, port and name = same database). Before dropping anything the global setup
  re-checks `SELECT current_database()` on the open connection. `test/integration/harness.test.ts` covers
  the guard.
- `test/integration/global-setup.ts` runs once per `vitest run`: `DROP SCHEMA public CASCADE`,
  `CREATE SCHEMA public`, `CREATE EXTENSION citext, pgcrypto`, then `prisma migrate deploy` (from
  `packages/db`, with `DATABASE_URL` pointed at the test database). The test database therefore always
  matches the committed migrations. `prisma migrate reset` / `db push` are never used.
- Concurrent runs on one machine (several terminals or engineers) are serialised by a Postgres advisory
  lock taken before the reset and released when the run finishes; a second run prints
  `[integration] waiting for another integration run to finish…` and waits up to
  `INTEGRATION_LOCK_WAIT_SECONDS` (default 600). The reset uses `lock_timeout = 30s`, so a stray client
  holding locks on test tables produces an error instead of a hang.
- `test/integration/setup.ts` runs before every test file and sets `process.env.DATABASE_URL` to the test
  URL **before** anything imports `@clockoff/db`, so the app's Prisma singleton is created against the test
  database. Static imports in that file are limited to modules that do not load the database client; keep
  it that way.
- Tests share one database within a run. They stay independent by creating their own users and
  organisations with unique emails (`uniqueEmail()`); never assume a table is empty and never depend on
  another test's data. `truncateAllTables()` exists for the rare suite that needs a blank slate.
- Files run sequentially in one process (`pool: forks`, `singleFork`) so database-heavy suites do not
  contend.

### Per-test state

`setup.ts` installs fresh test doubles before each test:

| Double              | Purpose                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MockEmailProvider` | captures every email; read tokens with `lastEmailToken(email, "/verify-email" \| "/reset-password" \| "/accept-invite")` or inspect `testEmails().sent` |
| `MemoryRateLimiter` | rate-limit counters start empty in every test                                                                                                           |
| `InProcessEventBus` | subscribe with `getEventBus().subscribe(orgId, handler)` to assert realtime events                                                                      |

It also forces `REQUIRE_EMAIL_VERIFICATION=false`; a test that needs it on sets
`process.env.REQUIRE_EMAIL_VERIFICATION = "true"` and calls `resetEnvCache()`.

Some work runs after the response (`runAfterResponse` in `src/server/background`, e.g. the register and
forgot-password emails, so their timing cannot reveal whether an account exists). Outside a Next request
those tasks run detached: `callRoute` awaits them (`settleBackgroundTasks()`) before it resolves, and
`setup.ts` settles them after every test. A test that invokes a handler directly calls
`await settleBackgroundTasks()` before asserting on emails.

### Helpers (`test/helpers`, import from `"../helpers"`)

| Helper                                                                                                       | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `callRoute(handler, { method, path, body, query, params, jar, cookies, headers, csrf, origin, ip })`         | Calls a route export (e.g. `POST` from `@/app/api/auth/login/route`) with a real `NextRequest`, like a browser: cookies from the jar, `Origin: APP_URL` and `x-csrf-token` on mutating requests (disable with `csrf: false` / `origin: null` to test the protections), `params` passed as Next 15's `Promise`, client IP via `ip` (`x-forwarded-for`). Waits for background tasks, then returns `{ status, headers, body, setCookies, cookies }` and applies `Set-Cookie` to the jar. |
| `CookieJar`                                                                                                  | Minimal browser cookie store (`get`, `set`, `delete`, `clone`, `apply`).                                                                                                                                                                                                                                                                                                                                                                                                              |
| `createTestUser({ email?, name?, password?, verified? })`                                                    | Creates a manager (argon2id hash; verified by default) → `{ user, password }`.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `createTestOrg({ owner?, name?, timezone?, firstLocationName? })`                                            | Creates an organisation through the real service (OWNER membership, ACTIVE join code) → `{ organisation, owner, ownerPassword, membership, joinCode }`.                                                                                                                                                                                                                                                                                                                               |
| `addMember(organisationId, user, role)`                                                                      | Adds a membership directly.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `loginAs(user, { organisationId? })`                                                                         | Real session row + signed CSRF token, returned as a `CookieJar` (no argon2, no rate limits). Pre-selects an organisation when given.                                                                                                                                                                                                                                                                                                                                                  |
| `createTestDevice(organisationId, { isActive? })`                                                            | Employee + mobile user + link + device → `{ employee, mobileUser, device }`. Pair with `issueMobileTokens(device)`.                                                                                                                                                                                                                                                                                                                                                                   |
| `lastEmailToken`, `testEmails`                                                                               | Read captured emails.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `registerTenantIsolationCase`, `runTenantIsolationCase`, `defineTenantIsolationSuite`, `createTenantFixture` | Tenant-isolation matrix (below).                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `truncateAllTables()`                                                                                        | Empties every table in the test database (guarded).                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Middleware does not run under `callRoute` (it is an edge concern covered by `src/middleware.test.ts`); the
handler-level CSRF and Origin checks do run.

### Example

```ts
import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/organisations/current/route";
import { callRoute, createTestOrg, loginAs, type ErrorBody } from "../helpers";

describe("GET /api/organisations/current", () => {
  it("returns the caller's organisation", async () => {
    const org = await createTestOrg();
    const jar = await loginAs(org.owner, { organisationId: org.organisation.id });
    const res = await callRoute<{ organisation: { id: string } }>(GET, {
      path: "/api/organisations/current",
      jar,
    });
    expect(res.status).toBe(200);
    expect(res.body.organisation.id).toBe(org.organisation.id);
  });
});
```

Validate response shapes against the shared schemas (`@clockoff/validation`) the dashboard and iOS client
use — see `test/integration/contracts.test.ts`.

## Adding tenant isolation cases

Every endpoint that reads or writes a tenant-owned resource by id **must** register a case proving that a
manager of organisation A cannot reach organisation B's resource. The runner
(`test/integration/tenant-isolation.test.ts`) imports every file in `test/integration/tenantCases/` and
creates fresh organisations A and B (each with a signed-in OWNER) for every case. The request you build
targets B's resource and is sent with **A's** session; the expected status defaults to `404`.

1. Create (or extend) `test/integration/tenantCases/<area>.ts`.
2. Register one case per endpoint and method:

```ts
import { prisma } from "@clockoff/db";
import { expect } from "vitest";
import { PATCH } from "@/app/api/employees/[employeeId]/route";
import { registerTenantIsolationCase } from "../../helpers/tenantIsolation";

registerTenantIsolationCase({
  name: "PATCH /api/employees/:id of another tenant",
  build: async (_orgA, orgB) => {
    const employee = await prisma.employee.create({
      data: { organisationId: orgB.organisation.id, firstName: "B", lastName: "Only" },
    });
    return {
      handler: PATCH,
      method: "PATCH",
      path: `/api/employees/${employee.id}`,
      params: { employeeId: employee.id },
      body: { jobTitle: "Hijacked" },
    };
  },
  expectStatus: 404, // default; may be an array, e.g. [403, 404]
  expectCode: "NOT_FOUND", // optional
  verify: async (_orgA, orgB) => {
    const rows = await prisma.employee.findMany({
      where: { organisationId: orgB.organisation.id },
    });
    expect(rows.every((e) => e.jobTitle !== "Hijacked")).toBe(true);
  },
});
```

3. Run `npx dotenv -e ../../.env -c -- npx vitest run --project integration test/integration/tenant-isolation.test.ts`.

Case names must be unique (duplicates throw). Prefer `404` over `403` for foreign ids: the response must not
reveal that the resource exists. List endpoints are covered by asserting B's rows are absent from A's
response inside `verify`.

## End-to-end smoke (Playwright)

`apps/web/playwright.config.ts` reuses a dev server on `:3000` (or starts `pnpm dev`, waiting on
`/api/health`). Seed the dev database first (`pnpm db:seed`). In CI the smoke run is optional because it
needs a seeded database and a long-running server. E2E tests must never point at the test database.

```bash
cd apps/web && npx playwright test          # or: pnpm --filter @clockoff/web test:e2e
```

`e2e/manager-journey.spec.ts` walks the manager journey in Chromium: register → verify email → create an
organisation (Europe/London) → publish a Work Policy and make it the default → default Break Rules from the
"Standard Break" preset → add an employee, create a link invite and check the instructions → add a shift →
the overview's awaiting-setup panel → then plays the phone through the real mobile API (`join/lookup`,
`join/confirm`, `sync`, `device/state`, `events`) and expects the open overview to follow along through the
realtime stream (no reload) and the activity feed to show the device's event. Each run creates its own
manager and organisation (`E2E Coffee <runId>`) in the dev database.

- **Verification links** come from `GET /api/dev/last-email?to=<address>`, a development-only route that
  reads an in-memory ring buffer the console email provider keeps when `DEV_TOOLS_ENABLED=true` (404 when
  dev tools are off or `NODE_ENV=production`; see SECURITY.md §3.6). The root `.env` needs
  `EMAIL_PROVIDER=console` and `DEV_TOOLS_ENABLED=true`.
- **Rate limits**: each run registers once and calls the mobile join endpoints twice, from one IP. The
  in-memory limiter allows 5 registrations and 10 join calls per hour, so after five runs against the same
  dev server restart it (the counters live in the process).
- **Screenshots** of the overview, employee detail and schedule land in `apps/web/e2e/screenshots/`
  (gitignored). `globals.css` excludes `e2e/` from Tailwind's sources (`@source not`); otherwise every file
  written there makes the dev server rebuild CSS and Fast Refresh the page in the middle of the run.
- First runs are slow while `next dev` compiles each route on demand; the test allows 5 minutes.

## iOS

`make -C apps/ios test` builds and runs XCTest on the simulator. Screen Time APIs are unavailable there, so
`MockRestrictionProvider` stands in; tests that need real shields are manual device checks listed in
`docs/IOS_SETUP.md`. The `ClockOffCore` Swift package also runs `docs/fixtures/workmode-cases.json`.

## Before you push

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration
```

Integration tests need Postgres from `pnpm db:up` (port 5433) with the `clockoff_test` database.
