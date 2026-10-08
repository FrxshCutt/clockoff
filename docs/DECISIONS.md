# Decisions & Assumptions Log

Each entry records a choice made autonomously during the build, why, and what to change if the
assumption is wrong. Newest at the bottom.

## D-001 — New repository at `~/workmode`

No existing repository matched the brief (see `REPO_AUDIT.md`). Created a fresh git repo on `main`.

(Superseded by D-022: the repository is now GitHub `FrxshCutt/clockoff` and the checkout is `~/clockoff`.)

## D-002 — Pin Next.js 15.5, Prisma 6.19, TypeScript 5.9, Vitest 3, ESLint 9

The registry's `latest` tags were Next 16, Prisma 7 (8 rc), TypeScript 7 (native), Vitest 5, ESLint 10.
The spec names Next.js 15 and `prisma migrate dev`; Prisma 7 replaced `datasource.url` + `prisma-client-js`
with `prisma.config.ts` + driver adapters, and TypeScript 7 is the Go port with incomplete tooling support.
Pinning to the last stable line of each keeps the toolchain predictable. Upgrade path: bump one major at a time.

## D-003 — pnpm `minimumReleaseAge` policy kept; three packages pinned one patch back

pnpm 11 refuses packages published < 24h ago. `typescript-eslint@8.71.1`, `@vitejs/plugin-react@6.1.2`
and `postcss@8.5.29` were published the day of the build, so `8.70.1`, `6.1.1`, `8.5.28` are pinned.
This is a supply-chain safety feature and intentionally left on.

## D-004 — Postgres on port 5433, Docker Compose, two databases

A Supabase stack on this machine already occupies 54321–54327; 5432 is kept free for any system Postgres.
`docker/postgres-init.sql` creates `clockoff` and `clockoff_test` with `citext` + `pgcrypto`.
Integration tests use `TEST_DATABASE_URL` and reset that database; they never touch dev data.

## D-005 — Single root `.env` loaded with `dotenv-cli`

Prisma and Next.js each look for `.env` in their own package. One root `.env` (from `.env.example` via
`pnpm setup:env`) is passed to every script with `dotenv -e ../../.env --`, so there is a single source
of configuration and nothing to keep in sync.

## D-006 — Internal packages consumed as TypeScript source (no build step)

`@clockoff/shared`, `@clockoff/validation`, `@clockoff/db` export `./src/*.ts`. Next.js
`transpilePackages`, Vitest and `tsx` all consume TS directly. `build` for these packages is `tsc --noEmit`.
Simpler than maintaining `dist/` outputs; revisit only if a non-TS consumer appears.

## D-007 — First-party manager session auth instead of Auth.js v5 / Better Auth

The spec allows "Auth.js (NextAuth v5) or Better Auth". NextAuth v5 is still a beta line; Better Auth
imposes its own `user/account/session/verification` tables that conflict with the spec's `User` model
(`password_hash`, `email_verified_at` on the user). Email+password with argon2id, DB-backed sessions,
hashed/expiring reset + verification tokens, CSRF (origin check + double-submit), and rate limiting
are ~400 lines of well-understood code that match the §3 schema exactly and are fully covered by
integration tests. No OAuth is required for the MVP. If social login is needed later, Auth.js can be
layered on the same `User` table.

## D-008 — OpenAPI generated in-house from Zod 4 (`z.toJSONSchema`)

Zod 4 ships JSON-Schema export. A small route registry in `@clockoff/validation` emits
`docs/openapi.json` without a third-party OpenAPI adapter whose Zod 4 support is uncertain.

## D-009 — iOS: XcodeGen `project.yml` is the source of truth; generated `.xcodeproj` committed

Hand-maintaining `project.pbxproj` for four targets is error-prone. `make generate` regenerates it.
Bundle id placeholder `com.workmode.app` (+ `.devicemonitor`, `.shieldconfig`, `.shieldaction`),
App Group `group.com.workmode.app.shared`, `DEVELOPMENT_TEAM` left blank in `Signing.xcconfig`.
No code-signing identity exists on the build machine, so real-device runs are documented, not executed.

