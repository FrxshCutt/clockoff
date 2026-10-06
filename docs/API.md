# Work Mode API

The machine-readable contract is **[`docs/openapi.json`](./openapi.json)** (OpenAPI 3.1, JSON Schema
2020-12). It is generated from the Zod schemas in `packages/validation` — the same schemas the route
handlers validate with — so the document cannot drift from the code:

```sh
pnpm openapi            # regenerate docs/openapi.json
pnpm --filter @workmode/validation test   # fails if the committed openapi.json is stale
```

Never edit `openapi.json` by hand. To change the API, change the schema (`packages/validation/src/*.ts`)
and, for a new endpoint, register it in `packages/validation/src/openapi/routes.ts`.

There are two APIs on one origin:

| Surface     | Prefix              | Clients           | Auth                                |
| ----------- | ------------------- | ----------------- | ----------------------------------- |
| Manager API | `/api/**`           | Next.js dashboard | Cookie session + CSRF header        |
| Mobile API  | `/api/mobile/v1/**` | iOS app           | Bearer JWT + rotating refresh token |

## Authentication

### Managers (cookie session + CSRF)

- `POST /api/auth/login` sets `wm_session` (httpOnly, opaque, hashed server-side, sliding expiry) and
  `wm_csrf` (readable by JavaScript). `wm_org` selects the current organisation; membership is re-checked on
  every request.
- Every **mutating** request (`POST`/`PUT`/`PATCH`/`DELETE`) must echo the `wm_csrf` cookie value in the
  `x-csrf-token` header (double-submit), and cross-origin mutating requests are rejected. Missing or wrong
  token → `403 CSRF_FAILED`.
- Each operation lists its required permission as `x-permission` (see `packages/shared/src/permissions.ts`
  for the role → permission map: OWNER, ADMIN, MANAGER). Missing permission → `403 FORBIDDEN`.
- Each operation states its auth mode in `x-auth`, mirroring `createHandler({ auth })` in apps/web:

  | `x-auth`  | Meaning                                                                                                                                                                                                            | Security                                       |
  | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
  | `manager` | Signed in **and** scoped to the current organisation. No organisation → `403 NO_ORGANISATION`; unverified email → `403 EMAIL_NOT_VERIFIED` when `REQUIRE_EMAIL_VERIFICATION=true`.                                 | `managerSession` (+ `csrfToken` when mutating) |
  | `user`    | Signed in, no organisation needed: `GET /api/auth/me`, password/verification routes, `GET`/`POST /api/organisations`, `POST /api/auth/switch-organisation`.                                                        | `managerSession` (+ `csrfToken` when mutating) |
  | `mobile`  | Device bearer JWT (`/api/mobile/v1/**`).                                                                                                                                                                           | `mobileBearer`                                 |
  | `public`  | No authentication (register, login, forgot/reset password, verify email, invite preview/accept, mobile join and refresh, `GET /api/health`). `POST /api/auth/logout` is public but still requires the CSRF header. | none (or `csrfToken`)                          |

- `GET /api/health` answers `200 { status: "ok", database: "ok", time }` or `503` with the same shape
  (`status: "degraded"`) for load balancers; it reveals no version or configuration.

### Employee devices (mobile)

1. `POST /api/mobile/v1/join/lookup` (public) — company code + name (+ invite code if the name is ambiguous).
2. `POST /api/mobile/v1/join/confirm` (public) — links the phone and returns
   `{ accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt, deviceId, employee, organisation }`.
3. Send `Authorization: Bearer <accessToken>` (HS256 JWT, ~15 minutes).
4. `POST /api/mobile/v1/auth/refresh` before expiry. Refresh tokens are **single use**: each refresh returns a
   new pair. Presenting an already-rotated token revokes the whole token family (`401 TOKEN_REUSED`) and the
   app must join again. A deactivated device gets `401 DEVICE_INACTIVE`.

**Privacy (§12):** every mobile request schema is a strict object at every nesting level and carries only the
operational fields listed in [PRIVACY.md](./PRIVACY.md). Unknown fields are rejected with
`400 VALIDATION_ERROR` — they are never silently dropped. The test suite injects `installedApps`, `contacts`,
`location`, `notifications`, `messages` and similar keys at every level of every mobile endpoint.

## Error envelope

Every non-2xx response has the same shape (`ApiError` in the document):

```json
{
  "error": {
    "code": "SHIFT_OVERLAP",
    "message": "Jane already has a shift at that time.",
    "details": {}
  }
}
```

- `code` is a stable identifier from `API_ERROR_CODES` (`packages/shared/src/errors.ts`); clients switch on it,
  never on `message` (human-readable, may change). Each operation lists its possible codes per status in
  `x-error-codes`.
- `VALIDATION_ERROR` details are Zod's flattened error: `{ source: "body"|"query"|"params", formErrors, fieldErrors }`.
- `RATE_LIMITED` (429) details carry `retryAfterSeconds`.

