# Planday Open API: engineering notes

Reference for building `PlandayProvider` (see [`docs/INTEGRATIONS.md`](../INTEGRATIONS.md)). It records what
Planday's developer documentation and OpenAPI specs say, as read on **2026-10-07**, and nothing else. Every
non-obvious statement links to its source. Anything Planday does not document is listed in
[section 12](#12-open-questions-and-gaps) rather than guessed.

Conventions:

- Planday's prose is paraphrased. Paths, parameter names, field names, enum values, header names, scope
  names, format strings and numbers are copied exactly.
- **ClockOff rule** marks a decision for our implementation. It is not a Planday fact; the reason is given
  next to it.
- "Not documented" means the sources below say nothing about it. Verify it on a Planday demo portal before
  relying on it.

## 1. Sources

All sources were read on 2026-10-07. Local copies live in the session scratchpad, which is temporary and not
committed:

`/private/tmp/claude-501/-Users-zachstephens/30bf39a6-7dcf-4ac9-a3af-d36412fe7259/scratchpad/planday-docs`

- `SOURCES.txt`, `SOURCES-portal-punchclock.tsv`, `hr-agent-sources.tsv` and `sched-agent-pages/SOURCES.txt`
  map every saved file to its URL.
- `specs/<api>-v1.0-swagger.json` holds the 12 OpenAPI 3.0 specs. All 12 are also saved as
  `spec_<api>_v1.0.json`, and six (HR, Payroll, Portal, Punch Clock, Reports, Scheduling) also as top-level
  `<api>-v1.0-swagger.json`. The three HR copies differ only in server-generated example timestamps.
- `id-planday-openid-configuration.json` is the OIDC discovery document.
- `html/`, `text/`, `sched-agent-pages/` and the top-level `*.html` / `*.txt` files hold raw HTML and
  plain-text extracts of the guide pages. `img/` holds the docs screenshots (API Access page, Create App,
  Authorize, Approve, flow diagram).

| Label                 | URL                                                                                          | Covers                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [overview]            | https://openapi.planday.com/gettingstarted/overview                                          | Connection options, JSON, pagination, scope advice, demo portal                                   |
| [authorization]       | https://openapi.planday.com/gettingstarted/authorization                                     | Create App, Connect App, App ID and Token columns, required headers, refresh grant, Revoke button |
| [auth-flow]           | https://openapi.planday.com/gettingstarted/authorization-flow                                | Authorization code flow, token response, lifetimes, revocation endpoint                           |
| [rate-limiting]       | https://openapi.planday.com/gettingstarted/rate-limiting                                     | Rate limits and `x-ratelimit-*` headers                                                           |
| [release-notes]       | https://openapi.planday.com/gettingstarted/release_notes                                     | Dated API changes                                                                                 |
| [api-support]         | https://openapi.planday.com/gettingstarted/api-support                                       | Support contact                                                                                   |
| [partner]             | https://openapi.planday.com/gettingstarted/become-an-integration-partner                     | Partner certification                                                                             |
| [errors]              | https://openapi.planday.com/guides/errors                                                    | HTTP status codes                                                                                 |
| [structure]           | https://openapi.planday.com/guides/planday-structure                                         | Portals, departments, employee groups, id uniqueness                                              |
| [hr-guide]            | https://openapi.planday.com/guides/hr-guide                                                  | Employee list vs detail, special fields, custom fields                                            |
| [timeclock-guide]     | https://openapi.planday.com/guides/timeclock-guide                                           | Punch Clock scopes, approval, breaks                                                              |
| [timeandcost-guide]   | https://openapi.planday.com/guides/timeandcost-guide                                         | Time and Cost (excludes open shifts)                                                              |
| [portal-spec]         | https://openapi.planday.com/portal/swagger/v1.0/swagger.json                                 | Portal API spec                                                                                   |
| [hr-spec]             | https://openapi.planday.com/hr/swagger/v1.0/swagger.json                                     | HR API spec (OpenAPI 3.0.4)                                                                       |
| [scheduling-spec]     | https://openapi.planday.com/scheduling/swagger/v1.0/swagger.json                             | Scheduling API spec (OpenAPI 3.0.4)                                                               |
| [punchclock-spec]     | https://openapi.planday.com/punchclock/swagger/v1.0/swagger.json                             | Punch Clock API spec                                                                              |
| [payroll-spec]        | https://openapi.planday.com/payroll/swagger/v1.0/swagger.json                                | Payroll API spec (breaks only; not used)                                                          |
| [reports-spec]        | https://openapi.planday.com/reports/swagger/v1.0/swagger.json                                | Reports API spec (not used)                                                                       |
| [pay-spec]            | https://openapi.planday.com/pay/swagger/v1.0/swagger.json                                    | Pay API spec (not used)                                                                           |
| [absence-spec]        | https://openapi.planday.com/absence/swagger/v1.0/swagger.json                                | Absence API spec (not used)                                                                       |
| [contractrules-spec]  | https://openapi.planday.com/contractrules/swagger/v1.0/swagger.json                          | Contract Rules API spec (not used)                                                                |
| [revenue-spec]        | https://openapi.planday.com/revenue/swagger/v1.0/swagger.json                                | Revenue API spec (not used)                                                                       |
| [datacenter-spec]     | https://openapi.planday.com/datacenter/swagger/v1.0/swagger.json                             | Data Center API spec (not used)                                                                   |
| [securitygroups-spec] | https://openapi.planday.com/securityGroupMembership/swagger/v1.0/swagger.json                | Security group membership API spec (not used)                                                     |
| [hr-versions]         | https://openapi.planday.com/hr/swagger/version                                               | Machine-readable version list                                                                     |
| [scheduling-versions] | https://openapi.planday.com/scheduling/swagger/version                                       | Returned HTTP 404 on 2026-10-07                                                                   |
| [oidc-discovery]      | https://id.planday.com/.well-known/openid-configuration                                      | Identity server metadata (not referenced by the prose docs)                                       |
| [docs-nav]            | https://openapi.planday.com/page-data/sq/d/1635659820.json                                   | Docs site navigation (the API menu)                                                               |
| [docs-loader]         | https://openapi.planday.com/2e63f7a790fcdc92df61af13efc7c62164438e9b-fa3a50face8c13be31c3.js | Docs site code that loads each spec                                                               |
| [docs-app]            | https://openapi.planday.com/app-abca979233297787b2fa.js                                      | Docs site app bundle (spec loader, `v1.0` default)                                                |
| [schedule-page]       | https://openapi.planday.com/api/schedule?version=v1.0                                        | Rendered Scheduling reference (Redoc)                                                             |
| [help-drafts]         | https://help.planday.com/en/articles/30569-how-to-use-draft-shifts-in-planday                | Help Center (product docs, not API reference): draft shifts                                       |
| [help-hide-days]      | https://help.planday.com/en/articles/30436-hide-days-or-periods-on-the-schedule              | Help Center: hidden days and periods                                                              |
| [status]              | https://status.planday.com/                                                                  | Status page (incident webhooks only)                                                              |

The API reference pages at `https://openapi.planday.com/api/<name>` are Redoc renders of the specs above.
On any planday.com origin the docs site fetches
`https://openapi.planday.com/{apiName}/swagger/{version}/swagger.json` (other origins use
`https://openapi.stag.planday.cloud`), with `version` defaulting to `v1.0` ([docs-loader], [docs-app]).
`developer.planday.com` serves the same site: on 2026-10-07 its pages loaded the same
`app-abca979233297787b2fa.js` bundle. Support is by email to `apisupport@planday.com`, using a template that
asks for the App ID, portal URL and request/response details ([api-support]). Planday's Postman collection is
also requested by email ([overview]).

## 2. Base URLs and versioning

| Purpose                                           | Base URL                                                  | Source           |
| ------------------------------------------------- | --------------------------------------------------------- | ---------------- |
| REST API                                          | `https://openapi.planday.com`                             | [authorization]  |
| Identity server (authorize, token, revocation)    | `https://id.planday.com`                                  | [auth-flow]      |
| OIDC discovery (not referenced by the prose docs) | `https://id.planday.com/.well-known/openid-configuration` | [oidc-discovery] |

- The Open API requires HTTPS ([auth-flow]).
- None of the 12 specs declares `servers` ([scheduling-spec], [hr-spec]). Each operation path carries its
  API domain and version:

  | API         | Path prefix                                             | Example                             |
  | ----------- | ------------------------------------------------------- | ----------------------------------- |
  | Portal      | `/portal/v1.0/`                                         | `/portal/v1.0/info`                 |
  | HR          | `/hr/v1.0/`                                             | `/hr/v1.0/employees`                |
  | Scheduling  | `/scheduling/v1.0/`                                     | `/scheduling/v1.0/shifts`           |
  | Punch Clock | `/punchclock/v1.0/`                                     | `/punchclock/v1.0/punchclockshifts` |
  | Data Center | `/datacenter/v{version}/` (version is a path parameter) | not used by ClockOff                |

- The getting-started sample calls `GET https://openapi.planday.com/hr/v1/Departments` (`v1`, capital `D`),
  while the HR spec path is `/hr/v1.0/departments` ([authorization], [hr-spec]). **ClockOff rule:** use the
  spec paths exactly (`v1.0`, spec casing). They are what the reference documents.
- The version is a path segment. `https://openapi.planday.com/hr/swagger/version` lists only `V1.0`, with
  `isDeprecated: false` ([hr-versions]). The Scheduling equivalent returned HTTP 404
  ([scheduling-versions]). No versioning or deprecation policy is documented.
- The `X-OpenAPI-Region` header has had no effect since 01.10.2024, when Planday retired its Australia region
  ([release-notes]). **ClockOff rule:** do not send it.
- All request and response bodies are JSON ([overview]).
- No sandbox or staging environment is documented for integrators. Development uses demo portals requested
  from Planday ([overview], [authorization]). The docs do not say where demo portals run, but a partner's app
  created on a demo portal is authorized on customers' portals through the same `id.planday.com`
  ([authorization], [auth-flow]).
- **Identifiers.** Only `portalId` is globally unique. `employeeId`, `shiftId`, `departmentId` and every other
  id are unique only within one portal, so Planday says to store the portal id with every entity
  ([structure]). **ClockOff rule:** record the portal id (`GET /portal/v1.0/info` → `data.id`) in
  `Integration.settings` at connect time. On every later connect or token change, check the token still
  resolves to the same portal id, and refuse to sync if it does not. `externalEmployeeId = PLANDAY:<id>` is
  only safe while one ClockOff organisation maps to exactly one Planday portal.

## 3. Authorization

### 3.1 Model

- Planday uses OAuth 2 with bearer tokens. An API application is created in Planday and must then be
  authorized separately on every portal whose data it reads ([authorization]).
- Each portal that authorizes the app produces its own refresh token ([authorization]).
- An authorized app can reach all data in its scopes that the authorizing administrator can reach, for every
  user that administrator manages ([authorization]).
- Scopes cannot be added after an app is created. Planday advises choosing all scopes for the test app if
  the needed scopes are not yet known, and only the minimal set for the production app ([overview]).
- The app's name is shown to customers when they authorize it ([authorization]).
- A 401 can mean the user who authorized the app is no longer active ([errors]). The connection depends on
  that administrator's account staying active.
- **Product partners** create one API app in their Planday demo portal, and each customer authorizes that app
  on their own portal. A demo account is requested from `apisupport@planday.com` ([authorization]). The
  overview also links a request form for a demo portal ([overview]).
- **Certification** applies to integrations offered for general availability, not custom integrations. It has
  six steps: build (one test app and one production app, the production app named after the product and
  without words such as "prod"), pilot with live customers (at least 2 preferred, 1 sometimes accepted),
  submit the Partner Certification form and a demo, publish public setup documentation, provide listing
  assets in every market language, and promote. Approval is confirmed by email. Certified partners are listed
  on planday.com and on the in-product integrations page ([partner]). The docs describe no approval gate
  before customers can connect an uncertified app.

### 3.2 The three connection methods ClockOff supports

Planday's overview names two ways to connect: manually through Settings in Planday, or through the auth flow
([overview]). ClockOff's methods B and C are both "manual via Settings".

| Method                                | Planday docs                                  | `client_id` and `X-ClientId` | How ClockOff gets the refresh token                            | Who controls the scopes   |
| ------------------------------------- | --------------------------------------------- | ---------------------------- | -------------------------------------------------------------- | ------------------------- |
| A. OAuth authorization code           | Authorization code flow ([auth-flow])         | ClockOff's App ID            | `POST /connect/token` with `grant_type=authorization_code`     | ClockOff (production app) |
| B. Customer adds ClockOff's App ID    | "Connect App" on API Access ([authorization]) | ClockOff's App ID            | Admin copies it from the Token column and gives it to ClockOff | ClockOff (production app) |
| C. Customer creates their own API app | "Create App" on API Access ([authorization])  | The customer's App ID        | Admin gives ClockOff their App ID and the Token column value   | The customer              |

After methods B and C, ClockOff holds a refresh token and calls the refresh grant (section 3.3) to get access
tokens. All three methods end in the same stored credentials: `{ appId, refreshToken }` plus a cached access
token and expiry.

**Rate-limit consequence.** Limits apply per client id as well as per portal (section 6). Under methods A
and B every customer shares ClockOff's App ID budget. Under method C each customer's app has its own.

#### A. Authorization code flow ([auth-flow])

1. Redirect the user's browser to:

   ```text
   https://id.planday.com/connect/authorize?client_id={clientId}&response_type=code&redirect_uri={redirectUri}&scope={scopes}&state={state}
   ```

   | Parameter       | Required | Value                                                                                                         |
   | --------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
   | `client_id`     | yes      | The App ID                                                                                                    |
   | `redirect_uri`  | yes      | One of the Redirection URLs set on the app (up to 3; localhost allowed for development). Must be URL-encoded. |
   | `response_type` | yes      | `code`                                                                                                        |
   | `scope`         | yes      | Space-separated list of every scope selected when the app was created, plus `openid` and `offline_access`     |
   | `state`         | no       | Opaque value for CSRF protection                                                                              |

   Planday's example (line break removed):
   `client_id=f2370889-3ffe-46b6-83e7-1a20f5a20d2f&scope=openid%20offline_access%20employee:read&redirect_uri=http://example.com/code&response_type=code&state=xyzABC123`.

   **ClockOff rule:** always send `state`, store it server-side and reject a callback whose `state` does not
   match. Planday marks it optional; `docs/INTEGRATIONS.md` already requires it.

2. On Planday's login page the user enters a portal address or picks a recently used portal. A consent screen
   then lists the requested scopes ([auth-flow]).
3. Planday redirects to `{redirectURL}?code={code}&state={state}`. The `code` is single-use ([auth-flow]).
4. Exchange the code ([auth-flow]):

   ```http
   POST https://id.planday.com/connect/token
   Content-Type: application/x-www-form-urlencoded

   client_id={App ID}&grant_type=authorization_code&code={code}&redirect_uri={redirect URL}
   ```

   The docs list exactly these four body parameters. There is no `client_secret` and no `code_verifier`.

5. Response (JSON) ([auth-flow]):

   | Field           | Meaning                                                                      |
   | --------------- | ---------------------------------------------------------------------------- |
   | `id_token`      | OIDC identity token for the user who authorized                              |
   | `access_token`  | Bearer token for API calls                                                   |
   | `expires_in`    | Remaining access-token lifetime in seconds (`3600` in the example)           |
   | `token_type`    | Always `Bearer`                                                              |
   | `refresh_token` | Used to get new access tokens                                                |
   | `scope`         | Space-separated granted scopes (example: `openid shift:read offline_access`) |

   The example `id_token` and `access_token` are JWT-looking strings starting with `eyJ`; the example
   `refresh_token` (`VxLtcy_OWkWoPKqs4uFhTg`) is a short opaque string. Token formats and lengths are not
   specified, and the claims are not documented. The discovery document's `claims_supported` includes
   `PortalId`, `PortalTimeZoneId`, `Email`, `FullName` and `UserName` ([oidc-discovery]).

   **ClockOff rule:** discard `id_token` without persisting it, because it identifies the administrator.
   Encrypt `refresh_token` at rest. Check that the returned `scope` contains every scope in section 5.2 and
   fail the connect with a clear message if one is missing. Identify the portal with `GET /portal/v1.0/info`
   (after authorization the docs say "you can use the Portal Api" for basic company information
   ([auth-flow])), and not with undocumented token claims.

**Redirect URI.** ClockOff's callback (`${APP_URL}/api/integrations/planday/callback` per
`docs/INTEGRATIONS.md`) must be one of the app's (at most 3) Redirection URLs ([auth-flow]). Exact-match
rules, custom URI schemes and where the Create App form takes the Redirection URL are not documented. The
Create App screenshot shows only a title and scopes.

