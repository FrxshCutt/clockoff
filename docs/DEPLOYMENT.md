# Deployment

> **Status (2026-10-08): LIVE on Railway.** `https://clockoff.online` (marketing site), `https://www.clockoff.online`
> (308 → apex) and `https://app.clockoff.online` (dashboard and every API) are served by the Railway project
> `clockoff`, which deploys from GitHub `FrxshCutt/clockoff` `main`. The database is **Neon** Postgres in London and
> email goes through **Resend**. DNS for `clockoff.online` is a **Cloudflare** zone managed through the Cloudflare
> API; every record is **DNS only** (not proxied). The domain and the mailbox are still at IONOS.
>
> Production moved from Netlify on 2026-10-08 after Netlify's free plan ran out of credits and paused the site
> ([Netlify wind-down](#netlify-wind-down-history), `docs/DECISIONS.md` D-023). Current state, open risks and owner
> to-dos: `docs/STATUS.md`.

## Architecture

```text
 Browsers · iOS app (Release builds: https://app.clockoff.online/api/mobile/v1)
        │
        ▼
 Cloudflare DNS, zone clockoff.online (every record DNS only)
   clockoff.online (CNAME, flattened)   app.clockoff.online (CNAME)   www.clockoff.online (CNAME)
                  │                               │                             │
                  ▼                               ▼                             ▼
 Railway project "clockoff" · environment production · EU West (Amsterdam)
 ┌────────────────────────────────────────────────────────────┐  ┌──────────────────────────────┐
 │ web     Next.js standalone server, PORT 8080               │  │ www   308 → clockoff.online  │
 │         marketing site · dashboard · /api/** · SSE         │  │       GET /healthz           │
 │         pre-deploy: /app/migrate.sh                        │  └──────────────────────────────┘
 ├──────── Postgres LISTEN/NOTIFY (channel clockoff_events) ──┤
 │ worker  node main.mjs serve (no public domain)             │
 │         minute jobs · 15-minute integrations slot          │
 │         heartbeat · push bridge (elected leader only)      │
 └──────────────┬────────────────────────────┬────────────────┘
                │ DATABASE_URL (pooled)      │ HTTPS API
                │ DIRECT_URL (direct)        ▼
                ▼                            Resend (eu-west-1) → noreply@clockoff.online
 Neon Postgres 17 · London (aws-eu-west-2) · project quiet-flower-84715995
```

- **web** serves everything that answers HTTP: the marketing pages, the manager dashboard, every manager and mobile
  API route and the realtime SSE stream. It runs **no** background jobs and never sends pushes
  (`apps/web/src/deploy/processBoundaries.test.ts` guards this). With `HOST_ROUTING=on`, `src/middleware.ts` routes
  by hostname (`src/server/http/hostRouting.ts`):
  - `clockoff.online` serves the marketing pages, `/api/request-demo` and `/api/health`; dashboard and auth pages
    308 to `app.clockoff.online`; any other `/api/*` answers 404, so session cookies only ever live on
    `app.clockoff.online`.
  - `app.clockoff.online` serves the dashboard, auth pages and every API; `/` redirects to `/overview`.
  - Any other host (the Railway domain `web-production-4ccf9.up.railway.app`, the health-check probe, localhost) is
    served unchanged.
- **worker** runs the background jobs, writes the heartbeat and, when it holds the leadership lease, turns
  realtime events into silent pushes. It has no public domain and no HTTP server.
- **www** is a dependency-free Node server (`docker/www-redirect/server.mjs`) that answers `www.clockoff.online`
  with a 308 to `https://clockoff.online` (same path and query; the `Host` header never chooses the destination).
  It exists only because Railway's Hobby plan allows **two custom domains per service**: web carries the apex and
  `app`, so `www` needs its own service (D-027).
- **Realtime across processes:** each process delivers its own events locally and NOTIFYs the others through
  Postgres (`PostgresEventBus`); one LISTEN session per process on `DIRECT_URL`. Events the worker raises (override
  expiry, work-state changes) reach the dashboards' SSE streams on web, and manager edits on web reach the worker's
  push bridge (D-025).
- **TLS:** Railway issues and renews one Let's Encrypt certificate per custom domain (all three valid until
  2027-01-06 when checked on 2026-10-08). `http://` answers 301 → `https://` at Railway's edge.

## What runs where

| Service  | Built from                                                                       | Command                                   | Public                                                                                     | Health check              |
| -------- | -------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------- |
| `web`    | `docker/web/Dockerfile` (Next.js `output: "standalone"`, Prisma CLI for migrate) | `node apps/web/server.js`                 | `clockoff.online`, `app.clockoff.online`, `web-production-4ccf9.up.railway.app`; port 8080 | `GET /api/health`, 120 s  |
| `worker` | `docker/worker/Dockerfile` (esbuild bundle of `apps/web/src/worker/main.ts`)     | `node main.mjs` (= `serve`)               | none                                                                                       | none (restart on failure) |
| `www`    | `docker/www-redirect/Dockerfile` + `server.mjs`                                  | `node server.mjs` (`REDIRECT_TO`, `PORT`) | `www.clockoff.online`                                                                      | `GET /healthz`, 30 s      |

| Setting             | `web`                                                                                                                           | `worker`                                                                     | `www`                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Pre-deploy          | `/app/migrate.sh` (300 s timeout)                                                                                               | —                                                                            | —                                                           |
| Restart policy      | `ON_FAILURE`, up to 10 retries                                                                                                  | `ON_FAILURE`, up to 10 retries                                               | `ON_FAILURE`, up to 10 retries                              |
| Replicas · sleep    | 1 · never sleeps                                                                                                                | 1 · never sleeps                                                             | 1 · never                                                   |
| Overlap · draining  | 15 s · 30 s                                                                                                                     | 0 s · 60 s                                                                   | 5 s · 5 s                                                   |
| Memory · heap cap   | 512 MiB · 320 MB                                                                                                                | 256 MiB · 160 MB                                                             | 128 MiB · 48 MB                                             |
| CPU cap             | 2 vCPU                                                                                                                          | 1 vCPU                                                                       | 0.5 vCPU                                                    |
| Rebuilds on changes | `apps/web/**`, `packages/**`, the root manifests, lockfile and build config, `docker/web/**`, `railway/web.json`, `.railway/**` | the same app paths, `docker/worker/**`, `railway/worker.json`, `.railway/**` | `docker/www-redirect/**`, `railway/www.json`, `.railway/**` |

- **Restarts:** after the tenth failed restart Railway stops restarting and the deployment stays crashed until it
  is fixed and restarted ([Troubleshooting](#troubleshooting)).
- **Railway:** workspace "frxshcutt's Projects" (Hobby plan), project `clockoff`
  (`400fc7b9-d0b5-4769-aaa8-b693da1c7f8a`), environment `production` (`0755ab7d-ee21-4454-8b61-523b0cdd2df1`),
  region EU West (`europe-west4-drams3a`, Amsterdam). Neon is in London.
- Both app images pin Node 22 by version and digest, pnpm 11.10.0 and the lockfile (`--frozen-lockfile`). The
  builds need no application environment and no secrets: every value is read at runtime. Each image generates
  its own Prisma engine (`binaryTargets = ["native"]`), so there is no platform-specific build step.
- The worker's jobs (D-024; details in `docs/WORK_MODE_SERVER_JOB.md`):

  | Job                 | Every  | Does                                                                                                     |
  | ------------------- | ------ | -------------------------------------------------------------------------------------------------------- |
  | `work-mode-tick`    | 1 min  | break expiry, scheduled breaks, Work Mode evaluation and the hourly manager digest                       |
  | `override-expiry`   | 1 min  | `OVERRIDE_EXPIRED` exactly once per expired override                                                     |
  | `schedule-upkeep`   | 1 min  | recurring-shift materialisation and completing ended shifts (after that minute's tick)                   |
  | `integrations-sync` | 15 min | scheduled workforce-provider syncs: a documented no-op (`NO_AVAILABLE_PROVIDER`) until Planday registers |

  Each run holds a Postgres session advisory lock on `DIRECT_URL` and claims its minute slot in `worker_job_runs`,
  so a slot runs at most once even with two workers. The worker writes a `worker_heartbeats` row every minute.

## Configuration as code

Railway refuses per-service config-as-code files (`railway.json` / `railway.toml`) for new services ("Config as
Code is deprecated. Use Infrastructure as Code"), and stops reading existing ones on 2026-12-01. So the project is
described by **`.railway/railway.ts`**, a TypeScript file built on `railway/iac` from the `railway` npm package
(pinned to 3.13.0 as a root dev dependency; `.railway/package.json` makes the folder an ES module). It:

- defines the three services from `FrxshCutt/clockoff` `main`, region EU West, one replica each;
- reads each service's build and deploy settings from **`railway/web.json`**, **`railway/worker.json`** and
  **`railway/www.json`** (the per-service source of truth, pinned by `apps/web/src/deploy/railwayConfig.test.ts`);
- lists every variable each service reads **by name** with `preserve()`, so values live only in Railway;
- sets the www service's two non-secret values (`REDIRECT_TO=https://clockoff.online`, `PORT=8080`).

Custom domains are managed outside the file (Railway dashboard or API), and an apply leaves them alone.

```bash
railway config plan     # read-only preview of what would change; run it first, every time
railway config apply    # applies after a confirmation prompt (--yes in scripts)
```

**The `preserve()` rule:** a variable that is set in Railway but **missing from the lists in `.railway/railway.ts`
is deleted by the next `railway config apply`**. When code starts reading a new variable, add its name to
`SHARED_VARIABLES` (web and worker), `WEB_VARIABLES` or `WORKER_VARIABLES` in the same change. Never add the
retired `JOBS_ENABLED` or `CRON_SECRET` (the config test refuses them). The `WEB_VARIABLES` and `WORKER_VARIABLES`
lines are pinned verbatim by `apps/web/src/deploy/railwayConfig.test.ts`: when you add a name to either, update the
test's expected line in the same change, or `pnpm --filter @clockoff/web test` fails. (`SHARED_VARIABLES` is only
checked for required names, so adding one there needs no test change.)

To change a setting (memory, draining, health check, watch patterns), edit `railway/<service>.json`, run the
tests (`pnpm --filter @clockoff/web test`, which includes `railwayConfig.test.ts`), then `railway config plan` and
`railway config apply`. A push that touches `railway/<service>.json` or `.railway/**` also rebuilds the services
that watch it.

## First-time setup (operator machine)

1. Install the Railway CLI (5.63 was used; `brew install railway`) and authenticate: `railway login`, or export an
   account token as `RAILWAY_API_TOKEN` in your shell. Never commit the token or write it into a repo file.
2. Link the checkout once (stored outside the repo):

   ```bash
   railway link --project 400fc7b9-d0b5-4769-aaa8-b693da1c7f8a --environment production
   ```

3. `pnpm install` (installs the pinned `railway` package that `.railway/railway.ts` imports).
4. `railway config plan` should report no pending changes other than one known, harmless line per service:
   `deploy.restartPolicyMaxRetries (null → 10)`, `deploy.restartPolicyType (null → "ON_FAILURE")` and
   `deploy.sleepApplication (null → false)`. Railway stores its own defaults as null, so these reappear after every
   apply and applying them changes nothing. Anything else in the plan is real drift: find out why before applying.
5. `railway status` and `curl -s https://app.clockoff.online/api/health` confirm you are looking at production.

Recreating the project from nothing has not been rehearsed. The outline: apply `.railway/railway.ts` to a new
project, set every variable listed there ([Environment variables](#environment-variables)), add the custom domains
in Railway (two per service at most), create the CNAME and `_railway-verify` TXT records Railway asks for through
the Cloudflare API (DNS only; back up the zone first, `docs/DNS_RECORDS.md`), and wait for the certificates.

## Deploy

- **Normal path: push to `main`.** Railway builds every service whose watch patterns match the changed paths (see
  [What runs where](#what-runs-where)): most code changes rebuild web and worker, a docs-only change rebuilds
  nothing, and www only rebuilds for its own files. A push to `main` is a production deploy, so run the gates
  first (`docs/TESTING.md`). CI (`.github/workflows/ci.yml`) also builds both app images and smoke-tests them
  (`images` job).
- **web:** build → pre-deploy `/app/migrate.sh` → the new deployment starts → Railway waits up to 120 s for
  `/api/health` to answer 200 → traffic switches; the old deployment keeps running for 15 s (overlap) and then
  gets SIGTERM with 30 s to drain. A failed migration or health check fails the deploy and the old deployment
  keeps serving.
- **worker:** build → the new worker starts → the old one gets SIGTERM straight away (overlap 0) and drains for up
  to 60 s. While both run, the advisory locks and slot claims keep every job slot to one run. Web and worker
  deploy independently: a new worker that starts before web's pre-deploy migration has run waits (health
  `worker.jobs: "waiting_for_migrations"`, re-checked every 15 s) instead of running jobs against an old schema.
- **Without a commit:**

  ```bash
  railway redeploy --service web                # redeploy the latest deployment (same image)
  railway redeploy --service web --from-source  # rebuild from the latest commit of main
  railway restart --service worker              # restart the running deployment, no rebuild
  railway deployment list --service web         # deployment ids, statuses, times
  ```

- **After any deploy:** `curl -s https://app.clockoff.online/api/health` must show `"status":"ok"`,
  `"migrations":"up_to_date"`, `"worker":{"status":"fresh",…,"jobs":"ok",…}` and
  `"realtime":{"mode":"postgres","listening":true}`. A fresh heartbeat alone is not enough: `jobs` must be `ok`.
- **Schema changes:** keep migrations additive (new tables and nullable columns first, code that uses them next,
  removals in a later release) so the previous web and worker images keep working while a deploy is in flight
  and after a rollback.

## Roll back

Railway keeps every deployment. Dashboard → project `clockoff` → the service → **Deployments** → pick the previous
successful deployment → **Rollback** (the GraphQL `deploymentRollback` mutation does the same). Roll back web and
worker separately; each only needs its own previous image. `git revert` + push is the alternative when the fix
should also land in `main` (the next push would otherwise redeploy the bad commit).

**Migrations are forward-only:** a rollback never undoes one. Because migrations are additive, the previous image
keeps working against the newer schema (the migration status reads `up_to_date` when the database is ahead of the
code). Never roll back across a destructive migration (a dropped or renamed column or table); fix forward with a
new migration instead, or restore the database ([Backups and restore](#backups-and-restore)).

## Logs

Every process logs structured JSON (pino) with `service` set to `clockoff-web` or `clockoff-worker`: ids and counts
only, never names, emails or tokens.

```bash
railway logs --service web                    # stream the most recent SUCCESSFUL deployment's logs
railway logs --service worker --lines 200     # history instead of a stream (also --since / --until)
railway logs --service worker --filter "@level:error"
railway logs --service web --latest           # the newest deployment, even if it failed or is still starting
railway logs --service web --latest --build   # build logs of the newest deployment (a failed or running build)
railway deployment list --service web         # deployment ids, statuses and times
railway logs <deployment-id>                  # one specific deployment's logs (add --build for its build)
railway logs --service web --http             # Railway's HTTP request log (status, path, duration, edge)
railway metrics --all                         # CPU, memory and HTTP metrics for every service (last hour)
```

Without a deployment id or `--latest`, `railway logs` shows the most recent **successful** deployment (the latest
one only if none succeeded). After a failed build, a failed pre-deploy migration or a crash, that is the previous
good deployment, not the one that broke, so add `--latest` (or pass the id from `railway deployment list`) when
investigating a failure. Web's pre-deploy `migrate.sh` output is part of that deployment's deploy logs.

Worker lines worth knowing: `worker starting` (instance, jobs), `waiting for migrations`, `jobs started`,
`job finished` (one per run: `job`, `outcome`, `durationMs` and counts), `push bridge leader acquired` /
`push bridge standby` / `push bridge leadership lost`, `worker shutting down` … `worker stopped`, and the fatal
`worker configuration invalid`, `minute lane wedged` and `worker event loop drained unexpectedly`. Job outcomes:
`ok`, `error`, `skipped_locked` (another worker holds the lock), `skipped_already_ran` (the slot already ran
elsewhere), `skipped_waiting` (`schedule-upkeep` waiting for that minute's `work-mode-tick`), `skipped_overlap`
(the lane was still busy) and `skipped_shutdown`. Web logs `realtime listener started` at the first request and
`web shutdown: draining …` on SIGTERM.

## Migrations

- **Automatic:** web's pre-deploy command `/app/migrate.sh` (`docker/web/migrate.sh`) runs `prisma migrate deploy`
  with the image's own Prisma CLI before a new web deployment receives traffic. It uses `DIRECT_URL` (Prisma's
  migration lock is a session advisory lock, which the pooler cannot hold), refuses a pooled connection string
  (`-pooler.` host or `pgbouncer=true`) and never prints a URL. Migration `20261008090000_worker_runtime`
  (`worker_heartbeats`, `worker_job_runs`) was applied this way on 2026-10-08.
- **Manual, in the running container** (needs an SSH key registered with Railway, `railway ssh keys add`; none is
  registered yet):

  ```bash
  railway ssh --service web -- /app/migrate.sh
  ```

- **Manual, from a trusted machine** against the direct endpoint (`DIRECT_URL` from `.env.deploy`):

  ```bash
  DATABASE_URL="$DIRECT_URL" pnpm --filter @clockoff/db exec prisma migrate deploy
  ```

- Never use `migrate dev`, `migrate reset` or `db push` against production. `GET /api/health` returns
  `migrations: "up_to_date" | "pending" | "failed"` and a 503 unless everything is applied.

## Environment variables

Values live only in Railway; the full reference is `docs/ENVIRONMENT.md`. **`.railway/railway.ts` is the
authoritative list of names**: a name that is not listed there must not be set on Railway until it is added (the
next `railway config apply` would delete it). `apps/web/.env.production.example` only gives example values with
notes, and parts of its header are out of date: it suggests Railway shared variables (production sets them per
service, as below), says Railway provides `PORT` (web sets `PORT=8080` itself; the image default is 3000), and
gives values for names production leaves unset (`APNS_*`, `NEXT_PUBLIC_APP_STORE_URL`, `MARKETING_ALIAS_HOSTS`,
`REDIS_URL`, the mobile token lifetimes). Where they differ, this page and `.railway/railway.ts` are right.

| Service            | Variables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| web **and** worker | `APP_URL`, `CLIENT_IP_HEADER` (`x-real-ip`), `DATABASE_URL` (Neon pooled), `DEV_TOOLS_ENABLED` (`false`), `DIRECT_URL` (Neon direct), `EMAIL_FROM`, `EMAIL_PROVIDER` (`resend`), `HOST_ROUTING` (`on`), `INTEGRATION_ENCRYPTION_KEY`, `LOG_LEVEL`, `MARKETING_URL`, `MOBILE_JWT_KEY_ID`, `MOBILE_JWT_SECRET`, `NEXT_PUBLIC_APP_URL`, `NEXT_TELEMETRY_DISABLED`, `RATE_LIMIT_BACKEND` (`memory`), `RESEND_API_KEY`, `SESSION_SECRET`, `SESSION_TTL_DAYS`, `SHUTDOWN_GRACE_MS` (`20000`), `TEST_TOOLS_ORGANISATION_IDS`, `TRUSTED_PROXY_HOPS` |
| web only           | `PORT` (`8080`), `REALTIME_STREAM_MAX_LIFETIME_MS` (`300000`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| worker only        | `WORKER_JOBS_ENABLED` (`true`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| www                | `REDIRECT_TO`, `PORT` (set in `.railway/railway.ts`; not secrets)                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Both app services validate the same schema (`apps/web/src/lib/env.ts`), so a value used by both must be the same in
both. The values were copied from the Netlify site unchanged (secrets were not regenerated, so sessions and device
tokens stayed valid). `JOBS_ENABLED` and `CRON_SECRET` were retired and not copied, and `CLIENT_IP_HEADER` changed
from Netlify's `x-nf-client-connection-ip` to `x-real-ip` (D-028, D-029). Railway itself injects `RAILWAY_*`
(replica id, service name, commit), which the worker's heartbeat and the env checks read.

```bash
railway variable list --service worker                                # prints values: never paste the output anywhere
railway variable set LOG_LEVEL=debug --service worker                  # redeploys the worker
printf '%s' "$NEW_KEY" | railway variable set RESEND_API_KEY --stdin --service web    # secrets via stdin
railway variable delete SOME_OLD_NAME --service web
```

- Changing a variable redeploys that service (`--skip-deploys` defers it). For a shared variable, change web and
  worker.
- A **new** variable name must also go into `.railway/railway.ts` in the same change, or the next
  `railway config apply` deletes it ([the `preserve()` rule](#configuration-as-code)). Example: the APNs variables
  (`APNS_*`, read by the push bridge in the worker) and `NEXT_PUBLIC_APP_STORE_URL` (read at runtime by web) are not
  set today and are not in the file yet.
- Testing on `web-production-4ccf9.up.railway.app` with a browser login needs `APP_URL` / `NEXT_PUBLIC_APP_URL` set to
  that domain and `HOST_ROUTING=off` (the CSRF origin check compares against `APP_URL`); restore the production
  values afterwards.

### Deploy-time values (`.env.deploy`)

`.env.deploy` is a local, gitignored file that holds live credentials for operator tasks. Never commit it or paste
its values. The DNS values are never set on Railway and the app never reads them.

| Variable        | Purpose                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------- |
| `DIRECT_URL`    | Direct Neon connection for manual migrations and scripts (the same value is set on Railway) |
| `DNS_PROVIDER`  | `cloudflare`                                                                                |
| `DNS_ZONE_ID`   | Cloudflare zone id of `clockoff.online` (`e2bcea4df92e1b74449156c648c2cd78`, not a secret)  |
| `DNS_API_TOKEN` | Cloudflare API token with Zone → DNS → Edit on `clockoff.online` only                       |

## Scale and size

- **Sizes** (owner's brief: web around 512 MB, worker around 256 MB) are set in `railway/<service>.json`
  (`limitOverride.containers`) and applied with `railway config apply`. Each image caps the Node heap well inside
  its limit (`NODE_OPTIONS=--max-old-space-size=…` in the Dockerfile), leaving room for Prisma's engine and
  buffers. Raise a heap cap and its memory limit together.
- **CPU caps** (web 2, worker 1, www 0.5 vCPU, added in commit `e9e87c1` and applied on 2026-10-08 — `railway
metrics --all` shows them as each service's vCPU limit) limit how fast a runaway process spends; they do not keep it under the usage
  limit. At approximately $20 per vCPU-month, web pinned at its cap costs about $40 a month (about $1.30 a day), so
  the $15 alert would fire within about 9–11 days and the $25 hard cap would stop every service within about
  2.5 weeks. The worker at its 1 vCPU cap (about $20 a month) plus the baseline comes close to the hard cap too.
  The $15 alert is the early warning: when it fires, check `railway metrics --all` and stop the runaway process.
- **Measured** (Railway metrics on 2026-10-08): first 30 minutes web 161 MB of 512 MiB, worker 86 MB of 256 MiB,
  www 14 MB of 128 MiB; over the hour to 14:07 UTC web 161 MB, worker 89 MB, www 16 MB; CPU below 0.01 vCPU each.
  Usage after the first ~2.5 hours was $0.01 (approximately $3 a month at that rate, inside the $5 the Hobby
  subscription includes). Check again with `railway metrics --all --since 1d` and `railway usage`.
- **More worker replicas** are safe: the advisory locks and slot claims run each job slot once, and exactly one
  worker (the lease holder) bridges pushes.
- **More web replicas** are not ready: the rate limiter is in memory per process (`RATE_LIMIT_BACKEND=memory`), so
  limits would multiply. Realtime already works across processes. Add the Redis rate limiter first
  (`docs/SECURITY.md` §4).

## Health checks

`GET /api/health` (web, any host) is Railway's deploy health check for web and the first thing to look at:

```json
{
  "status": "ok",
  "database": "ok",
  "migrations": "up_to_date",
  "worker": {
    "status": "fresh",
    "lastHeartbeatAt": "…",
    "ageSeconds": 45,
    "instances": 1,
    "jobs": "ok",
    "lastSuccessfulTickAt": "…"
  },
  "realtime": { "mode": "postgres", "listening": true },
  "time": "…"
}
```

- **Status code:** 200 when the database answers and every migration is applied; 503 (`"status": "degraded"`)
  when the database is unreachable or migrations are pending or failed. The `worker` block **never** changes the
  status code: Railway gates web deploys on this endpoint, and a stopped or stale worker must not block web.
- **`worker.status`:** `fresh` (newest live heartbeat within 3 minutes), `stale` (older), `stopped` (every row was
  stopped gracefully), `never` (no rows), `unknown` (database error). `instances` counts live rows beating within
  3 minutes.
- **`worker.jobs`:** `ok` (a `work-mode-tick` succeeded within 3 minutes), `starting` (jobs started less than
  3 minutes ago), `waiting_for_migrations`, `disabled` (`WORKER_JOBS_ENABLED=false` on every live worker), `stale`
  (no successful tick for 3 minutes) or `unknown`. A healthy production reads `status: "fresh"` **and**
  `jobs: "ok"`.
- **`realtime`:** `mode: "postgres"` and `listening: true` in production; `in_process` means web has no `DIRECT_URL`
  and dashboards only see the worker's changes through their 30 s refresh.
- The worker has no HTTP health check; Railway restarts it when it exits non-zero (`ON_FAILURE`, at most 10
  retries, after which the deployment stays crashed: [Troubleshooting](#troubleshooting)). It exits 1 on a
  configuration error, an uncaught exception, a minute lane that made no progress for 10 minutes (watchdog) or an
  event loop that drained unexpectedly. It never exits on a transient database error: it retries and reconnects.
- www answers `GET /healthz` with 200 `ok`.

## Graceful shutdown and draining

- **web:** on SIGTERM, Next.js stops accepting connections, waits for in-flight requests and pending `after()`
  tasks, and exits 0. `src/instrumentation.ts` installs a second handler that first ends every open SSE stream with
  the `reconnect` frame (so dashboards reconnect at once, to the new deployment) and arms a `SHUTDOWN_GRACE_MS`
  (20 s) deadline that exits 0 if Next has not finished. Events published by the last requests are flushed to
  Postgres before exit. Railway's draining period (30 s) is the hard stop.
- **worker:** on SIGTERM it stops its timers, hands over push leadership first (flush, release the lease; a standby
  worker takes over within about 5 s), lets running jobs finish for up to `SHUTDOWN_GRACE_MS`, marks its heartbeat
  row stopped, releases its locks, closes the event bus, disconnects Prisma and exits 0. The fixed steps take up to
  20.5 s on top of the grace, which fits the 60 s draining period. A job still running at the deadline is abandoned
  and its locks die with the lock session.
- `SHUTDOWN_GRACE_MS` is capped at 25 000 by the env schema, the most both draining periods allow; raise the
  draining periods in `railway/*.json` before raising the cap (`railwayConfig.test.ts` checks the arithmetic).
- Both images run Node as PID 1 (exec-form `CMD`), so SIGTERM reaches it directly.

## Cost guardrails

- **Plan:** Railway Hobby, $5 a month including $5 of usage. Usage is billed at approximately $10 per GB of memory
  per month and $20 per vCPU per month, plus network egress. At the measured footprint (about 0.26 GB of memory in
  total, CPU near zero) usage comes to roughly $3 a month, so the bill should stay at approximately the $5
  subscription. These are estimates: check the real figures, not this page.
- **Usage limits** (workspace): an alert at **$15** (soft) and a **hard cap of $25** a month. When the hard cap is
  reached Railway **stops the services** and the site goes down until the limit is raised or the period resets. The
  per-service CPU and memory caps slow a runaway process down but do not stop it reaching the cap (web at its
  2 vCPU cap would take about 2.5 weeks: [Scale and size](#scale-and-size)).
- **How to check:**

  ```bash
  railway usage                  # this billing period's usage
  railway usage limit status     # the soft and hard limits
  railway usage projects         # usage by project
  railway metrics --all --since 7d
  ```

  Or the Railway dashboard → workspace → Usage.

- The always-on worker also keeps **Neon's** compute awake around the clock, which on Neon's free plan uses up the
  monthly compute allowance before the month ends. That is the larger cost and availability risk; see
  `docs/STATUS.md` › Risks.

## Worker one-off commands

The worker bundle has a small CLI (`apps/web/src/worker/cli.ts`). In development: `pnpm worker <command>` (loads
the root `.env`). In production it runs inside the worker container, which needs an SSH key registered with
Railway (`railway ssh keys add` or `railway ssh keys github`; **none is registered yet**):

```bash
railway ssh --service worker -- node /app/main.mjs list                 # the jobs, their intervals and lock keys
railway ssh --service worker -- node /app/main.mjs run work-mode-tick   # one run now under the job's lock
railway ssh --service worker -- node /app/main.mjs emit-diagnostic <organisationId>
```

- `run <job>` takes the job's lock but claims no slot (an extra run). Exit codes: 0 ok, 1 error, 2 usage,
  3 locked elsewhere (a scheduled run holds it), 4 migrations not up to date. It prints one JSON result line on
  stdout between the pino log lines.
- `emit-diagnostic <organisationId>` publishes a `diagnostic.ping` realtime event and prints its nonce; a raw SSE
  reader of that organisation's stream sees it (dashboards ignore the type). It proves worker → Postgres → web →
  browser end to end. Exit 2 for an unknown organisation.
- `WORKER_JOBS_ENABLED=false` (a variable change, which redeploys the worker) pauses every job while the heartbeat
  and push leadership continue; health then reads `jobs: "disabled"`.

## Troubleshooting

- **`worker.status: "stale"` although the worker runs:** a worker that crashed (killed, OOM, watchdog exit) never
  marks its row stopped, so the row stays "live" and reads stale until it is pruned after 7 days. It only shows
  while no other worker beats: as soon as a running worker beats (every minute) the status is `fresh` again. If it
  persists, the worker is not running: check `railway deployment list --service worker` and
  `railway logs --service worker --latest` (without `--latest` you see the previous successful deployment), and
  see "A service shows Crashed" below. A crashed row can be cleared by hand, through the direct
  connection, with
  `UPDATE worker_heartbeats SET stopped_at = now() WHERE instance_id = '<id>'` (only for an instance whose process
  is gone; `instance_id` is the Railway replica id).
- **`worker.jobs: "waiting_for_migrations"`:** the worker's code is newer than the database. Web's pre-deploy
  migration has not run or failed: find web's newest deployment with `railway deployment list --service web` and
  read its log with `railway logs --service web --latest` (the pre-deploy `migrate.sh` output; a failed build is
  in `railway logs --service web --latest --build`). Fix the migration, or roll the worker back to its previous
  deployment.
- **`worker.jobs: "stale"` with a fresh heartbeat:** the worker beats but `work-mode-tick` has not succeeded for
  3 minutes. Look for `job finished` lines with `outcome: "error"` or a blocked database. If the minute lane makes
  no progress for 10 minutes the watchdog exits the worker and Railway restarts it.
- **The worker exits at start (`worker configuration invalid`):** read `railway logs --service worker --latest`;
  the message names the variable. Usual causes: `DIRECT_URL` missing or pooled, `JOBS_ENABLED=false` copied from
  the old Netlify site (remove it), or `CLIENT_IP_HEADER` set to a header Railway's edge does not set (production
  accepts `x-real-ip` or `x-forwarded-for`).
- **A service shows Crashed (crash loop):** every service restarts `ON_FAILURE` with at most 10 retries. After the
  tenth failed restart Railway stops trying and the deployment stays crashed until someone acts; for web that
  means the site is down. Read `railway logs --service <service> --latest`, fix the cause (often a variable;
  changing one redeploys the service), then `railway restart --service <service>` (same image) or
  `railway redeploy --service <service>`. If the newest deployment itself is the problem, roll back
  ([Roll back](#roll-back)).
- **LISTEN / `DIRECT_URL`:** realtime and advisory locks need a real Postgres session. `DIRECT_URL` must be Neon's
  direct host (`ep-…` without `-pooler`, no `pgbouncer=true`); a pooled one is refused at startup in production,
  by `migrate.sh` and by the worker's session check. Without `DIRECT_URL` web falls back to in-process realtime
  (`realtime.mode: "in_process"`) and the worker refuses to start.
- **Client IP header:** rate limits and the audit log key on `X-Real-IP`, which Railway's edge overwrites with the
  connecting client's address (checked on 2026-10-08: a login with a spoofed `X-Real-IP` and `X-Forwarded-For`
  recorded the real public IP). To re-check, sign in and compare the IP the app records (the session row, or the
  audit log entry of a change you make) with your own public address. If it ever shows a Railway CDN address
  instead, set `CLIENT_IP_HEADER=x-forwarded-for` (its leftmost entry, which the edge also rewrites).
- **`/api/health` answers 503 with `"database": "unreachable"`:** web cannot reach Neon. Check whether the free
  plan's compute allowance is used up (Neon console → project → Usage; `docs/STATUS.md` › Risks).
- **Every hostname is down at once:** check `railway usage limit status` (the hard cap stops the services) and the
  deployment status of web.

## Database (Neon)

|                  |                                                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Project          | `clockoff` (`quiet-flower-84715995`), organisation "ClockOff" (free plan)                                                         |
| Region / version | `aws-eu-west-2` (London) / Postgres 17                                                                                            |
| Branch           | `production` (`br-summer-band-zamyb83w`, default)                                                                                 |
| Database / role  | `clockoff` / `clockoff`                                                                                                           |
| Endpoints        | pooled `ep-proud-bonus-za5wlmr7-pooler.c-2.eu-west-2.aws.neon.tech`, direct `ep-proud-bonus-za5wlmr7.c-2.eu-west-2.aws.neon.tech` |

- `DATABASE_URL` is the **pooled** connection (PgBouncer, transaction mode) for Prisma; `DIRECT_URL` is the
  **direct** one, read at runtime by both services for the LISTEN session and the worker's advisory locks, and by
  migrations. Both are Railway variables.
- **Compute:** the free plan has a fixed 0.25 CU compute that suspends when idle. The worker queries every minute,
  so compute never suspends: see `docs/STATUS.md` › Risks for the allowance estimate and the options.
- **Seed:** never. The seed refuses `NODE_ENV=production` and any non-local database unless `ALLOW_SEED=true`.

### Backups and restore

Neon keeps point-in-time history of the branch. On the free plan the **restore window is 6 hours**
(`history_retention_seconds = 21600`); paid plans keep 7–30 days. There are no other automatic backups.

To restore:

1. Neon console → project `clockoff` → **Restore** → pick a time within the window, or via the API:
   `POST /api/v2/projects/quiet-flower-84715995/branches` with `{"branch": {"parent_id": "br-summer-band-zamyb83w", "parent_timestamp": "<ISO time>"}}`.
2. Inspect the restored branch through its own connection string.
3. Either restore the `production` branch in place from the console, or point `DATABASE_URL` and `DIRECT_URL` on
   web and worker at the restored branch (each change redeploys that service).

Recommended until on a paid plan: a nightly `pg_dump "$DIRECT_URL" | gzip` to private storage.

## Email (Resend)

- `ResendEmailProvider` (`apps/web/src/server/email`) sends through Resend's HTTP API when `EMAIL_PROVIDER=resend`;
  development keeps `ConsoleEmailProvider`. Verification, password-reset, manager-invite and employee-invite emails
  go out from web; the hourly manager digest goes out from the worker. Both services carry `EMAIL_PROVIDER`,
  `EMAIL_FROM` and `RESEND_API_KEY`.
- Sending domain `clockoff.online` (Resend id `538d0ad9-2bee-472e-9b12-36eff396662d`, region `eu-west-1`, sending
  only), from `ClockOff <noreply@clockoff.online>`. **Verified** since 2026-10-06. On 2026-10-08 a registration on
  Railway received its verification email (Resend status `delivered`).
- **SPF path: subdomain.** Resend's records put SPF on `send.clockoff.online` (MX
  `feedback-smtp.eu-west-1.amazonses.com` and TXT `v=spf1 include:amazonses.com ~all`), plus the `rsend` CNAME and
  the DKIM key on `resend._domainkey`. The apex SPF (`v=spf1 include:_spf-eu.ionos.com ~all`, for the IONOS
  mailbox) is untouched.
- **DMARC:** the existing `_dmarc` CNAME → IONOS (`v=DMARC1; p=none;`) meets Resend's recommendation. For aggregate
  reports, replace that single CNAME with **one** TXT record (for example
  `v=DMARC1; p=none; rua=mailto:support@clockoff.online`): back up, delete the CNAME, then create the TXT. Never add
  a second `_dmarc` record. This is optional.

## DNS

Authoritative DNS is the Cloudflare zone `clockoff.online` (zone id `e2bcea4df92e1b74449156c648c2cd78`,
nameservers `lola.ns.cloudflare.com` and `thaddeus.ns.cloudflare.com`); the registrar is still IONOS. The full
inventory, the history and the runbook are in **`docs/DNS_RECORDS.md`**. The web-facing records:

| Type  | Name                                 | Content                   | Points at                                           |
| ----- | ------------------------------------ | ------------------------- | --------------------------------------------------- |
| CNAME | `@` (flattened)                      | `agkcy0yy.up.railway.app` | Railway `web` (custom domain `clockoff.online`)     |
| CNAME | `app`                                | `2dw7hnz7.up.railway.app` | Railway `web` (custom domain `app.clockoff.online`) |
| CNAME | `www`                                | `vf3z52wc.up.railway.app` | Railway `www`                                       |
| TXT   | `_railway-verify` (+ `.app`, `.www`) | `railway-verify=…`        | Railway domain-ownership tokens: keep them          |

Rules (owner's, mandatory): every record DNS only (`"proxied": false`); never modify or delete the MX records or
the apex SPF TXT; one SPF TXT at the apex and one `_dmarc` record; back up the full record set to
`docs/dns-backup-<UTC timestamp>.json` and commit it before any edit or delete. All changes go through the
Cloudflare API with the token in `.env.deploy` (`docs/DNS_RECORDS.md` §5). The cutover backup is
`docs/dns-backup-20261008T113952Z.json`.

## Production verification (2026-10-08)

Checked between about 11:30 and 11:50 UTC, first on `web-production-4ccf9.up.railway.app` before the DNS change and
again on `https://app.clockoff.online` after it, with a throwaway manager (`delivered@resend.dev`) and a throwaway
organisation. Both were deleted afterwards, and every table's row count was unchanged.

| Check                          | Result                                                                                                                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Register · email · verify      | `POST /api/auth/register` 201; Resend delivered the verification email; verify 200                                                                                                                       |
| Login · session                | login 200 (session and CSRF cookies); `/api/auth/me` 200; logout 200                                                                                                                                     |
| Organisation · dashboard       | organisation create 201; `/dashboard` 200                                                                                                                                                                |
| Realtime across processes      | SSE stream 200; a 1-minute organisation-wide emergency override delivered `OVERRIDE_CREATED` (from web) and then `OVERRIDE_EXPIRED` (from the worker's minute sweep) on the dashboard stream, 81 s apart |
| Mobile API                     | structured JSON errors: bogus `join/lookup` code → 404 `INVALID_COMPANY_CODE`; `/api/mobile/v1/me` without a token → 401 `UNAUTHENTICATED`                                                               |
| `/api/health`                  | 200, worker `fresh` with jobs `ok`, realtime `postgres` and listening; migration `20261008090000_worker_runtime` applied by the pre-deploy step                                                          |
| Client IP                      | a login sent with spoofed `X-Real-IP: 9.9.9.9` and `X-Forwarded-For: 1.2.3.4` recorded the real public IP on the session                                                                                 |
| Security headers               | CSP, HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy` present                                                                                                                                 |
| Hostnames (`curl`, ~11:57 UTC) | apex 200; `www` 308 → apex with path and query; `app` `/` 307 → `/overview`; apex `/login` 308 → app; app `/pricing` 308 → apex; apex `/api/mobile/v1/me` 404; `http://` 301 → `https://`                |
| Not verifiable yet             | a Planday sync (Planday is not built; the 15-minute slot reports `NO_AVAILABLE_PROVIDER`)                                                                                                                |

`GET /api/mobile/v1` (the bare prefix) answers Next's 404 page, as before; the iOS app only calls subpaths.

## Netlify wind-down (history)

From 2026-10-06 to 2026-10-08 production ran on the Netlify site `clockoff` (`clockoff.netlify.app`, free plan,
functions in `us-east-2`), with a per-minute Netlify Scheduled Function that called `POST /api/jobs/tick`. On
2026-10-07 the free plan's credits ran out; Netlify skipped deploys and then paused the site, and on the morning of
2026-10-08 every hostname answered 503. Production moved to Railway the same day (D-023).

- **Netlify today:** builds stopped and the custom domains removed (no primary domain, no aliases). The site still
  exists, paused, and has **not** been deleted: deleting it, or keeping it as a fallback, is the owner's decision.
  Its last published deploy still contains the scheduled function, but that function calls `APP_URL/api/jobs/tick`,
  which no longer exists on Railway (the request is refused), so it cannot run a tick even if Netlify unpauses the
  site.
- **Removed from the repository:** `apps/web/netlify.toml`, `apps/web/netlify/functions/`, `deno.lock`, the
  `build:netlify` script, `@netlify/plugin-nextjs`, `node-cron`, the `rhel-openssl-3.0.x` Prisma engine target and
  the `.netlify` ignore lines.
- **Still attached to GitHub:** Netlify's repository link, webhook and read-only deploy key on `FrxshCutt/clockoff`.
  They go away when the site is deleted.
- The Netlify-era runbook and its production verification tables (2026-10-06 and 2026-10-07) are in git history:
  `git show e9e87c1:docs/DEPLOYMENT.md`.

## iOS

Release builds call `https://app.clockoff.online/api/mobile/v1` (`apps/ios/Config/Release.xcconfig`,
`API_BASE_URL`, enforced by `Scripts/verify-release.sh`); Debug builds for a device call the same production API,
and the simulator calls `http://localhost:3000/api/mobile/v1` (`docs/IOS_SETUP.md`).