## Conventions

- **JSON, camelCase.** Request bodies are `application/json` (CSV upload is `multipart/form-data`). Bodies are
  strict: unknown keys are rejected. Responses may gain fields at any time — clients must ignore unknown keys.
- **Time.** Instants are ISO-8601 strings. Requests must include an offset (`Z` or `±hh:mm`); responses are
  always UTC with milliseconds (`2026-10-05T09:00:00.000Z`). Calendar dates are `YYYY-MM-DD` and wall-clock
  times `HH:mm`, interpreted in the named IANA `timezone` (shift → location → organisation). Shifts may be
  created either as `date` + `startTime` + `endTime` (an end at or before the start means overnight) or as
  `startsAt` + `endsAt` instants.
- **PATCH.** Omitted field = unchanged; `null` = clear. Array fields (`teamIds`, `locationIds`,
  `scheduledBreaks`) replace the whole set.
- **Ids** are UUIDs (any case accepted).
- **Query strings.** Lists may repeat the key (`?status=A&status=B`) or be comma-separated (`?status=A,B`).
  Booleans accept `true/false`, `1/0`, `yes/no`, `on/off` — `"false"` is false.
- **Action endpoints** (`/publish`, `/archive`, `/revoke`, ...) are `POST`; when every field is optional the
  body may be omitted.
- **Deletes** return `204 No Content`. Creates return `201`.

## Pagination

| Style       | Used by                                                    | Request                               | Response                                                      |
| ----------- | ---------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------- |
| Page number | employees, devices, imports, import rows, compliance lists | `?page=1&pageSize=25` (max 200)       | `{ items, page, pageSize, total, totalPages }`                |
| Cursor      | activity, audit logs, overrides, notifications             | `?cursor=<opaque>&limit=50` (max 200) | `{ items, nextCursor }` (`nextCursor: null` on the last page) |

Cursor lists are newest first. Treat cursors as opaque strings.

Time-ranged lists are bounded: `GET /api/shifts` requires `from`/`to` (≤ 93 days), the mobile schedule
defaults to 1 day back / 14 days ahead (≤ 62 days).

## Idempotency & concurrency

- `POST /api/mobile/v1/events` — each event carries a device-generated `clientEventId` (UUID); re-sending is
  safe and is counted in `duplicates`. At most 200 events per request; individually refused events are listed
  in `rejected` with an error code while the rest are accepted.
- `POST /api/mobile/v1/breaks/start` is idempotent on `clientBreakId`; a retry returns the same break.
  `POST /api/mobile/v1/breaks/:id/end` on an already-ended break returns it unchanged.
- `PATCH /api/shifts/:id` accepts `expectedVersion`; if the shift changed since, the response is
  `409 CONFLICT` (re-fetch and retry).
- Bulk endpoints (`/api/employees/bulk`, `/api/shifts/bulk`) apply per item and report per-item failures.
- Break rules are always evaluated on the server clock. Devices report `localTime` in `/device/state`; the
  server records the clock skew and returns `clockSkewSeconds` and the expected Work Mode state.

## Constraints encoded in the schemas

These are rejected with `400 VALIDATION_ERROR` before a handler runs (domain codes such as
`OVERRIDE_TOO_LONG` or `SHIFT_OVERLAP` stay with the handler):

- **Restriction config** (`RestrictionConfig`, identical to `RestrictionConfig` in
  `@workmode/shared/policy/restrictionConfig`): `categories` 1+ unique `RestrictionCategory` values,
  `requireEmployeeAppSelection`, `alwaysAllowedNote` (≤ 20 lines of ≤ 200 chars), optional `shieldMessage`
  (≤ 120), `activationMode`, `preShiftWarningMinutes` 0–120. Unknown keys are rejected.
- **Break rules** (`BreakPolicyRules`): enabled breaks need `maxBreaksPerShift ≥ 1` and
  `maxTotalBreakMinutes ≥ 1`; a single break may not exceed the total; `RELAX_CATEGORIES` needs at least one
  category. `PATCH /api/break-policies/:id` is partial — handlers re-validate the merged rules with
  `breakPolicyRulesSchema`.
- **Overrides** (`POST /api/overrides`): `reason` 5–500 characters; `employeeId` required except for
  `EMERGENCY_POLICY_OVERRIDE` (organisation-wide when omitted); `expiresAt` or `durationMinutes`
  (default 60), not both; `durationMinutes` ≤ 10080. The role cap (1440 minutes unless OWNER,
  `x-max-duration-minutes`) is applied by the handler with `resolveOverrideWindow` → `OVERRIDE_TOO_LONG`.
  `payload` is only accepted for `TEMPORARY_EXCEPTION` and holds either `breakPolicyId` or an explicit
  `restrictionBehaviour` (+ `relaxedCategories`, only with `RELAX_CATEGORIES`), never both.