**PKCE** is not mentioned in the developer docs. The discovery document advertises
`code_challenge_methods_supported: ["plain", "S256"]` ([oidc-discovery]), but whether API apps accept or
require PKCE is not documented. **ClockOff rule:** implement the documented exchange without PKCE. Add PKCE
only after testing it against the demo portal.

#### B. Customer adds ClockOff's App ID ([authorization])

The docs describe this for connecting an app that already exists to another portal:

1. A Planday Administrator opens **Settings > Integrations > API Access**. Only Administrators can open it.
2. They click **Connect App** (top right), enter the App ID and click **Save**.
3. They click **Authorize** next to the app and approve the consent screen.
4. The API Access page shows the App ID in the **App Id** column and the refresh token in the **Token**
   column. The app must be authorized first.

The administrator then gives ClockOff the Token value. ClockOff calls the refresh grant with its own App ID.

Caveat: the docs present Connect App inside the customer flow, for "several different Planday portals that
you administer", and point Product Partners' customers to the authorization code flow instead
([authorization]). The API Access page itself offers to "connect to an existing app by entering the App ID"
(API Access screenshot). Whether a customer may Connect App with a partner's App ID is therefore not
explicitly documented; confirm it with `apisupport@planday.com` before offering method B.

**ClockOff rule:** the pasted token is a non-expiring credential (section 3.5). Accept it only over HTTPS,
encrypt it at rest, never log it, never echo it back to the UI, and validate it straight away: one refresh
grant, then `GET /portal/v1.0/info`.

#### C. Customer creates their own API app ([authorization])

1. Administrator opens **Settings > Integrations > API Access**.
2. **Create App**: choose resources in the **Scopes** section, enter a short name and click **Save**. The
   docs screenshot shows a grid of resources (Bank Account, Birth Date, Department, ...) with ALL, READ,
   CREATE, UPDATE and DELETE checkboxes.
