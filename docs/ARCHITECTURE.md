# Architecture

Work Mode is a monorepo with three runtime surfaces — the **manager web app + API** (Next.js), the
**background job runner** (Node, same codebase), and the **employee iOS app** (Swift) with three app
extensions — sharing a PostgreSQL database through Prisma and a set of pure-TypeScript domain packages.

```mermaid
flowchart LR
  subgraph Manager["Manager (browser)"]
    UI[Next.js dashboard<br/>React Query + SSE]
  end
  subgraph Web["apps/web (Next.js 15)"]
    API[/API route handlers<br/>/api/** manager · /api/mobile/v1/** device/]
    SVC[Service layer<br/>services/*.service.ts]
    REPO[Repositories<br/>organisationId explicit]
    BUS[(In-process event bus<br/>Redis-pluggable)]
    SSE[/api/realtime/stream/]
    JOBS[Minute scheduler<br/>src/jobs/main.ts]
  end
  subgraph Shared["packages/*"]
    SH[shared: state machine · policy resolution<br/>break rules · time · CSV · privacy statements]
    VAL[validation: Zod schemas → OpenAPI]
    DB[db: Prisma schema · migrations · seed]
  end
  PG[(PostgreSQL)]
  subgraph iOS["apps/ios (Swift)"]
    APP[WorkModeApp<br/>SwiftUI · SyncCoordinator · WorkModeController]
    CORE[WorkModeCore (SPM)<br/>models · engine · RestrictionProvider · App Group store]
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
  JOBS --> SVC
  JOBS -->|silent push| APNS --> APP
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

| Path | Role | Depends on |
| --- | --- | --- |
| `packages/shared` | Pure domain logic (no framework): Work Mode state machine, policy resolution, break rules, time/DST helpers, CSV parsing, status derivation, privacy statements, join codes, plans, workforce provider abstraction. Fully unit-tested; the state-machine fixtures (`docs/fixtures/workmode-cases.json`) are also run by XCTest. | luxon, papaparse, rrule |
| `packages/validation` | Zod schemas for every request/response (strict for mobile), and the OpenAPI 3.1 generator producing `docs/openapi.json`. | zod, shared |
| `packages/db` | Prisma schema, SQL migrations (including hand-written constraints), client singleton, seed. | @prisma/client |
| `packages/config` | tsconfig/eslint presets. | — |
| `apps/web` | Dashboard UI, marketing pages, all API handlers, SSE, jobs entrypoint. | all packages |
| `apps/ios` | Xcode project generated from `project.yml` (XcodeGen); app + 3 extensions + WorkModeCore SPM. | — (consumes the API) |

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

## Work Mode truth model

- **Durable truth** lives in Postgres: shifts, break sessions, overrides, device-reported state.
- **Expected state** is computed by the pure `computeExpectedState()` from those rows — by the server job every
  minute (stored on `EmployeeWorkState`) and by the iOS engine on-device from its cache. Both run the same
  fixture file, so divergence between them is a bug, not a design feature.
- **Enforcement** happens only on the device via Apple's `ManagedSettingsStore`, driven by `DeviceActivity`
  schedules that fire even when the app is closed. The server never controls the phone directly; it supplies
  policy + schedule and receives compliance signals.
- **Realtime** (SSE) is a cache-invalidation hint for the dashboard; it is never the source of truth.

## Background jobs

`apps/web/src/jobs/main.ts` runs every minute (node-cron) or can be triggered via `POST /api/jobs/tick`
with `CRON_SECRET` (for platforms without long-running processes). It: recomputes expected state per
employee with a shift today, flags `SYNC_DELAYED`/`NEEDS_ATTENTION`, auto-ends expired breaks, expires
overrides, materialises recurring shifts for the next 8 weeks, publishes SSE events, and sends silent pushes
through the `PushProvider` (`ApnsPushProvider` when APNs env is set, otherwise `NoopPushProvider`).

## iOS extensions

| Target | Runs when | Does |
| --- | --- | --- |
| `WorkModeDeviceActivityMonitor` | Apple wakes it at scheduled interval start/end/warning, even if the app is killed or after reboot | Reads `plans.json` from the App Group, applies/clears `ManagedSettingsStore` shields, writes engine state + queues events to the outbox |
| `WorkModeShieldConfiguration` | A shielded app is opened | Renders the custom shield (employer name, shield message) from App Group strings |
| `WorkModeShieldAction` | User taps a shield button | Primary closes; secondary sets an App Group flag to open the status screen |

See `docs/SCREEN_TIME_IMPLEMENTATION.md` for Apple-specific limits (15-minute minimum interval, 20-activity
cap, opaque tokens, revocation honesty).
