# Developer Guide

How to add things to ClockOff without breaking its invariants. Read `ARCHITECTURE.md` first.

## The contract comes first

Every endpoint is described in `packages/validation`:

- Request/response Zod schemas live in `packages/validation/src/<domain>.ts`. Naming: `create*/update*/<verb>*Schema` are
  request bodies, `*QuerySchema` query strings, `*ParamsSchema` path params, `*ResponseSchema` response bodies, and
  `<name>Schema` resources/enums. Types are `z.infer` aliases (`Employee`, `CreateEmployeeInput`, …).
- `packages/validation/src/openapi/routes.ts` is the route map: one entry per endpoint with method, path, auth mode,
  permission, schemas and domain error codes. A route handler mirrors its entry exactly.
- `pnpm openapi` regenerates `docs/openapi.json`; a test fails if it is stale (run it after changing any schema or shared enum).
- Request bodies are `.strict()`. Mobile schemas are strict everywhere (privacy, §12).

## Adding an API endpoint (apps/web)

```ts
// src/app/api/widgets/[id]/route.ts
import { createHandler } from "@/server/http/apiHandler";
import { idParamsSchema, updateWidgetSchema } from "@clockoff/validation";
import { updateWidget } from "@/server/widgets/widgets.service";

export const PATCH = createHandler(
  {
    auth: "manager",
    permission: "widgets:write",
    params: idParamsSchema,
    body: updateWidgetSchema,
  },
  async ({ ctx, params, body }) => ({ widget: await updateWidget(ctx, params.id, body) }),
);
```

- **`createHandler(options, impl)`** (`@/server/http/apiHandler`). Options: `auth` (`public | user | manager | mobile`),
  `permission` (manager only), `params`/`query`/`body` Zod schemas, `rateLimit` (rule or rules; coarse per-IP rule first),
  `maxBodyBytes` (default 1 MiB), `emailVerification`. Pipeline: body → rate limit → auth → CSRF/Origin → permission →
  Zod → impl. Without a schema, `params`/`query`/`body` are `undefined` — declare a schema for everything you read.
  Return a value (200 JSON), `undefined` (204), or a `Response` (`json()`, `noContent()`, `sseResponse()`).
- **Errors**: throw `new AppError(code, message?, { status?, details? })` from `@clockoff/shared/errors`. Prisma `P2002` →
  `CONFLICT`, `P2025` → `NOT_FOUND`, anything else → `INTERNAL_ERROR` with only the request id.
- **Context**: `ctx.organisation.id` is the only organisation id you may use; it comes from the verified membership.
  `ManagerContext = { user, session, organisation, membership, permissions, requestId, ip, userAgent }`;
  `DeviceContext = { device, employee, organisation, mobileUser, … }` (mobile routes are scoped to that one employee).
- **Layers**: route → `src/server/<domain>/<domain>.service.ts` (gets `ctx` + validated input) →
  `<domain>.repository.ts` (gets `organisationId` explicitly). Route files never touch Prisma.
- **Tenancy**: by-id lookups always filter by `organisationId`; a row from another organisation is `NOT_FOUND` (404),
  never 403. Register a case for every by-id route in `apps/web/test/integration/tenantCases/*.ts` via
  `registerTenantIsolationCase({ name, build: (orgA, orgB) => ({ handler, method, path, params, body }) })`.
- **Audit**: every manager mutation calls `audit(ctx, { action, entityType, entityId, before?, after? }, tx?)`
  (`@/server/audit/audit`).
- **Activity**: domain events call `recordActivity({ organisationId, employeeId?, deviceId?, actorType, actorUserId?, type,
occurredAt?, metadata?, clientEventId? }, { db?, publish? })` (`@/server/activity/recordActivity`). It is idempotent
  on `(deviceId, clientEventId)` and safe inside a transaction (pass `publish: false`, then `publishActivity(event)` after
  commit). Metadata is operational only (ids, versions, states, counts).
- **Realtime**: `publishEvent({ type, organisationId, employeeId?, payload })` (`@/server/events`) feeds the SSE stream
  and the push bridge in every process (local delivery plus Postgres NOTIFY when `DIRECT_URL` is set). Payloads carry
  ids/types/badges only — never PII — and must stay small (an event over ~7.5 KB is sent truncated as "refetch").
- **Background work**: `runAfterResponse(name, task)` (`@/server/background`) for work whose timing must not leak
  (emails for existing accounts) or must not block the response.
- **Scheduled jobs** run only in the worker (`src/worker`): add a `WorkerJob` to `WORKER_JOBS` in
  `src/worker/jobs.ts` with a new key in `src/worker/lockKeys.ts` (never renumber or reuse one), keep it idempotent,
  and never call job code from the web process (`src/deploy/processBoundaries.test.ts` fails if web imports
  `@/worker/*`). Try it with `pnpm worker run <job>`.
- **Rate limits**: presets in `RATE_LIMITS` (`@/server/rateLimit`); custom rules `{ key, limit, windowSeconds, by }`.
- **Email / push**: `getEmailProvider()` / `sendEmailSafely()`; `getPushProvider().sendSilent(tokens, { reason })`.
- **Logging**: `log.error({ error: errorSummary(e), stack: stackFrames(e) }, "…")`. Never log `err.message`/`err.stack`,
  tokens, emails or names.
- **Mobile auth**: `issueMobileTokens(device)`, `rotateRefreshToken(raw)`, `revokeDeviceTokens(deviceId)`,
  `assertDeviceUsable(device)` (`@/server/mobileAuth`).

## Domain logic belongs in `packages/shared`

State machine (`workMode/`), break rules (`breaks/`), policy resolution (`policy/`), time/DST (`time/time`), CSV
(`csv/`), status derivation (`status/`), privacy statements, join codes, plans, providers. Services call these pure
functions; they never re-implement them. The state machine and break rules are mirrored in Swift and share
`docs/fixtures/workmode-cases.json`.

## Tests

| Kind            | Where                                             | Command                               |
| --------------- | ------------------------------------------------- | ------------------------------------- |
| Pure unit       | `packages/*/src/**/*.test.ts`                     | `pnpm --filter @clockoff/shared test` |
| Web unit        | `apps/web/src/**/*.test.ts(x)` (node env, no DOM) | `pnpm --filter @clockoff/web test`    |
| Web integration | `apps/web/test/integration/*.test.ts`             | `pnpm test:integration`               |

Integration helpers (`apps/web/test/helpers`): `callRoute(handler, { method, path, params, query, body, jar })`,
`createTestUser()`, `createTestOrg({ owner })`, `addMember(orgId, user, role)`, `loginAs(user)` → cookie jar with CSRF,
`createTestDevice(orgId)`, `lastEmailToken(email, path)`, `registerTenantIsolationCase(...)`. The global setup resets
`clockoff_test` (refuses any database whose name does not end in `_test`) and serialises concurrent runs with an
advisory lock.