(Bundle ids and App Group superseded by D-021: `online.clockoff.app*` and `group.online.clockoff.app.shared`.)

## D-010 — Prisma config via `prisma.config.ts`, migrations committed, `db push` never used

`package.json#prisma` is deprecated; `prisma.config.ts` (`defineConfig`) holds schema path and seed command.

## D-011 — Parallel build with strict file ownership

The MVP is built by several engineers (agents) working concurrently in one working tree. Each owns a
disjoint set of paths; nobody edits package manifests, the Prisma schema, migrations or shared configs
except the integrator. API contracts live in `packages/validation` and are written before handlers and UI,
so API, UI and iOS work proceed in parallel against the same schemas. Every module is built, then reviewed
by a second engineer who fixes defects directly. The integrator runs the full gates between phases and
commits.

## D-012 — Playwright smoke runs against `pnpm dev`

`apps/web/playwright.config.ts` reuses a running dev server on :3000 or starts one. Chromium was
installed locally with `npx playwright install chromium`. In CI the smoke test is optional (see TESTING.md)
because it needs a seeded database and a long-running server.

## D-013 — Register never reveals whether an email exists

`POST /api/auth/register` returns the same 201 body for new and existing addresses and pays the argon2 cost in
both branches; the owner of an existing account gets an "you already have an account" email. With
`REQUIRE_EMAIL_VERIFICATION=true` (the production default) registration never creates a session, so cookies are
identical too.

## D-014 — Organisation structure is edited by OWNER/ADMIN (`org:manage`)

Locations, departments and teams are created/edited/deleted with `org:manage` (as in the route map); managers can
read structure and manage team membership (`employees:write`). The spec's MANAGER role writes employees,
schedules, imports and overrides, not the organisation's shape.

## D-015 — `GET /sync.policyVersion` is the PolicyVersion UUID

The device compares the UUID of the policy version it applied (`Device.policyVersionId` is a foreign key). A
composite "policy + break policy" string is recorded in `POLICY_SYNCED` metadata for diagnostics; break-policy
changes are detected through the schedule/policy bundle diff and the push bridge.

## D-016 — Device and server may both record the same fact; the feed keeps one

Permission, selection, sync and break facts can be reported by the phone (outbox) and observed by the server
(device-state reports, sync, the job). The ingest path treats the second copy as a duplicate so the activity feed
shows each fact once, in either order.

## D-017 — Spec correction: Europe/London's spring-forward gap

The spec's example "02:30 on 2026-03-29 is nonexistent in Europe/London" is wrong: London's gap that night is
01:00–01:59. The time helpers and tests use the real gap (01:30 → 02:30) and America/New_York's 02:30 → 03:30.

## D-018 — `@prisma/client` is a direct dependency of `apps/web`

With pnpm, Next could not resolve `@prisma/client` from the web app, so `serverExternalPackages` was ignored
and the client was bundled in `next dev`, where a cached client outlived module reloads and broke nested
`Prisma.sql` fragments. Declaring the dependency fixes the root cause.

## D-019 — Hosting: Netlify + Neon (London) + IONOS DNS for clockoff.online

The owner chose Netlify for hosting and keeps DNS at IONOS (where the domain and its email live). One Netlify
site serves both hostnames via middleware host routing. The minute job is a Netlify Scheduled Function (per-
minute schedules work on every Netlify plan, unlike Vercel Hobby). IONOS keeps authoritative DNS so the existing
MX/SPF/DMARC email records are untouched; the apex uses Netlify's load-balancer A record (75.2.60.5) because
IONOS has no ALIAS/ANAME record type, and the IONOS parking AAAA record must be removed. Builds always run on
Netlify's Linux image (Git-triggered) because the Prisma engine and argon2 are native modules. The Vercel
configuration from the first deployment attempt was removed. Superseded for DNS by D-020: the zone moved
to Cloudflare on 2026-10-06; the hosting, database and build choices above still apply.

(Hosting and builds superseded by D-023: production moved to Railway on 2026-10-08. Neon stays.)

## D-020 — DNS moved to Cloudflare (API-managed); email via a Resend sending subdomain

