# Architecture

ClockOff is a monorepo with three runtime surfaces — the **manager web app + API** (Next.js), the
**background worker** (Node, same codebase, its own process), and the **employee iOS app** (Swift) with three app
extensions — sharing a PostgreSQL database through Prisma and a set of pure-TypeScript domain packages. In
production web and worker are separate Railway services (`docs/DEPLOYMENT.md`).

```mermaid
flowchart LR
  subgraph Manager["Manager (browser)"]
    UI[Next.js dashboard<br/>React Query + SSE]
  end
  subgraph Web["apps/web (Next.js 15)"]
    API[/API route handlers<br/>/api/** manager · /api/mobile/v1/** device/]
    SVC[Service layer<br/>services/*.service.ts]
    REPO[Repositories<br/>organisationId explicit]
    BUS[(Event bus<br/>local delivery + Postgres NOTIFY)]
    SSE[/api/realtime/stream/]
  end
  subgraph Worker["apps/web/src/worker (separate process)"]
    JOBS[Scheduler<br/>advisory lock per job]
    BRIDGE[Push bridge<br/>elected leader only]
  end
  subgraph Shared["packages/*"]
    SH[shared: state machine · policy resolution<br/>break rules · time · CSV · privacy statements]
    VAL[validation: Zod schemas → OpenAPI]
    DB[db: Prisma schema · migrations · seed]
  end
  PG[(PostgreSQL)]
  subgraph iOS["apps/ios (Swift)"]
    APP[ClockOffApp<br/>SwiftUI · SyncCoordinator · WorkModeController]
    CORE[ClockOffCore (SPM)<br/>models · engine · RestrictionProvider · App Group store]
    MON[DeviceActivityMonitor ext.<br/>intervalDidStart/End → ManagedSettings]
    SHC[ShieldConfiguration ext.]
    SHA[ShieldAction ext.]
    AG[(App Group container<br/>plans.json · cache · outbox)]
  end
  APNS[APNs]

  UI -->|cookie session + CSRF| API
  UI -->|SSE| SSE
  API --> SVC --> REPO --> DB --> PG
  SVC --> BUS --> SSE
  BUS <-->|LISTEN/NOTIFY| PG
  JOBS --> SVC
  BUS --> BRIDGE
  BRIDGE -->|silent push| APNS --> APP
  APP -->|JWT bearer| API
  APP --> CORE
  MON --> CORE
  SHC --> CORE
  SHA --> CORE
  CORE --> AG
  SVC --> SH
  API --> VAL
  APP -.->|Codable models from| VAL
```

## Packages

| Path                  | Role                                                                                                                                                                                                                                                                                                                            | Depends on              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `packages/shared`     | Pure domain logic (no framework): Work Mode state machine, policy resolution, break rules, time/DST helpers, CSV parsing, status derivation, privacy statements, join codes, plans, workforce provider abstraction. Fully unit-tested; the state-machine fixtures (`docs/fixtures/workmode-cases.json`) are also run by XCTest. | luxon, papaparse, rrule |
| `packages/validation` | Zod schemas for every request/response (strict for mobile), and the OpenAPI 3.1 generator producing `docs/openapi.json`.                                                                                                                                                                                                        | zod, shared             |
| `packages/db`         | Prisma schema, SQL migrations (including hand-written constraints), client singleton, seed.                                                                                                                                                                                                                                     | @prisma/client          |
| `packages/config`     | tsconfig/eslint presets.                                                                                                                                                                                                                                                                                                        | —                       |
| `apps/web`            | Dashboard UI, marketing pages, all API handlers, SSE; the worker's entry point (`src/worker`, bundled separately).                                                                                                                                                                                                              | all packages            |
| `apps/ios`            | Xcode project generated from `project.yml` (XcodeGen); app + 3 extensions + ClockOffCore SPM.                                                                                                                                                                                                                                   | — (consumes the API)    |