- **Mobile** requests: device-reportable event types only, ≤ 200 events with unique `clientEventId`s,
  metadata `reason` is an `UPPER_SNAKE_CASE` code (no free text), device end reasons exclude
  `MANAGER_ENDED`/`POLICY_CHANGED`, hex APNs tokens only.

## Rate limits

Limits are per client IP (sliding window; `429 RATE_LIMITED` with `details.retryAfterSeconds`). Operations
that are limited carry `x-rate-limit` with the preset name (`apps/web/src/server/rateLimit`):

| Preset                                             | Endpoints                                                      | Limit                      |
| -------------------------------------------------- | -------------------------------------------------------------- | -------------------------- |
| `login`                                            | `POST /api/auth/login`                                         | 10 / 15 min per IP + email |
| `register`, `forgotPassword`, `resendVerification` | auth                                                           | 5 / hour                   |
| `resetPassword`, `verifyEmail`                     | `POST /api/auth/reset-password`, `POST /api/auth/verify-email` | 20 / hour                  |
| `changePassword`                                   | `POST /api/auth/change-password`                               | 10 / 15 min                |
| `inviteManager`                                    | manager invites                                                | 30 / hour                  |
| `acceptManagerInvite`, `lookupManagerInvite`       | invite accept / preview                                        | 10 / hour, 30 / hour       |
| `employeeInvite`                                   | employee invites                                               | 60 / hour                  |
| `mobileJoin`                                       | `/api/mobile/v1/join/*`                                        | 10 / hour                  |
| `mobileRefresh`                                    | `/api/mobile/v1/auth/refresh`                                  | 60 / 15 min                |

## Not in the document

Internal endpoints are deliberately left out of `openapi.json`: `POST /api/jobs/tick` (external cron,
`Authorization: Bearer <CRON_SECRET>`, see ARCHITECTURE.md) and the development-only `/api/dev/*` helpers
(`DEV_TOOLS_ENABLED`). Integration OAuth callbacks arrive with the Phase 2 providers (INTEGRATIONS.md).

## Realtime

`GET /api/realtime/stream` is a Server-Sent Events stream for the current organisation. Each frame is
`event: <type>`, `id: <n>`, `data: <SseEvent JSON>` (`{ type, organisationId, employeeId?, payload, at }`),
with a `: ping` comment every 25 s. Events are cache-invalidation hints (`shift.changed`,
`employee.work_state.changed`, ...): refetch the affected resource, never treat the payload as the source of
truth.

## Schemas in code

Handlers and forms import the same Zod schemas the document is generated from — `@workmode/validation`
(barrel) or a module subpath such as `@workmode/validation/employees`. Naming is uniform:

| Kind          | Export name                                                         | Example                                     |
| ------------- | ------------------------------------------------------------------- | ------------------------------------------- |
| Request body  | `create<Thing>Schema`, `update<Thing>Schema`, `<verb><Thing>Schema` | `createShiftSchema`, `publishPolicySchema`  |
| Query string  | `<thing>QuerySchema`                                                | `employeeQuerySchema`                       |
| Path params   | `<thing>ParamsSchema` (`idParamsSchema` for `:id`)                  | `importRowParamsSchema`                     |
| Response body | `<thing>ResponseSchema` / `list<Things>ResponseSchema`              | `employeeResponseSchema`                    |
| Resource      | `<thing>Schema`                                                     | `employeeSchema`, `restrictionConfigSchema` |
| Enum          | `<enumName>Schema`, values from `@workmode/shared/enums`            | `workModeStateSchema`                       |

Components named `…Input` in the document are request-only shapes (e.g. `CreateShiftInput`,
`OverridePayloadInput`); the generator also emits `<Name>Input` automatically when a shared schema has a
different request form (a field with a default). Module ↔ tag: `organisation` (Organisations, Members,
Join code), `employees`, `invites`, `devices`, `policies`, `breakPolicies`, `shifts`, `imports`,
`integrations`, `compliance`, `activity`, `overrides`, `settings`, `notifications`, `auditLogs`,
`locationsTeams` (Locations, Departments, Teams), `realtime`, `mobile`, `auth` + `authResponses` (Auth,
System). The route map — method, path, auth, permission, schemas and domain error codes per endpoint — is
`packages/validation/src/openapi/routes.ts`.

## Versioning

- The mobile API is versioned in the path (`/api/mobile/v1`). Within v1 only **additive** changes are made:
  new endpoints, new optional request fields (after a privacy review), new response fields and new enum values
  where documented as open strings. Removing or renaming a field, tightening validation of an existing field
  or changing a meaning requires `/api/mobile/v2`, served alongside v1 until old app versions age out.
- The manager API ships with the dashboard from the same deployment, so it is unversioned; it still follows
  the additive rule so a dashboard tab left open across a deploy keeps working.
- `info.version` in `openapi.json` tracks the contract; breaking changes are recorded in
  [DECISIONS.md](./DECISIONS.md).