The owner moved authoritative DNS for `clockoff.online` from IONOS to a Cloudflare zone (free plan). The
registrar and the email mailbox stay at IONOS. The `.online` registry now delegates to `lola.ns.cloudflare.com`
and `thaddeus.ns.cloudflare.com`. Before the move the owner deleted the IONOS parking A and AAAA records on the
apex.

Decision:

- Every record change goes through the Cloudflare API. Nobody edits records by hand. The token is scoped to
  Zone → DNS → Edit on `clockoff.online` and is kept in the local gitignored `.env.deploy` (`DNS_API_TOKEN`,
  with `DNS_ZONE_ID` and `DNS_PROVIDER=cloudflare`). It is a deploy-time credential: it is not set on Netlify and
  the app never reads it.
- Every record we create is **DNS only** (`proxied: false`). Cloudflare proxying breaks Netlify's Let's Encrypt
  issuance and mail lookups.
- The MX records and the apex SPF TXT are never modified or deleted. The other IONOS records (`_dmarc`,
  `autodiscover`, `_domainconnect`) are kept.
- Before any destructive call, the full record set is saved to `docs/dns-backup-<UTC timestamp>.json` and
  committed. The first backup is `docs/dns-backup-20261006T205519Z.json` (6 records, verbatim API export,
  excluded from Prettier so it stays byte-for-byte).
- The apex keeps Netlify's load-balancer A record `75.2.60.5`. Cloudflare could flatten a CNAME at the apex, but
  the owner specified an A record and it is Netlify's documented value.
- Email uses Resend's sending subdomain: SPF (MX + TXT) on `send.clockoff.online`, the `rsend` CNAME, and DKIM on
  `resend._domainkey`. Resend does not need SPF at the apex, so the apex SPF (IONOS only) is not merged or
  changed.
- DMARC is unchanged. Resend's required records include no DMARC record, and the existing `_dmarc` CNAME to
  IONOS (`p=none`) satisfies its recommendation.

Consequences: DNS changes are scripted, every created record carries a Cloudflare comment describing it, and
the zone can be restored from a committed backup. Seven records were added (apex A, `www` and `app` CNAMEs,
four Resend records); the six IONOS records were re-read afterwards and are byte-identical, so IONOS mail is
unaffected. Netlify renews the certificate for all three hostnames only while their records stay DNS only and
point at Netlify. The Cloudflare token is one more credential to rotate. If the owner wants DMARC aggregate
reports, the `_dmarc` CNAME is replaced by one TXT record with `rua`; a second `_dmarc` record is never added.