3. **Authorize** next to the app, then approve the consent screen.
4. Copy the App ID (App Id column) and refresh token (Token column).

The customer gives ClockOff both values. ClockOff uses the customer's App ID as `client_id` on token requests
and as the `X-ClientId` header.

**ClockOff rule:** ClockOff cannot see or limit the scopes the customer ticked. The refresh grant is not
documented to return `scope`. So:

- Setup instructions must tell the customer to tick only the read scopes in section 5.2.
- After connecting, probe each required endpoint once with `limit=1`. A 403 means a missing scope
  ([errors]); fail the connect and name the missing scope.
- Never call anything outside section 9, whatever the app was granted.

### 3.3 Refresh grant ([authorization])

```http
POST https://id.planday.com/connect/token
Content-Type: application/x-www-form-urlencoded

client_id={App ID}&grant_type=refresh_token&refresh_token={refresh token}
```

- There is no `client_secret`.
- The docs only promise a JSON response containing `access_token`. They do not say whether the refresh
  response also returns `refresh_token`, `expires_in` or `scope`.
- Token endpoint error bodies (for example for a revoked refresh token) are not documented.

**ClockOff rule:**

- Serialise refreshes per integration so two jobs never refresh the same token at once.
- If the response contains `refresh_token`, save it (via `sink.saveCredentials`) before using the new access
  token. This covers rotation if Planday does it, which is undocumented (section 3.5).
- If `expires_in` is missing, assume 3600 seconds ([auth-flow]) and refresh a few minutes early.
- A 400 or 401 from the token endpoint maps to `ProviderError("PLANDAY", "AUTH_EXPIRED", ...)`. A 5xx or
  network failure maps to `PROVIDER_ERROR` (retryable). The error format is undocumented, so do not branch
  on the body.

### 3.4 Client secret, grant types, introspection

- No documented flow uses a client secret. Authorize, token, refresh and revocation requests carry only
  `client_id` (the App ID) ([authorization], [auth-flow]).
- The identity server's discovery document lists `token_endpoint_auth_methods_supported:
["client_secret_basic", "client_secret_post"]` ([oidc-discovery]). That is server-wide metadata, not
  documentation for Planday API apps.
- Discovery lists `grant_types_supported`: `authorization_code`, `client_credentials`, `refresh_token`,
  `implicit`, `password`, `urn:ietf:params:oauth:grant-type:device_code`, `token_exchange`
  ([oidc-discovery]). Only `authorization_code` and `refresh_token` are documented for API integrations.
  **ClockOff rule:** use only those two.
- Discovery lists `introspection_endpoint: https://id.planday.com/connect/introspect` ([oidc-discovery]). It is
  not documented for API apps; do not use it.
