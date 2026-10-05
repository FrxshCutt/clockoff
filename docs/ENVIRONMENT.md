# Environment Variables

All configuration comes from environment variables. Locally they live in a single root `.env`
(`pnpm setup:env` creates it from `.env.example` with generated secrets). Package scripts load it with
`dotenv -e ../../.env`. In production set them in the platform's secret store — never commit a real `.env`.

`apps/web/src/lib/env.ts` validates everything at first use with Zod and fails fast with a clear message.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | — | Postgres connection for Prisma (web, jobs, seed). |
| `TEST_DATABASE_URL` | tests | — | Separate database for integration tests; must contain `_test`. Reset on every run. |
| `APP_URL` | yes | `http://localhost:3000` | Public origin. Used for links in emails/invites and the CSRF origin check. |
| `NEXT_PUBLIC_APP_URL` | yes | same | Same value, exposed to the browser. |
| `NEXT_PUBLIC_APP_STORE_URL` | no | placeholder | App Store link shown in employee invite instructions. |
| `SESSION_SECRET` | yes | — | ≥32 random bytes (hex). HMAC key for CSRF tokens and cookie integrity. |
| `SESSION_TTL_DAYS` | no | `14` | Manager session lifetime (sliding). |
| `REQUIRE_EMAIL_VERIFICATION` | no | `false` | When `true`, org-scoped manager routes return `EMAIL_NOT_VERIFIED` until the address is verified. Recommended `true` in production. |
| `MOBILE_JWT_SECRET` | yes | — | HS256 secret for device access tokens. |
| `MOBILE_JWT_KEY_ID` | no | `v1` | `kid` header; bump when rotating `MOBILE_JWT_SECRET` (old tokens expire within 15 min). |
| `MOBILE_ACCESS_TOKEN_TTL_SECONDS` | no | `900` | Access token lifetime. |
| `MOBILE_REFRESH_TOKEN_TTL_DAYS` | no | `60` | Refresh token lifetime (rotated on every use). |
| `INTEGRATION_ENCRYPTION_KEY` | yes | — | 32 bytes base64. AES-256-GCM key for integration credentials and push tokens at rest. |
| `EMAIL_PROVIDER` | no | `console` | `console` logs emails (with links) to stdout; `smtp` uses `SMTP_*`. |
| `EMAIL_FROM` | no | `Work Mode <no-reply@…>` | From header. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` | if smtp | — | SMTP transport settings. |
| `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_P8_BASE64`, `APNS_BUNDLE_ID`, `APNS_ENVIRONMENT` | no | — | When all set, `ApnsPushProvider` sends silent pushes (token-based auth, `.p8` key base64-encoded). Otherwise `NoopPushProvider` logs and devices rely on background refresh. `APNS_ENVIRONMENT` is `sandbox` or `production`. |
| `RATE_LIMIT_BACKEND` | no | `memory` | `memory` (single process) or `redis`. |
| `REDIS_URL` | if redis | — | Redis for rate limiting / event bus adapter (future). |
| `JOBS_ENABLED` | no | `true` | Set `false` to run the web app without the in-process scheduler (use `/api/jobs/tick`). |
| `CRON_SECRET` | yes | — | Bearer secret for `POST /api/jobs/tick` (external cron). |
| `LOG_LEVEL` | no | `info` | pino level. |
| `DEV_TOOLS_ENABLED` | no | `true` locally | Enables `/api/dev/*` helpers (e.g. reading the last console email in Playwright). Must be unset/`false` in production. |
| `NODE_ENV` | set by tooling | — | `production` enables `Secure` cookies and HSTS. |
| `PRISMA_LOG` | no | — | `query` to log SQL in development. |

## Generating secrets

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"     # SESSION_SECRET / MOBILE_JWT_SECRET / CRON_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # INTEGRATION_ENCRYPTION_KEY
```