## Request lifecycle (manager)

1. `middleware.ts` adds security headers, a request id, and rejects cross-origin mutating requests.
2. The route file exports handlers built with `createHandler({ auth: "manager", permission, body, query, params })`.
3. The wrapper validates input with Zod, resolves `getCurrentManagerContext(req)` (session cookie → user →
   membership → organisation → permissions), checks the CSRF token, applies rate limits, and calls the
   implementation with a typed `ctx`.
4. Services receive `ctx` + validated input; repositories receive `organisationId` explicitly (never from the
   request). Every manager mutation writes an `AuditLog` through `audit()` and, where relevant, an
   `ActivityEvent` through `recordActivity()` which also publishes on the event bus.
5. Errors are `AppError`s converted to `{ error: { code, message, details? } }` with the code's HTTP status.

## Request lifecycle (device)

`/api/mobile/v1/*` uses short-lived HS256 JWTs (15 min) and rotating refresh tokens bound to a `Device`
row (hashed, family-based reuse detection). `getCurrentDeviceContext(req)` scopes every call to that single
employee. Input schemas are `.strict()` and allow only the operational fields enumerated in `docs/PRIVACY.md`.

## ClockOff truth model

- **Durable truth** lives in Postgres: shifts, break sessions, overrides, device-reported state.
- **Expected state** is computed by the pure `computeExpectedState()` from those rows — by the server job every
  minute (stored on `EmployeeWorkState`) and by the iOS engine on-device from its cache. Both run the same
  fixture file, so divergence between them is a bug, not a design feature.
- **Enforcement** happens only on the device via Apple's `ManagedSettingsStore`, driven by `DeviceActivity`
  schedules that fire even when the app is closed. The server never controls the phone directly; it supplies
  policy + schedule and receives compliance signals.
- **Realtime** (SSE) is a cache-invalidation hint for the dashboard; it is never the source of truth.

## Background jobs

The worker process (`apps/web/src/worker`, `pnpm worker` locally, the Railway `worker` service in production)
runs the jobs; the web process runs none. Every minute it recomputes expected state per employee with a shift
around now, flags `SYNC_DELAYED`/`NEEDS_ATTENTION`, auto-ends expired breaks, starts scheduled breaks, sends the
hourly manager digest, expires overrides, materialises recurring shifts for the next 8 weeks and completes ended
shifts; every 15 minutes it runs the scheduled workforce-provider syncs (a no-op until a provider registers). Each
job runs under its own Postgres advisory lock and claims its minute slot, so a second worker never repeats it. The
worker writes a heartbeat row every minute, which `GET /api/health` reports. Details: `docs/WORK_MODE_SERVER_JOB.md`.

The event bus delivers each event to its own process's subscribers and NOTIFYs the other processes through
Postgres (one LISTEN session per process on the direct connection), so the worker's events reach the dashboards'
SSE streams on web and manager edits reach the worker. The worker that holds the push-leadership lease turns
policy, schedule and override events into silent pushes through the `PushProvider` (`ApnsPushProvider` when APNs
env is set, otherwise `NoopPushProvider`).

## iOS extensions

| Target                          | Runs when                                                                                         | Does                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ClockOffDeviceActivityMonitor` | Apple wakes it at scheduled interval start/end/warning, even if the app is killed or after reboot | Reads `plans.json` from the App Group, applies/clears `ManagedSettingsStore` shields, writes engine state + queues events to the outbox |
| `ClockOffShieldConfiguration`   | A shielded app is opened                                                                          | Renders the custom shield (employer name, shield message) from App Group strings                                                        |
| `ClockOffShieldAction`          | User taps a shield button                                                                         | Primary closes; secondary sets an App Group flag to open the status screen                                                              |

See `docs/SCREEN_TIME_IMPLEMENTATION.md` for Apple-specific limits (15-minute minimum interval, 20-activity
cap, opaque tokens, revocation honesty).