- **ClockOff rule:** do not add `PLANDAY_CLIENT_SECRET` (planned in `docs/INTEGRATIONS.md`) unless Planday
  confirms API apps have a secret. `PLANDAY_CLIENT_ID` (ClockOff's App ID) is the only app-level credential
  the docs define.

### 3.5 Token lifetimes and rotation

| Token         | Lifetime                                                                                                        | Source      |
| ------------- | --------------------------------------------------------------------------------------------------------------- | ----------- |
| Access token  | 1 hour. `expires_in` gives the remaining seconds (3600 in the example). Get a new one with the refresh token.   | [auth-flow] |
| Refresh token | Does not expire. If it is lost or the user revokes access, the full authorization code flow has to be repeated. | [auth-flow] |

- Refresh-token rotation is not documented (section 3.3).
- How a manually connected portal (methods B and C) re-issues a token after revocation or loss is not
  documented. The docs only describe repeating the authorization code flow.

### 3.6 Revocation

ClockOff-initiated disconnect ([auth-flow]):

```http
POST https://id.planday.com/connect/revocation
Content-Type: application/x-www-form-urlencoded

client_id={App ID}&token={refresh token}
```

- Both parameters are required. The response format is not documented.
- Only revoking the refresh token is shown. Revoking access tokens is not documented, and neither is whether
  revoking the refresh token also invalidates access tokens already issued.
- Discovery also lists `revocation_endpoint: https://id.planday.com/connect/revocation` ([oidc-discovery]).

Customer-initiated: an administrator can pause or stop the app at any time with the **Revoke** button next to
it on the API Access page. The app can also be renamed or deleted permanently there ([authorization]).
Nothing documents a notification to the integrator when this happens.

**ClockOff rule:**

- `disconnect` calls the revocation endpoint with the stored refresh token. It then deletes the credentials
  whatever the response, because the response is undocumented.
- Admin-side revocation is only visible as a failed refresh or a 401 on an API call. Handle it as
  `AUTH_EXPIRED` per section 3.3.

## 4. Required headers

Every API request must carry both headers ([authorization]):

```http
X-ClientId: {App ID}
Authorization: Bearer {access_token}
```

- In the specs, only Contract Rules and Revenue declare `X-ClientId` as an `apiKey` security scheme ("Application
  Id related with the access token"). The other 10 specs declare only the Bearer scheme ([revenue-spec],
  [contractrules-spec]). The rate-limit page's curl examples send only `Authorization` ([rate-limiting]).
  **ClockOff rule:** always send both. The prose requirement is explicit.
- `X-ClientId` is the App ID of the app that issued the token: ClockOff's for methods A and B, the customer's
  for method C.
- Bodies are JSON ([overview]). ClockOff only makes GET calls to the API, so it sends no body.
- Token and revocation requests to `id.planday.com` use `Content-Type: application/x-www-form-urlencoded`
  ([auth-flow]). The docs do not show `X-ClientId` on those requests.
- Do not send `X-OpenAPI-Region` (section 2).

## 5. Scopes

### 5.1 How scopes work

- Scopes are chosen in the **Scopes** section of the Create App form ([authorization]) and cannot be added
  later ([overview]).
- The authorize request must list all of the app's scopes plus `openid offline_access`, separated by spaces
  ([auth-flow]).
- Each API's scope names are in its reference ([auth-flow]). The specs give them in "Scopes used" tag tables
  and per-operation "Authorization policy" or "Required scope" lines ([scheduling-spec], [hr-spec],
  [punchclock-spec]).
- The identity server's `scopes_supported` contains every `resource:action` scope the 12 specs name, plus
  scopes that no endpoint names ([oidc-discovery]). Some specs instead name policies that are not scopes in
  discovery, such as `EmployeeReadSkillRead` ([hr-spec]) and `UseDepartmentSalaryIdentifiers` ([pay-spec]),
  or write scopes as words ("revenue read", "securitygroups read") ([revenue-spec], [securitygroups-spec]).

### 5.2 Scopes ClockOff requests

| ClockOff need      | Scope                      | Unlocks (section 9)                                                                                                                                           | Source                               |
| ------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| OIDC / refresh     | `openid`, `offline_access` | Required in the authorize request                                                                                                                             | [auth-flow]                          |
| Portal info        | **none documented**        | `GET /portal/v1.0/info`. The spec states no scope, and discovery has no `portal:read` (only `portal:create`, a write).                                        | [portal-spec], [oidc-discovery]      |
| Departments        | `department:read`          | `GET /hr/v1.0/departments`, `GET /hr/v1.0/departments/{id}`                                                                                                   | [hr-spec]                            |
| Employee groups    | `employeegroup:read`       | `GET /hr/v1.0/employeegroups`, `GET /hr/v1.0/employeegroups/{id}`                                                                                             | [hr-spec]                            |
| Employees (read)   | `employee:read`            | `GET /hr/v1.0/employees`, `/employees/deactivated`, `/employees/{employeeId}`, `/departments/{id}/employees`, `/employeegroups/{id}/employees`                | [hr-spec]                            |
| Shifts (read)      | `shift:read`               | `GET /scheduling/v1.0/shifts`, `/shifts/{shiftId}`, `/shifts/deleted`, `/shifts/shiftstatus/all`, `/scheduleDay`; `GET /punchclock/v1.0/employeeshifts/today` | [scheduling-spec], [punchclock-spec] |
| Punch clock (read) | `punchclockshift:read`     | `GET /punchclock/v1.0/punchclockshifts`, `/punchclockshifts/byShift/{shiftId}`, `/punchclockshifts/{punchClockShiftId}/breaks`                                | [punchclock-spec]                    |

Notes:

- The id-only membership endpoints (`/departments/{id}/employees`, `/employeegroups/{id}/employees`) need
  `employee:read`, not `department:read` or `employeegroup:read` ([hr-spec]).
- `GET /punchclock/v1.0/employeeshifts/today` needs `shift:read`, not a punch clock scope ([punchclock-spec]).
- Planday's time-clock guide suggests Department read, Employee read, Shifts read and Punch Clock read/create
  ([timeclock-guide]). ClockOff never writes to Planday, so it requests read only. `punchclockshift:create`
  is not requested.
- Derived authorize `scope` value for method A:
  `openid offline_access department:read employeegroup:read employee:read shift:read punchclockshift:read`.
- **Before creating the production app**, confirm on a demo portal (with a test app that has only these
  scopes) that `GET /portal/v1.0/info` succeeds. Its scope is undocumented, and scopes cannot be added later.

### 5.3 Scopes ClockOff must not request

| Area           | Scope names                                                                                                                                              | Source                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Pay            | `payrates:read`, `payrates:update`, `salaries:read`, `salaries:update`                                                                                   | [pay-spec], [oidc-discovery]     |
| Payroll        | `payroll:read` (the Payroll spec itself states no scope)                                                                                                 | [oidc-discovery], [payroll-spec] |
| Contract rules | `contractrules:read`, `contractrules:update`                                                                                                             | [oidc-discovery]                 |
| Absence        | `absence:read`, `absence:create`, `absence:update`, `absencesettings:read`, `absencesettings:create`, `absencesettings:update`, `absencesettings:delete` | [absence-spec], [oidc-discovery] |
| Revenue        | `revenue:read`, `revenue:set`, `revenue:update`, `revenue:delete` (discovery's colon form; the spec text writes "revenue read/set/update/delete")        | [oidc-discovery], [revenue-spec] |
| Data Center    | `datacenter:read`, `datacenter:create`                                                                                                                   | [datacenter-spec]                |

**ClockOff rule:** these are also out, because ClockOff does not need them:

- HR special fields: `ssn:*`, `bankaccount:*`, `birthdate:*` ([oidc-discovery]). The HR guide says reading
  SSN, BankAccount and BirthDate needs "dedicated scopes" plus an explicit request parameter ([hr-guide]).
  The pairing with these scope names follows only from the names.
- `employee:history`, which returns raw changed values ([hr-spec]).
- `timeandcost:read`, which returns wage cost per shift ([scheduling-spec]).
- `shiftposition:read`, `shifttype:read`, `employeetype:read`, `skill:read`, `securitygroups:read`,
  `securitygroupmembership:*`, `punchclockkioskdevice:*`, `punchclockkioskprofile:*`, and the OIDC scopes
  `email` and `plandayid` ([oidc-discovery], [securitygroups-spec]).
- Every write scope: `*:create`, `*:update`, `*:delete`, `employee:deactivate`, `portal:create`,
  `punchclockshift:create`, `skill:*`, `shifttype:delete`. This includes the Reports API, whose
  `POST /reports/v1.0/schedulingHistory` states the policy "shift update" even though it only reads
  ([reports-spec]).

**Consequence:** manual and rule-based break details exist only in the Payroll API, and in Reports
`schedulingHistory` (section 10.4). Without those scopes ClockOff cannot import scheduled breaks from Planday.
Only Punch Clock breaks are readable.

**Method C caveat:** the customer chooses the scopes, so a customer app may carry any of the above. See the
ClockOff rule in section 3.2 C.

## 6. Rate limits

| Window     | Per portal | Per client id |
| ---------- | ---------- | ------------- |
| Per second | 20         | 100           |
| Per minute | 750        | 2000          |

Source: [rate-limiting].

- Every request carries one client id and one portal, and counts against both buckets ([rate-limiting]).
- **The page contradicts itself.** The table and the header example give 20 per second per portal
  (`20;w=1`), but the worked explanation says the portal is allowed 10 per second (`10;w=1`)
  ([rate-limiting]). **ClockOff rule:** budget 10 requests per second per portal until Planday confirms the
  figure.
- Exceeding a limit returns `429`. Do not retry until the counter resets ([rate-limiting]).
- Status headers ([rate-limiting]):

  ```http
  HTTP/2 429
  x-ratelimit-limit: 2000, 20;w=1, 750;w=60, 100;w=1, 2000;w=60
  x-ratelimit-remaining: 0
  x-ratelimit-reset: 33
  ```

  - `x-ratelimit-reset`: seconds until the window resets.
  - `x-ratelimit-remaining`: requests left.
  - `x-ratelimit-limit`: first the limit of the window closest to being used up, then the full policy as
    `limit;w=<window seconds>`.

- **`Retry-After` is not documented.** Only the three `x-ratelimit-*` headers are.
- Per-endpoint limits and limits on `id.planday.com` (token and revocation) are not documented.

**ClockOff rule:**

- Keep two limiters: one per client id (shared by all method A and B customers) and one per portal.
- On `429`, wait `x-ratelimit-reset` seconds. If the header is missing, wait 60 seconds (the longest
  documented window). Then retry; once retries are exhausted, reject with `RATE_LIMITED`.
- Read `x-ratelimit-remaining` to slow down before a 429.
- Capacity check for methods A and B: a one-minute clock-event poll costs at least one request per
  `CLOCK_EVENT` portal per minute against ClockOff's shared 2000 per minute client-id bucket, before paging,
  retries and other syncs. That shared bucket, not the per-portal one, will be the first limit ClockOff hits
  as customers are added.

## 7. Pagination

- Most endpoints are offset-paginated and return at most 50 records per page ([overview]).
- The parameters are `limit` and `offset`. They are lowercase in HR, Scheduling, Revenue and Punch Clock, and
  `Limit` / `Offset` in Absence ([hr-spec], [scheduling-spec], [revenue-spec], [punchclock-spec],
  [absence-spec]).
- The standard descriptions say `limit` returns no more than that many records and `offset` skips that many
  records ([hr-spec]).
- Paged responses look like this ([scheduling-spec]):

  ```json
  { "data": [], "paging": { "offset": 0, "limit": 50, "total": 0 } }
  ```

  `total` is `int64` in Scheduling. `paging` is nullable in some specs.

| Endpoint (ClockOff uses)                                                              | `limit` default | `limit` max  | Paging object                        | Source            |
| ------------------------------------------------------------------------------------- | --------------- | ------------ | ------------------------------------ | ----------------- |
| `GET /hr/v1.0/employees`, `/employees/deactivated`, `/departments`, `/employeegroups` | 50              | 50           | `{offset, limit, total}`             | [hr-spec]         |
| `GET /hr/v1.0/departments/{id}/employees`, `/employeegroups/{id}/employees`           | none            | none         | none: no paging parameters or object | [hr-spec]         |
| `GET /scheduling/v1.0/shifts`                                                         | 50              | 5000 (min 1) | `{offset, limit, total}`             | [scheduling-spec] |
| `GET /scheduling/v1.0/shifts/deleted`                                                 | 50              | 1000         | `{offset, limit, total}`             | [scheduling-spec] |
| `GET /scheduling/v1.0/scheduleDay`                                                    | 50              | 50           | `{offset, limit, total}`             | [scheduling-spec] |
| `GET /punchclock/v1.0/punchclockshifts`                                               | **0**           | not stated   | `{offset, limit, total}`             | [punchclock-spec] |
| `GET /punchclock/v1.0/employeeshifts/today`, `/punchclockshifts/{id}/breaks`          | none            | none         | `{total}` only (`TotalPaging`)       | [punchclock-spec] |

- Punch Clock's `PaginationResponse` says the returned `limit` is the requested one, possibly lowered to the
  default maximum. That maximum is not stated ([punchclock-spec]).
- Sort order is not documented for any list.

**ClockOff rule** (paging loop):

1. Always send an explicit `limit`: 50 for HR, the documented maximum for Scheduling, and 50 for Punch Clock
   until its maximum is known. Never rely on Punch Clock's default of `0`.
2. Advance with `offset += data.length`, not by the requested limit, because the server may lower it.
3. Stop when `data` is empty or `offset >= paging.total`.
4. Because sort order is undocumented and data can change between pages, upsert by id and let the next
   incremental run catch anything missed.

## 8. Errors

From the Errors guide ([errors]):

| Status | Meaning per Planday                                                                                                 | ClockOff handling (rule)                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 400    | Invalid employee id: it does not exist or the user is no longer active                                              | Record-level `UNKNOWN_EMPLOYEE`; skip the record                                                   |
| 401    | Credentials not sufficient: exchange the refresh token for an access token, or check the authorizing user is active | Refresh once and retry. If it still fails, `AUTH_EXPIRED`.                                         |
| 403    | The app does not have the scope for this action                                                                     | `AUTH_EXPIRED` (reconnect needed), naming the missing scope. `PROVIDER_ERROR` would retry forever. |
| 404    | Not found                                                                                                           | For by-id reads, treat as gone (shift deleted, no punch record)                                    |
| 409    | Validation error                                                                                                    | Not expected for GETs; `PROVIDER_ERROR`                                                            |
| 429    | Rate limit exceeded                                                                                                 | Section 6                                                                                          |
| 500    | Server error                                                                                                        | `PROVIDER_ERROR` (retryable, with backoff)                                                         |

Body shapes:

- Most specs define RFC 7807-style `ProblemDetails`: `type`, `title`, `status` (`int32`), `detail`,
  `instance`, plus additional properties ([scheduling-spec]).
- Punch Clock, Reports and Security Group Membership also define `ValidationProblemDetails`, which adds
  `errors: { <field>: [messages] }` ([punchclock-spec], [reports-spec], [securitygroups-spec]). The Scheduling
  and HR specs do not define it.
- Many 401, 403 and 429 responses have a description but no schema ([scheduling-spec]). **ClockOff rule:** do
  not assume a parseable body. Key behaviour off the status code and keep at most a truncated body in
  `lastError`.
- Punch Clock also has a legacy shape `{ "error": { "code", "message" } }` kept for older endpoints; new
  endpoints prefer `ProblemDetails` ([punchclock-spec]).
- Token and revocation endpoint error formats are not documented (section 3).

## 9. Endpoints ClockOff uses

ClockOff only calls the GET endpoints below. Every other endpoint, including all writes, is out of scope.

**ClockOff rule (personal data):** parse every response with an allow-list. Copy only the "Uses" fields into
ClockOff types at the HTTP-client boundary, and never store or log raw payloads. The "Strip" column shows what
the allow-list drops. It matters most for employees: `GET /hr/v1.0/employees/{employeeId}` allows additional
properties, so unknown portal-defined custom fields arrive there ([hr-spec], [hr-guide]). Recorded test
fixtures must be scrubbed of the "Strip" fields too.

`employeeId` on shifts and punch records is personal data, because it links a record to a person. ClockOff
keeps it only to map the record to `Employee.externalEmployeeId`.

### 9.1 Portal ([portal-spec])

| Method | Path                | Scope           | Params | Uses                                                                                                                                | Strip                                                     |
| ------ | ------------------- | --------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| GET    | `/portal/v1.0/info` | none documented | none   | `data.id` (int64, the portal id), `data.name`, `data.companyName`, `data.country`, `data.timeZone`, `data.portals[]` (`id`, `name`) | none personal. `aliases` and `maxDepartments` are unused. |

- This is the only Portal endpoint. It describes the portal linked to the token, including country, time
  zone, aliases, company name and any child portals ([portal-spec], [release-notes]).
- Full output: `id` int64, `name`, `companyName`, `country`, `timeZone`, `maxDepartments` int32 nullable,
  `aliases` string[] nullable, `portals` nullable array of `{id int64, name, aliases}`.
- There is no culture, locale or language field. The formats of `timeZone` (IANA or Windows) and `country`
  (code or display name) are not documented.

### 9.2 HR ([hr-spec])

| Method | Path                                     | Scope                | Params ClockOff sends                                                                                         | Uses                                                                                                                                                                             | Strip                                                                                          |
| ------ | ---------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| GET    | `/hr/v1.0/departments`                   | `department:read`    | `limit`, `offset`                                                                                             | `id`, `name`, `number`                                                                                                                                                           | none                                                                                           |
| GET    | `/hr/v1.0/departments/{id}`              | `department:read`    | `includeDeleted` (bool, default false). Do not send `managedEmployeesOnly` (deprecated, no effect).           | `id`, `name`, `number`                                                                                                                                                           | none                                                                                           |
| GET    | `/hr/v1.0/employeegroups`                | `employeegroup:read` | `limit`, `offset`                                                                                             | `id`, `name`                                                                                                                                                                     | none                                                                                           |
| GET    | `/hr/v1.0/employeegroups/{id}`           | `employeegroup:read` | `id` (min 1)                                                                                                  | `id`, `name`                                                                                                                                                                     | none                                                                                           |
| GET    | `/hr/v1.0/employees`                     | `employee:read`      | `limit`, `offset`, `modifiedFrom` / `modifiedTo` for incremental runs (`createdFrom` / `createdTo` exist too) | `id`, `firstName`, `lastName`, `email`, `departments[]`, `primaryDepartmentId`, `employeeGroups[]`, `deactivationDate`, `dateTimeDeleted`, `dateTimeCreated`, `dateTimeModified` | Strip set **E** (below)                                                                        |
| GET    | `/hr/v1.0/employees/deactivated`         | `employee:read`      | `limit`, `offset`, `deactivatedFrom` / `deactivatedTo`, `modifiedFrom` / `modifiedTo`                         | `id`, `deactivationDate` (effective dismissal date), `dateTimeDeleted` (when last deactivated), `dateTimeModified`                                                               | Strip set **E**. This schema has no `securityGroups`, `supervisorId` or `primaryDepartmentId`. |
| GET    | `/hr/v1.0/employees/{employeeId}`        | `employee:read`      | none                                                                                                          | `isDeactivated`, `deactivationDate`, plus the `/employees` core fields except `dateTimeDeleted`, which this schema lacks. `jobTitle` exists only here.                           | Strip sets **E** and **E+** (below)                                                            |
| GET    | `/hr/v1.0/departments/{id}/employees`    | `employee:read`      | `id`                                                                                                          | `data[].employeeId`                                                                                                                                                              | none (ids only)                                                                                |
| GET    | `/hr/v1.0/employeegroups/{id}/employees` | `employee:read`      | `id`                                                                                                          | `data[].employeeId`                                                                                                                                                              | none (ids only)                                                                                |

Strip sets for employee responses. The allow-list drops these; they are listed so reviewers know what is
being discarded ([hr-spec], [hr-guide]):

- **E** (fields of the `/employees` list schema): `userName` (login email); `cellPhone`,
  `cellPhoneWithoutCountryPrefix`, `cellPhoneCountryPrefix`, `cellPhoneCountryCode`; `phone`,
  `phoneWithoutCountryPrefix`, `phoneCountryPrefix`, `phoneCountryCode`; `street1`, `street2`, `zip`, `city`
  (home address); `hiredDate`; `salaryIdentifier` (salary code); `terminationTypeId`, `terminationTypeName`,
  `deactivationReason` (free-text HR reason); `ssn`, `bankAccount` (`registrationNumber`, `accountNumber`),
  `birthDate`. Also unused, so dropped: `employeeTypeId`, `isPublic`, `supervisorId`, `securityGroups`. Not
  every E field is on every endpoint: `/employees/deactivated` has no `supervisorId` or `securityGroups`, and
  the by-id schema has no `hiredDate` (it has `hiredFrom`), `cellPhoneWithoutCountryPrefix` or
  `phoneWithoutCountryPrefix`.
- **E+** (by-id only): `gender` (enum `Male` / `Female`, not gated by `special`); `countryId` (address
  country); `hiredFrom`; `contractRulesRuleId`; `workHours` (hours per month); `supervisorEmployeeId`;
  `skillIds`; every `custom_<n>` key. Custom fields arrive as `{name, type, value, url}` with type `Text`,
  `Numeric`, `Boolean`, `Date`, `Dropdown` or `Image`, and their content is defined per portal, so it could
  hold anything. `jobTitle` is not personal but is dropped unless the mapping needs it.

HR parameters and semantics:

- **Never send `special`.** It is an array query parameter with enum `BankAccount`, `BirthDate`, `Ssn` that
  opts those fields in on `/employees`, `/employees/{employeeId}` and `/employees/deactivated`. Its array
  serialisation (`style` / `explode`) is not specified ([hr-spec]). The HR guide wrongly calls these path
  parameters ([hr-guide]). It is the only documented field-selection control; nothing removes address, phone
  and the other personal fields ([hr-spec]).
- **Never send `searchQuery`.** It is free text matched against first and last name, email, phone, salary
  identifier and SSN ([hr-spec]).
- **Do not send `includeSecurityGroups`** (bool, `/employees` only) ([hr-spec]).
- `createdFrom`, `createdTo`, `modifiedFrom`, `modifiedTo`, `deactivatedFrom` and `deactivatedTo` are
  date-times in `yyyy-mm-ddThh:mm:ssZ`. On employees, the modified filters also match employees created or
  deleted in the window ([hr-spec]).
- `/employees` returns **active** employees only, with basic data. The by-id endpoint returns more detail,
  including custom fields ([hr-guide], [hr-spec]).
- Department membership is `departments` (int64[]) plus `primaryDepartmentId` (nullable int64).
  Employee-group membership is `employeeGroups` (int64[]) ([hr-spec]).
- `/employees` has no department or employee-group filter. The id-only endpoints
  `/departments/{id}/employees` and `/employeegroups/{id}/employees` were added on 17.02.2026
  ([release-notes]).
- `email` is described only as the employee's primary email address. `userName` must be an email. Neither is
  said to be a work address ([hr-spec]). `docs/INTEGRATIONS.md` matches employees by email, so expect some
  personal addresses.
- `phoneWithoutCountryPrefix` and `cellPhoneWithoutCountryPrefix` were added to the list endpoints on
  18.09.2026 ([release-notes]). On those endpoints `phone` and `cellPhone` embed the dialing prefix (for
  example `+451212121212`), unlike the by-id endpoint ([release-notes]).
- Deactivation can take effect immediately or on a future date (the write endpoint
  `PUT /hr/v1.0/employees/deactivate/{employeeId}` takes `date`, `reason`, `terminationTypeId`, `keepShifts`).
  Reactivation is immediate ([hr-spec]).
- On the active list, `terminationTypeId` is present even for employees with a future dismissal date. The
  list has no `isDeactivated`. The by-id endpoint does ([hr-spec]).
- Pay rates and salaries are not on HR employee responses; they live in the Pay API ([hr-guide]).
  `salaryIdentifier` (salary code) and, on by-id only, `workHours` (hours per month) and
  `contractRulesRuleId` are still returned and are stripped.
- Not used: `/employees/supervisors` (returns names), `/employees/{employeeId}/history` (needs
  `employee:history`; `value` holds raw changed values), `/employeetypes` (needs `employeetype:read`),
  `/terminationtypes`, `/employees/fielddefinitions` (JSON Schema of create/update input) ([hr-spec]).

**ClockOff rule:** do not call `GET /hr/v1.0/employees/{employeeId}` in routine syncs. It returns the most
personal data (gender, custom fields) and costs one request per employee. Use it only to confirm
`isDeactivated` for an employee who has dropped out of `/employees` but is not in `/employees/deactivated`.
`docs/INTEGRATIONS.md`'s mapping lists "phone" and "job title". Phone is in the strip list above, and job
title is only available from this endpoint; revisit that mapping.

### 9.3 Scheduling ([scheduling-spec])

| Method | Path                                      | Scope        | Params ClockOff sends                                                                                                                                       | Uses                                                                                                                                                                                                | Strip                                                                              |
| ------ | ----------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| GET    | `/scheduling/v1.0/shifts`                 | `shift:read` | `from`, `to` (date, inclusive); `limit` (1-5000), `offset`; optionally `departmentId[]`, `employeeId[]`; `modifiedFrom` / `modifiedTo` for incremental runs | `id`, `departmentId`, `employeeId` (null = open shift), `employeeGroupId`, `date`, `startDateTime`, `endDateTime`, `timeZone`, `status`, `punchClockShiftId`, `dateTimeCreated`, `dateTimeModified` | `comment` (free text). Unused: `positionId`, `shiftTypeId`, `skillIds`.            |
| GET    | `/scheduling/v1.0/shifts/{shiftId}`       | `shift:read` | `shiftId` (min 1)                                                                                                                                           | Same as the list. 404 `ProblemDetails` if not found.                                                                                                                                                | `comment`                                                                          |
| GET    | `/scheduling/v1.0/shifts/deleted`         | `shift:read` | `deletedFrom` / `deletedTo` (date-time, inclusive, `yyyy-mm-ddThh:mm:ssZ`); `limit` (1-1000), `offset`; the same filters as `/shifts`                       | `id`, `dateTimeDeleted` (other shift fields as above, except `punchClockShiftId` and `skillIds`, which this model lacks)                                                                            | `comment`, `deletedBy` (id of the user who deleted)                                |
| GET    | `/scheduling/v1.0/shifts/shiftstatus/all` | `shift:read` | none                                                                                                                                                        | `id` (int32), `name`: the statuses accepted by the `shiftStatus` filter                                                                                                                             | none                                                                               |
| GET    | `/scheduling/v1.0/scheduleDay`            | `shift:read` | `departmentId` (required), `from` (required), `to` (required); `limit` (1-50), `offset`                                                                     | `date`, `departmentId`, `isVisible`, `lockState`                                                                                                                                                    | `description` (manager-only notes, free text). Unused: `title`, `holiday[]`, `id`. |

Scheduling parameters and semantics:

- `/shifts` filters: `departmentId`, `employeeGroupId`, `shiftTypeId`, `positionId`, `employeeId` (each an
  int64 array); `shiftStatus` (**one** `ShiftStatus` value, not an array); `from` / `to` (dates, inclusive);
  `createdFrom`, `createdTo`, `modifiedFrom`, `modifiedTo` (date-time, `yyyy-mm-ddThh:mm:ssZ`). The modified
  filter is described as returning records modified "after" the given datetime ([scheduling-spec]).
- Full `GetShiftOutputModel`: `id` int64; `departmentId`, `employeeId`, `employeeGroupId`, `positionId`,
  `shiftTypeId` (nullable int64); `date` (date, nullable); `comment` (nullable); `timeZone` (string,
  required); `punchClockShiftId` (nullable int64); `startDateTime`, `endDateTime` (date-time, nullable);
  `status` (`ShiftStatusExtended`); `dateTimeCreated`, `dateTimeModified` (date-time, nullable); `skillIds`.
  It has no `isDraft` field and no break fields ([scheduling-spec]).
- `GetDeletedShiftOutputModel` adds `dateTimeDeleted` and `deletedBy` (int64, required) and has no
  `punchClockShiftId` or `skillIds` ([scheduling-spec]).
- Departments are optional per portal. When a portal uses them, every shift belongs to one. Every shift
  belongs to exactly one employee group ([structure]). That is consistent with `departmentId` being nullable;
  the spec gives no reason for it, and `employeeGroupId` is nullable too ([scheduling-spec]).
- The maximum `from`-`to` range is not documented; only the 5000-per-page cap is.
- Not used: `/shifts/{shiftId}/history` (`modifiedBy.name` is a person's name), `/positions` and `/sections`
  (`shiftposition:read`), `/shifttypes` and `/skills` (`shifttype:read`), `/timeandcost/{departmentId}`
  (`timeandcost:read`), and all writes ([scheduling-spec]).

### 9.4 Punch Clock ([punchclock-spec])

| Method | Path                                                           | Scope                  | Params ClockOff sends                                                                                                                | Uses                                                                                                                                                                                    | Strip                                               |
| ------ | -------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| GET    | `/punchclock/v1.0/punchclockshifts`                            | `punchclockshift:read` | `from`, `to` (**required**, date-time, example `2025-01-01T00:00`); `limit` (explicit), `offset`; optionally `employeeId`, `shiftId` | `id` (the punch clock shift id), `shiftId`, `departmentId`, `employeeId`, `startDateTime` (punch in), `endDateTime` (punch out), `shiftStartDateTime`, `shiftEndDateTime`, `isApproved` | `description` (free text)                           |
| GET    | `/punchclock/v1.0/punchclockshifts/byShift/{shiftId}`          | `punchclockshift:read` | `shiftId`                                                                                                                            | Same as the list. Returns the record for that shift with no date-range filtering; 404 if there is none.                                                                                 | `description`                                       |
| GET    | `/punchclock/v1.0/punchclockshifts/{punchClockShiftId}/breaks` | `punchclockshift:read` | `punchClockShiftId`                                                                                                                  | `id`, `punchClocksShiftId` (spec spelling), `startDateTime`, `endDateTime` (nullable), `duration` (date-span string, nullable)                                                          | none                                                |
| GET    | `/punchclock/v1.0/employeeshifts/today`                        | `shift:read`           | optionally `employeeId`. No paging parameters.                                                                                       | `id` (shift id), `departmentId`, `employeeId`, `employeeGroupId`, `date`, `startDateTime`, `endDateTime`                                                                                | `description`. Unused: `positionId`, `shiftTypeId`. |

Punch Clock semantics:

- `PunchClockShiftResponse`: `id` int64 (required), `shiftId` (nullable), `departmentId` (required),
  `employeeId` (nullable), `startDateTime` / `endDateTime` (punch in/out, date-time, nullable),
  `shiftStartDateTime` / `shiftEndDateTime` (date-time, nullable), `description` (nullable), `isApproved`
  (nullable bool) ([punchclock-spec]).
- The list has no `departmentId` filter ([punchclock-spec]).
- Approving a punch entry can apply rounding rules that change the shift's start and end time. Planday
  suggests checking `isApproved` ([timeclock-guide]).
- Since 10.07.2020 a punch-in can be created without a shift (with `employeeGroupId` and `departmentId`).
  Planday creates the shift when the entry is approved ([release-notes]), so `shiftId` can be null on
  unapproved records.
- The breaks endpoint returns Punch Clock breaks only. Manual and break-rule breaks need the Payroll API
  ([timeclock-guide]), which ClockOff does not use (section 5.3).
- `endDateTime` is nullable. The spec does not say that `null` means "still punched in"; verify on the demo
  portal.
- Not used: all writes (`POST`/`PUT /punchclockshifts`, `.../employee/{employeeId}/punchin`, `.../punchout`,
  `POST`/`PUT .../breaks`) and `GET .../{punchClockShiftId}/breakaccess`, which all need
  `punchclockshift:create`. The `deviceCode` (uuid) parameter on the writes is undocumented
  ([punchclock-spec]).

**ClockOff rule:**

- In `CLOCK_EVENT` mode, poll `/punchclockshifts` with a short overlapping `from`/`to` window, because which
  timestamp the window filters on is undocumented (section 12).
- `docs/INTEGRATIONS.md` stores breaks for reference only. Fetch `/breaks` once per record after it has an
  `endDateTime`, not on every poll: it costs one request per record.

## 10. Draft vs published, open shifts, time zones and breaks

### 10.1 Draft and published shifts

What the API says ([scheduling-spec]):

- `ShiftStatus` (the `shiftStatus` filter) has these values: `Open`, `Assigned`, `Approved`, `ForSale`,
  `Draft`, `OnDuty`, `PendingSwapAcceptance`, `PendingApproval`. None has a description.
- `ShiftStatusExtended` (the `status` field on GET) adds `PunchclockStarted`, `PunchclockFinished` and
  `PunchclockApproved`. The field's description only gives examples ("e.g. Open, Assigned, Approved, etc.").
- The GET model has **no** `isDraft` or published field. The only draft signal on a read is
  `status == "Draft"`. The spec implies this through the enum but never states it.
- On create, `isDraft` is optional and defaults to `false`. On update, leaving it unset keeps the current draft
  state. Create and update responses (not GET) include a required boolean `isDraft`.
- `POST /scheduling/v1.0/shifts/drafts/publish` (`shift:update`, returns 204) publishes draft shifts so
  employees can see them. The body requires `departmentId`; `shiftIds` is optional and nullable. What happens
  when `shiftIds` is omitted is not documented.
- `ShiftLockState` on schedule days is `Unlocked`, `ManagerLocked` or `SalaryLocked`. The values have no
  descriptions.

What the product docs say (Help Center, not API reference):

- Employees do not see draft shifts until they are published. Shifts already published stay visible. Only
  Admins and Schedule managers see drafts ([help-drafts]).
- Draft shifts can be read through the API, and employees cannot punch in or out on a draft until it is
  published ([help-drafts]).
- A second, separate mechanism exists: a **published** shift on a hidden day or period stays hidden from
  employees until the day is unhidden ([help-drafts], [help-hide-days]). In the API,
  `GET /scheduling/v1.0/scheduleDay` exposes `isVisible` per department and day, and its tag covers day
  visibility to employees ([scheduling-spec]). The API reference never ties `isVisible` to hidden days
  explicitly.

`Approved` is **not** "published". `POST /shifts/{shiftId}/approve` approves a shift for payroll, as the
admin's last step before running payroll, and it ignores punch clock data ([release-notes],
[scheduling-spec]).

**ClockOff rule (`SCHEDULED` mode):**

1. Import a shift only if `status != "Draft"` and `employeeId != null`. `shiftStatus` takes a single value,
   so "everything except Draft" cannot be filtered server-side; filter client-side. Whether `/shifts` returns
   drafts when `shiftStatus` is omitted is not documented, so filter regardless.
2. If a synced shift later reads back as `Draft`, cancel it in ClockOff. Whether a published shift can return
   to draft is undocumented, so this is the conservative choice.
3. Proposed, pending product sign-off: skip shifts on days where `scheduleDay.isVisible === false`, because
   employees cannot see them. It costs one paged `scheduleDay` call per department per sync window, and the
   link rests on the Help Center, not the API reference.
4. `docs/INTEGRATIONS.md` says "only shifts in a published/approved state are `SCHEDULED`". Replace that with
   rule 1: `Approved` is a payroll state, so a published shift need not be `Approved`. Which status a published
   shift carries (for example `Assigned`) is not documented (section 12).

### 10.2 Open shifts

- An open shift has no employee. Assigning a shift with `employeeId: null` sets it to `Open`. On GET,
  `employeeId` is required but nullable ([scheduling-spec]).
- `Open` is also a status value ([scheduling-spec]).
- The Time and Cost endpoint leaves out open shifts ([timeandcost-guide]).
- The meanings of `ForSale` and `PendingSwapAcceptance`, including whether the assigned employee is still
  expected to work, are not documented.

**ClockOff rule:** skip any shift with `employeeId == null`, whatever its status, as `docs/INTEGRATIONS.md`
already does. If a shift ClockOff synced for an employee becomes open or moves to another employee, cancel or
re-assign the ClockOff shift in the same run.

### 10.3 Time zones, formats and DST

What is documented:

- GET shift `startDateTime` / `endDateTime` are nullable strings with `format: date-time`. The shift also has a
  required `timeZone` string. The spec gives no example values and does not say whether the times are local
  wall-clock, UTC or offset-bearing ([scheduling-spec]).
- The rendered reference shows `"startDateTime": "2019-08-24T14:15:22Z"`. That is Redoc's generated
  placeholder for any date-time field, because the spec has no `example` on these fields. It is **not**
  evidence that Planday returns UTC ([schedule-page], [scheduling-spec]).
- On create and update, times are sent as `date` plus `startTime` / `endTime` (`format: time`), with an
  optional `timeZone` that falls back to the department's time zone when null ([scheduling-spec]). That
  points to wall-clock input in a named zone.
- **A department's time zone is not exposed.** `DepartmentOutput` has only `id`, `name` and `number`
  ([hr-spec]). Only the per-shift `timeZone` and the portal `timeZone` (`GET /portal/v1.0/info`)
  are readable ([portal-spec]).
- The format of `timeZone` (IANA such as `Europe/Copenhagen`, or a Windows zone id) is not documented, for
  shifts or for the portal.
- Overnight shifts: a shift can cross midnight, and `date` always refers to the start. `endTime` can be at most
  24 hours after `startTime` ([scheduling-spec]).
- **DST is not mentioned anywhere** in the docs or specs.
- Filters: shift `from` / `to` are `format: date` and inclusive. `createdFrom`, `createdTo`, `modifiedFrom`
  and `modifiedTo` are `yyyy-mm-ddThh:mm:ssZ` ([scheduling-spec]). Whether `from` / `to` filter on `date` or
  on the start and end times, and how overnight shifts crossing `to` are handled, is not documented.
- The time zone of the `dateTimeCreated` / `dateTimeModified` output values is not documented.
- Punch Clock `from` / `to` (required) and the record date-times use the example `2025-01-01T00:00`, with no
  offset and no `Z`. Their zone is not stated ([punchclock-spec]). Which zone defines "today" for
  `/employeeshifts/today` is not documented.
- HR examples show UTC timestamps such as `2016-07-11T13:22:00Z` ([hr-spec]).

**ClockOff rule (provisional until verified on a demo portal):**

1. If a returned date-time string carries `Z` or an offset, parse it as an instant.
2. If it has no offset, treat it as wall-clock time in the shift's `timeZone` and convert it with the shared
   helpers in `packages/shared/src/time`. For Punch Clock records, which have no `timeZone`, use the zone of
   the matched shift, falling back to the portal `timeZone`.
3. If `timeZone` is not a valid IANA id, report `INVALID_TIME` for that record and skip it. Do not guess a
   Windows-to-IANA mapping until real values have been seen.
4. Check the result: the end must be after the start and at most 24 hours later ([scheduling-spec]).
5. Query `/shifts` one day wider than the sync window on each side and filter client-side on the computed UTC
   instants.
6. For incremental runs, start `modifiedFrom` a few minutes before the last high-water mark. The output time
   zone is undocumented and the filter says "after", so overlap the windows and rely on idempotent upserts.
7. Before shipping, record fixtures that include a shift across a DST change in a portal whose zone observes
   DST, and check what `startDateTime`, `endDateTime` and `timeZone` actually contain.

`docs/INTEGRATIONS.md` plans to convert shift times "with the department's zone" and to set
`Location.timezone` from "the portal or department zone". The department zone is not readable, so use the
shift's `timeZone` for shifts. For locations, use the portal `timeZone`, or the `timeZone` seen on that
department's shifts.

### 10.4 Breaks

- GET shift output has **no break fields**. Create and update accept only `useBreaks` (bool), which applies
  the default breaks from break settings. Shift types expose `allowsBreaks` ([scheduling-spec]).
- Punch Clock breaks come from `GET /punchclock/v1.0/punchclockshifts/{punchClockShiftId}/breaks`. That covers
  Punch Clock breaks only. Manual breaks and breaks from break rules come from the Payroll API
  ([timeclock-guide]).
- Payroll: `GET /payroll/v1.0/payroll` returns `shiftsPayroll[].breaks[]` with `id`, `start`, `end`,
  `duration` (hours), `title` and `isPaid`, alongside salary and wage data. The spec states no scope
  ([payroll-spec]); discovery has `payroll:read` ([oidc-discovery]).
- Reports: `POST /reports/v1.0/schedulingHistory` returns per-shift snapshots with `breaks[]`
  (`start`, `end`, `isPaid`) under the policy "shift update" ([reports-spec]).
- Time and Cost durations exclude break time, even paid breaks ([scheduling-spec]).

**Consequence for ClockOff:** with the scopes in section 5.2, ClockOff cannot import scheduled breaks from
Planday. Breaks keep following ClockOff's own Break Rules, which matches `docs/INTEGRATIONS.md`. In
`CLOCK_EVENT` mode, Punch Clock breaks can become `BREAK_START` / `BREAK_END` reference events.

## 11. Webhooks

**None are documented.**

- The docs' API menu lists only Absence, Contract rules, Data Center, HR, Pay, Payroll, Portal, Punchclock,
  Reports, Revenue, Schedule and Security group membership. There is no Webhooks page ([docs-nav]).
- None of the 12 specs mentions webhooks, subscriptions or callbacks ([scheduling-spec], [hr-spec],
  [punchclock-spec], [portal-spec]). Webhook spec URLs probed during research returned 404.
- The only Planday webhooks are on the status page. They report incidents and component status (components
  include "Punch Clock" and "Open API"), not data changes ([status]).
- Nothing documents a notification to the integrator when an administrator clicks **Revoke**
  ([authorization] describes the button only).

Change detection is polling only:

| Change                   | How to detect it                                                                                                 | Source            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------- |
| Employee created/changed | `GET /hr/v1.0/employees?modifiedFrom=...` (also matches created and deleted)                                     | [hr-spec]         |
| Employee deactivated     | `GET /hr/v1.0/employees/deactivated?deactivatedFrom=...`                                                         | [hr-spec]         |
| Shift created/changed    | `GET /scheduling/v1.0/shifts?modifiedFrom=...` (or a full window re-read)                                        | [scheduling-spec] |
| Shift deleted            | `GET /scheduling/v1.0/shifts/deleted?deletedFrom=...`                                                            | [scheduling-spec] |
| Punch in/out             | `GET /punchclock/v1.0/punchclockshifts?from=...&to=...`                                                          | [punchclock-spec] |
| Departments, groups      | Full re-read: there are no modified filters, and `includeDeleted` exists only on `GET /hr/v1.0/departments/{id}` | [hr-spec]         |

Employee groups have no deleted flag ([hr-spec]). **ClockOff rule:** a department or group missing from a
full re-read is reported, not deleted, in line with `docs/INTEGRATIONS.md`'s never-hard-delete rule.

## 12. Open questions and gaps

None of these is documented. Each needs a test on the demo portal or an answer from `apisupport@planday.com`
([api-support]) before the code depends on it.

**Auth and tokens**

1. Whether API apps have, or need, a client secret. No documented flow uses one. Discovery lists
   `client_secret_basic` and `client_secret_post` server-wide.
2. Whether PKCE is accepted or required. Discovery advertises `plain` and `S256`; the docs say nothing.
3. Whether refresh tokens rotate, and whether the refresh grant returns `refresh_token`, `expires_in` or
   `scope`. Only `access_token` is promised.
4. Error bodies from the token endpoint (for example a revoked refresh token, possibly `invalid_grant`), and
   the revocation endpoint's response.
5. Whether revoking the refresh token also invalidates live access tokens. Revoking access tokens directly is
   not documented.
6. How a manually connected portal (methods B and C) gets a new token after revocation or loss.
7. Redirect URI matching (exact or prefix), whether custom schemes or mobile deep links are allowed, and where
   the Create App UI takes the Redirection URL.
8. Access-token and `id_token` claims, including whether `PortalId` is present.
9. Whether a token for a parent portal can read the child portals listed in `portals[]`.
10. Any approval gate for customers connecting an uncertified app. Certification covers only listing
    (general availability). Also whether a customer may use Connect App with a partner's App ID (method B):
    the docs describe Connect App only for portals the app owner administers.

**Scopes**

11. Which scope, if any, `GET /portal/v1.0/info` needs. The spec states none, and there is no `portal:read`.
12. Readable descriptions of each scope beyond the per-API "Scopes used" tables and the consent screen.
13. Which scopes the HR special fields need (the guide says only "dedicated scopes"). Whether requesting
    `special` without them gives a 403 or silently drops the field. Whether `ssn`, `bankAccount` and
    `birthDate` are omitted or null when `special` is not sent (the by-id example shows `"ssn": ""` without
    saying which query produced it).

**Rate limits and paging**

14. The per-portal per-second limit: the table says 20, the worked example 10.
15. `Retry-After` on 429. Only `x-ratelimit-*` is documented.
16. Per-endpoint limits, and limits on `id.planday.com`.
17. Punch Clock's maximum `limit` and what the default `0` means.
18. Sort order of every list endpoint.
19. Size limits on `/departments/{id}/employees` and `/employeegroups/{id}/employees`, which have no paging.

**HR**

20. Any way to exclude address, phone, `userName`, hire date, `salaryIdentifier` and the termination reason
    from list and detail responses, or gender, `workHours` and custom fields from by-id responses.
21. Whether `email` is a work or a personal address.
22. Whether `/departments/{id}/employees` and `/employeegroups/{id}/employees` include deactivated employees.
23. Whether `/employees` still includes an employee with a future deactivation date. The only hint is that
    `terminationTypeId` is present for future dismissals.
24. Whether `GET /hr/v1.0/employees/{employeeId}` returns deactivated employees, or a 400 as the Errors
    guide suggests for inactive users.
25. An `includeDeleted` option on the departments list (it exists only on by-id). Employee groups have no
    deleted flag at all.
26. How the `special` array is serialised in the query string.

**Scheduling**

27. Whether shift `startDateTime` / `endDateTime` are local wall-clock, UTC or offset-bearing.
28. The `timeZone` format (IANA or Windows) on shifts and the portal, and the `country` format.
29. DST handling for shifts that span a transition.
30. The time zone of `dateTimeCreated` / `dateTimeModified`.
31. Whether `/shifts` returns drafts when `shiftStatus` is omitted, and whether several statuses can be
    combined.
32. An explicit statement that drafts read back as `status == "Draft"`.
33. Which status a draft takes when published (`Open` or `Assigned`), and whether a published shift can
    return to draft.
34. What `POST /shifts/drafts/publish` does when `shiftIds` is null or omitted.
35. Whether shifts on hidden days (`scheduleDay.isVisible == false`) are filtered out of, or flagged in,
    `/shifts`. The meanings of `isVisible` and `lockState`.
36. The meaning of each `ShiftStatus` value, especially `ForSale`, `OnDuty`, `PendingSwapAcceptance`,
    `PendingApproval` and the `Punchclock*` values.
37. The maximum date range per `/shifts` request.
38. Whether `/shifts` `from` / `to` filter on `date` or on start and end times, and how overnight shifts that
    cross `to` are treated.
39. How to read a department's time zone.
40. The scope for `GET /payroll/v1.0/payroll`. This does not affect ClockOff, which does not use it.
41. A Scheduling version list: `scheduling/swagger/version` returned 404.
42. When the draft and publish endpoints and the `isDraft` fields were added. The release notes do not say.

**Punch Clock**

43. The time zone of Punch Clock date-times and filters, and which zone defines "today".
44. Which timestamp `from` / `to` filter on (punch start, shift start or overlap), and whether the bounds are
    inclusive.
45. Whether `endDateTime == null` means the employee is still punched in.
46. Data latency and freshness of punch records, and any SLA.
47. The meaning of `deviceCode` on write endpoints. ClockOff does not use them.

**Platform**

48. Webhooks or push notifications of any kind for data changes.
49. A formal versioning or deprecation policy. Only v1.0 exists.
50. A `servers` entry or base URL in any spec. The base URL comes from the guides.
51. A sandbox or staging environment for integrators. Only demo portals are documented. The docs site's code
    references `openapi.stag.planday.cloud` for its own non-planday.com origins, which is not offered to
    integrators.
52. Data retention and GDPR handling of employee data returned by the API.

## Appendix: corrections to the `docs/INTEGRATIONS.md` Planday outline

The outline in `docs/INTEGRATIONS.md` ("Adding Planday") predates this research. Where they disagree, this
file is based on Planday's documentation:

| Outline says                                                | Planday docs say                                                                                                                                                                               | Section  |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Add `PLANDAY_CLIENT_ID` and `PLANDAY_CLIENT_SECRET`         | No documented flow uses a secret. Only the App ID (`client_id`) is defined.                                                                                                                    | 3.4      |
| "Client-credentials style (portal-issued token)"            | The portal issues a **refresh token** (Token column), used with `grant_type=refresh_token`. Client credentials are not documented for API apps.                                                | 3.2, 3.3 |
| Convert shift times "with the department's zone"            | The department zone is not readable. Each shift carries `timeZone`, and whether its times are local or UTC is undocumented.                                                                    | 10.3     |
| "Only shifts in a published/approved state are `SCHEDULED`" | `Approved` means approved for payroll. GET has no draft flag; `status == "Draft"` is the only draft signal, implied by the enum but never stated. Hidden days can still hide published shifts. | 10.1     |
| Employee mapping includes phone and job title               | Phone is personal contact data (stripped here). `jobTitle` exists only on the by-id endpoint.                                                                                                  | 9.2      |
| `externalEmployeeId = PLANDAY:<id>`                         | Ids are unique only within a portal. Bind each ClockOff organisation to one portal id and check it.                                                                                            | 2        |
| Rate-limit handling: back off on 429                        | Use `x-ratelimit-reset` (`Retry-After` is not documented). Budget per client id, which methods A and B share across every customer.                                                            | 6        |
| A webhook may later replace polling                         | No data webhooks are documented.                                                                                                                                                               | 11       |

[overview]: https://openapi.planday.com/gettingstarted/overview
[authorization]: https://openapi.planday.com/gettingstarted/authorization
[auth-flow]: https://openapi.planday.com/gettingstarted/authorization-flow
[rate-limiting]: https://openapi.planday.com/gettingstarted/rate-limiting
[release-notes]: https://openapi.planday.com/gettingstarted/release_notes
[api-support]: https://openapi.planday.com/gettingstarted/api-support
[partner]: https://openapi.planday.com/gettingstarted/become-an-integration-partner
[errors]: https://openapi.planday.com/guides/errors
[structure]: https://openapi.planday.com/guides/planday-structure
[hr-guide]: https://openapi.planday.com/guides/hr-guide
[timeclock-guide]: https://openapi.planday.com/guides/timeclock-guide
[timeandcost-guide]: https://openapi.planday.com/guides/timeandcost-guide
[portal-spec]: https://openapi.planday.com/portal/swagger/v1.0/swagger.json
[hr-spec]: https://openapi.planday.com/hr/swagger/v1.0/swagger.json
[scheduling-spec]: https://openapi.planday.com/scheduling/swagger/v1.0/swagger.json
[punchclock-spec]: https://openapi.planday.com/punchclock/swagger/v1.0/swagger.json
[payroll-spec]: https://openapi.planday.com/payroll/swagger/v1.0/swagger.json
[reports-spec]: https://openapi.planday.com/reports/swagger/v1.0/swagger.json
[pay-spec]: https://openapi.planday.com/pay/swagger/v1.0/swagger.json
[absence-spec]: https://openapi.planday.com/absence/swagger/v1.0/swagger.json
[contractrules-spec]: https://openapi.planday.com/contractrules/swagger/v1.0/swagger.json
[revenue-spec]: https://openapi.planday.com/revenue/swagger/v1.0/swagger.json
[datacenter-spec]: https://openapi.planday.com/datacenter/swagger/v1.0/swagger.json
[securitygroups-spec]: https://openapi.planday.com/securityGroupMembership/swagger/v1.0/swagger.json
[hr-versions]: https://openapi.planday.com/hr/swagger/version
[scheduling-versions]: https://openapi.planday.com/scheduling/swagger/version
[oidc-discovery]: https://id.planday.com/.well-known/openid-configuration
[docs-nav]: https://openapi.planday.com/page-data/sq/d/1635659820.json
[docs-loader]: https://openapi.planday.com/2e63f7a790fcdc92df61af13efc7c62164438e9b-fa3a50face8c13be31c3.js
[docs-app]: https://openapi.planday.com/app-abca979233297787b2fa.js
[schedule-page]: https://openapi.planday.com/api/schedule?version=v1.0
[help-drafts]: https://help.planday.com/en/articles/30569-how-to-use-draft-shifts-in-planday
[help-hide-days]: https://help.planday.com/en/articles/30436-hide-days-or-periods-on-the-schedule
[status]: https://status.planday.com/