(Partly superseded by D-023: since 2026-10-08 the web records point at Railway, and the apex is a CNAME that
Cloudflare flattens instead of Netlify's A record. Every other rule above still applies, DNS only included.)

## D-021 — Product renamed from Work Mode to ClockOff; "Work Mode" stays the name of the shift state

Context: the product ships as **ClockOff** on `clockoff.online`. "Work Mode" was used for two things: the product
and the state an employee's phone is in during an active shift. Only the product name changes. The full inventory,
every borderline call and the list of ambiguous occurrences left as "Work Mode" are in `docs/RENAME_AUDIT.md`.
(Superseded by D-022: those ambiguous occurrences now say ClockOff.)

Decision:

- Product name, page titles, emails, marketing copy, iOS display name and employee-facing copy that names the
  app say **ClockOff**. The state machine, `WORKING`, `WORK_MODE_STARTED` / `WORK_MODE_ENDED`, "WORK MODE ACTIVE",
  `WorkModeEngine`, `WorkModeController`, `workmode-cases.json` and the `work-mode-tick` function keep their names.
  No database enum, table, column, migration or API route changed.
- npm scope `@workmode/*` → `@clockoff/*`; root package `clockoff`.
- iOS bundle ids `com.workmode.app*` → `online.clockoff.app*` (reverse-DNS of the domain the owner controls, which
  avoids colliding with someone else's `com.clockoff` registration); App Group `group.com.workmode.app.shared` →
  `group.online.clockoff.app.shared` in all four targets; Keychain service, background-task id, shield store names,
  logger subsystem and notification names moved to the same prefix. Xcode project, scheme, targets and folders are
  `ClockOff*`; build settings `CLOCKOFF_*`.
- Kept on purpose: the internal `WorkModeCore` Swift package (and `WorkModeScreenTime`, `WorkModeLog`); local
  Postgres role/database names `workmode` / `workmode_test` and the `workmode-pgdata` volume; the seed hash salt;
  the digest advisory-lock key; cookie names `wm_*`; the GitHub repository `FrxshCutt/workmode` and the
  `~/workmode` checkout. (Superseded by D-022: all of these now use ClockOff names.)
- Mobile JWT issuer/audience became `clockoff` / `clockoff-mobile`; support address `support@clockoff.online`;
  sender `ClockOff <noreply@clockoff.online>`.
- Earlier entries in this log are historical and stay as written, except that the mechanical package-scope pass
  also rewrote `@workmode/` to `@clockoff/` inside D-006 and D-008. Other old identifiers in those entries (for
  example the bundle ids in D-009) are as originally decided. (Superseded by D-022: product-name prose and
  descriptions of the current repository in earlier entries now say ClockOff; changed decisions carry a note.)

Consequences: the new bundle ids make this a new app as far as Apple is concerned: the App ID, App Group,
Family Controls (Distribution) entitlement and provisioning profiles must be created again under
`online.clockoff.app` and its three extension ids before a device build or TestFlight upload works. Any existing
install (there are no production users) loses its Keychain tokens and App Group data and must onboard again.
Mobile access tokens signed with the old issuer/audience stop verifying; clients refresh within 15 minutes.

## D-022 — Everything else renamed to ClockOff

Context: after the first rename (D-021) the owner decided on 2026-10-07 to change everything else to ClockOff:
the 32 lines D-021 left as "Work Mode" because they could mean either the product or the shift state, and the
internal names D-021 kept on purpose. The inventory is in `docs/RENAME_AUDIT.md`.

Decision:

- The 32 ambiguous lines say **ClockOff**, worded naturally: "ClockOff cannot see your messages…", "whether
  ClockOff is set up and working", "ClockOff needs attention", "ClockOff's shields", "what ClockOff can and can't
  see", "finished setting up ClockOff", "Breaks aren't available in ClockOff at your workplace". Tests that pin
  these strings changed with them, and `docs/PRIVACY.md` was regenerated from `privacyStatements.ts`.
- Swift package `WorkModeCore` → `ClockOffCore` at `apps/ios/Packages/ClockOffCore` (targets `ClockOffCore` and
  `ClockOffScreenTime`, tests `ClockOffCoreTests` and `ClockOffScreenTimeTests`); `WorkModeLog` → `ClockOffLog`,
  `WorkModeDateCoding` → `ClockOffDateCoding`, `JSONEncoder` / `JSONDecoder` `.workMode` → `.clockOff`,
  `Notification.Name.workModeSelectionDidChange` / `.workModeAuthorizationStatusDidChange` →
  `.clockOffSelectionDidChange` / `.clockOffAuthorizationStatusDidChange`.
- App Group defaults keys and local-notification ids: prefix `wm.` → `clockoff.` (`clockoff.flags.*`,
  `clockoff.sync.*`, `clockoff.onboarding.step`, `clockoff.shift-<id>-start`, …).
- Web cookies `wm_session` / `wm_csrf` / `wm_org` → `clockoff_session` / `clockoff_csrf` / `clockoff_org`.
- Local Postgres: role and password `clockoff`, databases `clockoff` / `clockoff_test`, compose project pinned
  with `name: clockoff`, volume `clockoff-pgdata` (Docker volume `clockoff_clockoff-pgdata`), container
  `clockoff-postgres`. `.env.example` and CI use the new connection URLs.
- Seed hash salt `workmode-seed:` → `clockoff-seed:`; digest advisory-lock key `workmode:digest:` →
  `clockoff:digest:`.
- GitHub repository `FrxshCutt/workmode` → `FrxshCutt/clockoff` (public); the Netlify site builds from it. The
  local checkout is `~/clockoff`.
- Earlier entries in this log and `docs/REPO_AUDIT.md` use ClockOff for the product and describe the current
  repository (D-004 names the `clockoff` databases). Entries whose decision has since changed (D-001, D-009,
  D-021) keep their original text with a "superseded" note. Dated observation tables in `docs/DEPLOYMENT.md` and
  `docs/DNS_RECORDS.md` stay as observed.
- Unchanged, pending the owner's answer: "Work Mode" as the name of the shift state. "WORK MODE ACTIVE", "Work
  Mode active / started / ended", "switch Work Mode on / off", "During Work Mode", the state machine, the
  `WORK_MODE_*` enums, `workModeActive`, `WorkModeEngine*`, `WorkModeController*`, `workModeMachine`,
  `runWorkModeTick`, the `work-mode-tick` function, `workmode-cases.json`, `WORKMODE_PROPERTY_CASES`, the
  `packages/shared/src/workMode/` and `apps/ios/ClockOffApp/WorkMode/` folders and the
  `WORK_MODE_STATE_MACHINE.md` / `WORK_MODE_SERVER_JOB.md` docs keep their names.

Consequences: the session cookie is now `clockoff_session` and the old `wm_session` is no longer read, so the
owner signs in again once after the deploy. Seeded ids change on the next re-seed because the salt changed
(production is never seeded). Existing local databases need the steps in `docs/LOCAL_DEVELOPMENT.md` ›
"Upgrading an existing checkout" (recreate, or rename the role and databases and copy the volume) and the new
`DATABASE_URL` / `DIRECT_URL` / `TEST_DATABASE_URL` values in `.env`. An existing development install of the
iOS app does not read its old `wm.*` App Group keys (there are no production users). GitHub redirects the old
repository URL, and the Netlify deploy key and webhook stayed attached through the rename. The old local volume
`workmode_workmode-pgdata` is kept as a backup on the owner's machine; remove it with
`docker volume rm workmode_workmode-pgdata` once the new database is confirmed.

## D-023 — Hosting moved from Netlify to Railway (always-on services); Neon stays

Context: Netlify's free plan ran out of credits on 2026-10-07. Netlify skipped deploys and then paused the site, and
on the morning of 2026-10-08 every hostname answered 503. The owner asked to move the whole web app (marketing
site, dashboard, API and background jobs) to Railway as always-on services and to keep the Neon database.

Decision:

- Railway project `clockoff`, environment `production`, Hobby plan, region EU West (Amsterdam, the nearest to Neon
  in London). Three services built from GitHub `main` with Dockerfiles: `web` (Next.js `output: "standalone"`),
  `worker` (background jobs, D-024) and `www` (redirect, D-027). Each restarts on failure, never sleeps and runs
  one replica.
- Sizes as the owner asked: web 512 MiB, worker 256 MiB, with Node heap caps well inside; CPU caps of 2, 1 and
  0.5 vCPU, which limit how fast a runaway process spends but do not keep it under the usage limit (web at its
  cap costs about $40 a month, so it would reach the $15 alert in about 10 days and the $25 hard cap in about
  2.5 weeks; `docs/DEPLOYMENT.md` › Scale and size). Usage limits: an alert at $15 and a hard cap at $25 a month.
- Migrations run as web's pre-deploy command (`/app/migrate.sh`, `prisma migrate deploy` over `DIRECT_URL`), so a
  failed migration fails the deploy and the old deployment keeps serving. Web's deploy health check is
  `/api/health`.
- Graceful shutdown on SIGTERM in both processes, with Railway draining periods (web 30 s, worker 60 s) longer
  than the shutdown bound (`SHUTDOWN_GRACE_MS`, at most 25 s).
- The variables were copied from Netlify unchanged (secrets were not regenerated, so sessions and device tokens
  stayed valid), apart from the retired ones (D-029) and the client-IP header (D-028).
- All Netlify-specific code was removed (`netlify.toml`, the scheduled function, `deno.lock`, `build:netlify`,
  `@netlify/plugin-nextjs`, `node-cron`, the `rhel-openssl-3.0.x` Prisma target). Each image generates its own
  Prisma engine (`binaryTargets = ["native"]`).

Consequences: the app runs in one region close to the database instead of US functions. SSE streams can stay open
for minutes and the jobs run in a process that is always up. The cost is a fixed monthly bill (approximately the
$5 Hobby subscription at the measured footprint) instead of a free plan with credits. The always-on worker keeps
Neon's compute awake, which exhausts Neon's free compute allowance before the month ends (`docs/STATUS.md` ›
Risks; owner decision pending). The Netlify site is paused with its builds stopped and domains removed, but not
deleted, pending the owner's decision. Runbook: `docs/DEPLOYMENT.md`.

## D-024 — A separate worker process; one Postgres advisory lock and one slot claim per job

Context: on Netlify the minute job was a scheduled function calling an HTTP route. The owner wanted background
work split into its own process with its own entry point, so restarting web never interrupts jobs and the other
way round, and every job safe if two instances ever run at once.

Decision:

- The worker (`apps/web/src/worker`, bundled by esbuild into `main.mjs`) runs four jobs: `work-mode-tick` (every
  minute: break expiry, scheduled breaks, evaluation and the hourly digest), `override-expiry` (every minute),
  `schedule-upkeep` (every minute, after that minute's tick) and `integrations-sync` (every 15 minutes; a
  documented no-op until a workforce provider such as Planday registers). The web process runs no jobs
  (`src/deploy/processBoundaries.test.ts`).
- Each run takes a session-level `pg_try_advisory_lock` on a dedicated `DIRECT_URL` connection (keys in
  `src/worker/lockKeys.ts`, never reused) and then claims its minute slot in `worker_job_runs`, so a slot runs at
  most once across instances; a lock held elsewhere is `skipped_locked`, a slot already run is
  `skipped_already_ran`. A dead process's locks die with its session; idle-session timeouts free a vanished
  client's locks within about 2 minutes.
- The worker writes a `worker_heartbeats` row every minute and marks it stopped on a graceful shutdown.
  `/api/health` reports the heartbeat and whether jobs actually succeed (`worker.jobs`), but never fails web's
  health because of the worker.
- A new worker waits for web's pre-deploy migration (migration gate) instead of running against an old schema; a
  watchdog exits when the minute lane makes no progress for 10 minutes so Railway restarts it.
- The worker has a small CLI (`list`, `run <job>`, `emit-diagnostic <orgId>`) for manual runs and end-to-end
  checks.

Consequences: a second worker replica is safe. The scheduled tick no longer needs an HTTP route or a shared
secret (D-029). Every job stays idempotent, so the rare extra run (a manual `run`, a lock session lost mid-job)
is harmless; the future Planday sync must throttle on `lastSyncAt` for the same reason. Migration
`20261008090000_worker_runtime` adds the two tables.

## D-025 — Realtime across processes through Postgres LISTEN/NOTIFY; the push bridge runs in the elected worker

Context: the event bus was in-process. With jobs in a separate process, events the worker raises (override expiry,
work-state changes) would never reach the dashboards' SSE streams on web, and manager edits on web would never
reach a push bridge in the worker.

Decision:

- `PostgresEventBus` delivers each event to the process's own subscribers at once and NOTIFYs the others on the
  `clockoff_events` channel. NOTIFYs go out through the normal pooled Prisma connection, batched; one LISTEN
  session per process runs on `DIRECT_URL`, because PgBouncer's transaction mode cannot hold a LISTEN. A process
  ignores its own notifications, reconnects with backoff, and keeps payloads under Postgres's 8000-byte limit
  (oversized events are sent truncated, meaning "refetch").
- Without `DIRECT_URL` (tests, local runs without it) the bus stays in-process.
- SSE streams on the persistent server live 5 minutes (`REALTIME_STREAM_MAX_LIFETIME_MS`), then end with a planned
  `reconnect`; the dashboard's 30-second polling fallback stays for events missed during a reconnect.
- Only the worker holding a leadership lease (an advisory lock) bridges events to silent pushes; the others stand
  by and take over within about 5 seconds. Web never bridges, so a change is pushed once, not once per process.

Consequences: a second web or worker process sees every event. Events NOTIFYed while a listener is reconnecting
are missed by that process; dashboards recover through their 30-second refresh and phones at their next sync.
Health reports `realtime.mode` and `listening`. `DIRECT_URL` is now required at runtime in production, not only
for migrations.

## D-026 — Railway settings as infrastructure as code (`.railway/railway.ts`), not `railway.json`

Context: the owner asked for a committed config file per service (`railway.json` or `railway.toml`). Railway
refuses config-as-code files for new services ("Config as Code is deprecated. Use Infrastructure as Code") and
stops reading existing ones on 2026-12-01.

Decision: `.railway/railway.ts` (built on `railway/iac` from the `railway` npm package, pinned to 3.13.0) is what
Railway applies, through `railway config plan` and `railway config apply`. The per-service settings the owner asked
for stay in `railway/web.json`, `railway/worker.json` and `railway/www.json` (railway.json's schema), which the IaC
file reads; `apps/web/src/deploy/railwayConfig.test.ts` pins their contents. Variables are listed by name with
`preserve()`, so their values live only in Railway. Custom domains are managed outside the file.

Consequences: service settings change through a reviewed commit and a plan. A variable set in Railway but missing
from the file is deleted by the next apply, so a new variable's name is added to the file in the same change that
starts reading it.

## D-027 — A separate `www` redirect service

Context: Railway's Hobby plan allows two custom domains per service. The web service carries `clockoff.online` and
`app.clockoff.online`.

Decision: a third, dependency-free service (`docker/www-redirect/`, 128 MiB) answers `www.clockoff.online` with a
308 to `https://clockoff.online`, keeping the path and query; the `Host` header never chooses the destination. It
serves `/healthz` for Railway's health check.

Consequences: `www` behaves like the app's own alias redirect (on Netlify it was a 301 from Netlify itself). One
more small service to run (about 14 MB of memory). If the plan ever allows more domains per service, the web app
can carry `www` again (its host routing already redirects `www.` to the apex) and this service can go.

## D-028 — Client IP from `X-Real-IP` on Railway

Context: per-IP rate limits and the audit log need the real client address. On Netlify it came from
`x-nf-client-connection-ip`, which nothing sets on Railway; a header that the edge does not overwrite would let
clients choose their own rate-limit identity.

Decision: `CLIENT_IP_HEADER=x-real-ip`. Probed with a temporary echo service before the move: Railway's edge
overwrites `X-Real-IP` with the true client address and rewrites a client-sent `X-Forwarded-For` (it becomes
"client, edge address"). In production a login sent with a spoofed `X-Real-IP` and `X-Forwarded-For` recorded the
real public IP. The configured header's first comma-separated entry is used, so `x-forwarded-for` remains the
fallback (its leftmost entry) if `X-Real-IP` ever carries a CDN address. In production `env()` refuses Netlify's
`x-nf-*` headers, and on Railway any header other than those two.

Consequences: rate limits key on the real client. A misconfigured header fails startup in production instead of
silently opening the limits.

## D-029 — `JOBS_ENABLED`, `CRON_SECRET` and `POST /api/jobs/tick` retired

Context: the tick route existed for platforms without long-running processes; Netlify's scheduled function called
it with `CRON_SECRET`, and `JOBS_ENABLED=false` on Netlify meant "the scheduled function runs the tick". The worker
now runs every job.

Decision:

- The route `/api/jobs/tick`, the `cron` auth mode, the `/api/jobs/` origin-check exemption and `CRON_SECRET` are
  deleted: a secret that unlocks nothing is attack surface. `env()` warns while `CRON_SECRET` is still set.
- `JOBS_ENABLED` is never a switch any more. Its Netlify value was `false`, so a copy on Railway would have stopped
  every job while the heartbeat stayed fresh: `env()` warns while it is set and the worker refuses to start while
  it is `false`. The worker's kill switch is `WORKER_JOBS_ENABLED` (default `true`).
- Manual runs use the worker CLI (`node main.mjs run <job>`).

Consequences: neither retired name is set on Railway, and `railwayConfig.test.ts` fails if either is added to
`.railway/railway.ts`. The paused Netlify site's scheduled function can no longer run a tick, because the route it
calls does not exist. Future integrations (Planday) run in the worker's `integrations-sync` slot, not behind a
cron-authenticated HTTP route.
