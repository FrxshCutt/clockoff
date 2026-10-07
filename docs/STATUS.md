# Status

_Last updated: 2026-10-06. This is the honest state of the MVP: what works and how it was verified, what is
partial, and what needs external credentials or hardware that were not available while building it._

## Summary

All 26 build stages are implemented. Every quality gate passes on the build machine:

| Gate                                                 | Result                                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `pnpm typecheck` · `pnpm lint` · `pnpm format:check` | clean                                                                                                        |
| `packages/shared` unit tests                         | 1,930 passed                                                                                                 |
| `packages/validation` unit tests                     | 104 passed                                                                                                   |
| `packages/db` unit tests                             | 7 passed                                                                                                     |
| `apps/web` unit tests                                | 819 passed                                                                                                   |
| `apps/web` integration tests (real Postgres)         | 353 passed, incl. 85-case tenant-isolation matrix and the Definition-of-Done journey                         |
| Playwright manager journey (`apps/web/e2e`)          | passes on a fresh `pnpm dev`                                                                                 |
| `pnpm build` (Next.js production build)              | succeeds                                                                                                     |
| iOS `make build` / `make test`                       | WorkModeCore 195, WorkModeScreenTime 4, app 134 passed (1 Keychain test skipped on unsigned simulator hosts) |
| iOS `make build-release`                             | succeeds with the real Apple provider; `Scripts/verify-release.sh` confirms no mock code ships               |

The one thing that could **not** be exercised is real Screen Time enforcement on a physical iPhone: this Mac
has no code-signing identity, and Apple's FamilyControls / ManagedSettings / DeviceActivity only enforce on a
device. Everything around it is built, compiled for Release, and covered by tests with the mock provider.

## Definition of Done

| #   | Item                                                                                                             | Status                            | How it was verified                                                                                                                                                                                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Manager registers, verifies email, creates organisation, sees checklist + join code                              | ✅                                | Playwright journey (real browser, verification link via the dev-only email route); integration `definitionOfDone.test.ts`                                                                                                                                                                                            |
| 2   | Add Zach; Standard Staff policy as default; 2×15 RELAX_ALL break policy; shift 09:00–15:00                       | ✅                                | Playwright journey; integration journey                                                                                                                                                                                                                                                                              |
| 3   | NOT_INVITED → INVITED; Awaiting Setup panel with Copy Invite                                                     | ✅                                | Playwright journey (clipboard contains the join code)                                                                                                                                                                                                                                                                |
| 4   | iOS onboarding → single match → confirm → dashboard flips to JOINED in real time                                 | ✅ simulator                      | Ran the real app in the iOS 26.5 simulator against the local API (seeded employee Isla Murphy, code `BREW-4821`); the open employee page changed to "Joined · Permissions missing" without a reload                                                                                                                  |
| 5   | Grant Family Controls → select apps → confirm policy → Complete Setup → Connected; `SETUP_COMPLETED` in Activity | ✅ simulator (mock provider)      | Same simulator run: dashboard showed "Connected · Off shift" live; activity trail recorded joined → synced → permission granted → selection configured → setup completed, each exactly once. On a device the real `AuthorizationCenter` + `FamilyActivityPicker` replace the mock; see the device script below       |
| 6   | Before 09:00: Home OFF SHIFT, stores empty                                                                       | ✅ simulator                      | Home showed "OFF SHIFT · Next shift tomorrow 09:00 – 17:00 · Work Mode inactive"; `WorkModeController` reconcile tests assert stores are cleared off shift                                                                                                                                                           |
| 7   | At 09:00, app closed: apps shielded; Home WORK MODE ACTIVE; dashboard WORK_MODE_ACTIVE                           | ⚠️ logic verified, device pending | `MonitorEventHandler` (what the DeviceActivityMonitor extension runs) applies work shields on `intervalDidStart` in tests with in-memory stores; integration journey shows WORKING → WORK_MODE_ACTIVE once the device reports. Needs a physical iPhone for the real `ManagedSettingsStore`                           |
| 8   | Start Break: server validates, countdown, shields cleared (RELAX_ALL), dashboard ON_BREAK                        | ⚠️ logic verified, device pending | Integration journey (201, RELAX_ALL, `BREAK_ALREADY_ACTIVE` on repeat, ON_BREAK); `WorkModeControllerTests` cover start/offline start/countdown with the mock provider                                                                                                                                               |
| 9   | Break expiry with app closed: work shields restored; `BREAK_EXPIRED`                                             | ⚠️ logic verified, device pending | Integration journey: server job closes the break EXPIRED and records `BREAK_EXPIRED` once; the device's late report is deduplicated. Extension restoration on `intervalDidEnd(break-*)` is unit-tested. Breaks shorter than 15 min restore within 15 min if the app is closed (Apple's minimum interval; documented) |
| 10  | At 15:00: shields removed; OFF_SHIFT; `WORK_MODE_ENDED`                                                          | ⚠️ logic verified, device pending | Integration journey (job → OFF_SHIFT, shift COMPLETED, device report → `WORK_MODE_ENDED`); extension `intervalDidEnd(shift-*)` clears both stores in tests                                                                                                                                                           |
| 11  | Same scenario under `xcodebuild test` with the mock + shared fixtures in Vitest                                  | ✅                                | 100 shared fixtures run in both Vitest and XCTest (byte-identical copy, SHA-256 checked); `WorkModeControllerTests`, `SyncCoordinatorTests` drive the scenario with `MockRestrictionProvider`                                                                                                                        |
| 12  | Second organisation cannot read or mutate Harpenden data                                                         | ✅                                | 85-case tenant-isolation matrix (every by-id route → 404) plus journey step 11                                                                                                                                                                                                                                       |
| 13  | No endpoint/table/screen exposes messages, photos, browsing, notifications or selected app identities            | ✅                                | Strict mobile schemas reject extra fields (tests send `installedApps`, `appUsage`, `messages`, `notificationContents`, `browsingHistory`); employee/device responses checked for forbidden keys; only selection _counts_ are stored; push tokens encrypted and never returned                                        |
| 14  | All JS gates and all `xcodebuild` targets succeed; this file is accurate                                         | ✅                                | See the table above                                                                                                                                                                                                                                                                                                  |

### Manual device script (items 5–10 on hardware)

`docs/SCREEN_TIME_IMPLEMENTATION.md` §11 has the step-by-step script. In short: set your team in
`apps/ios/Config/Signing.local.xcconfig`, point `API_BASE_URL` at `http://<your Mac's LAN IP>:3000/api/mobile/v1` in `Config/Local.xcconfig`,
build the Debug scheme with the mock condition switched off, join with a seeded employee, schedule a shift
starting 5 minutes ahead, close the app, and confirm the shield appears at the start time, relaxes during a
break, returns at break end and lifts at shift end.

## Needs external credentials or accounts

| What                                                                | Why it matters                                                                                                                                                                       | How to configure                                                                                                                                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apple Developer team + Family Controls **distribution** entitlement | Real-device builds and App Store distribution. All four bundle ids carry the entitlement (`online.clockoff.app`, `.devicemonitor`, `.shieldconfig`, `.shieldaction`)                 | Request the distribution entitlement from Apple for each id; put `DEVELOPMENT_TEAM` in `apps/ios/Config/Signing.local.xcconfig`; see `docs/IOS_SETUP.md`                           |
| APNs auth key                                                       | Silent pushes that make phones re-sync immediately after policy/schedule/override changes. Without it, phones sync on launch, foreground, background refresh (~15 min) and reconnect | Set `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_P8_BASE64`, `APNS_BUNDLE_ID`, `APNS_ENVIRONMENT`; `ApnsPushProvider` is selected automatically                                            |
| Email delivery                                                      | Verification, password reset and invite emails go through Resend (`EMAIL_PROVIDER=resend`) from `noreply@clockoff.online`                                                            | Live: the domain is verified in Resend, its records are in the Cloudflare zone (`docs/DNS_RECORDS.md`), and `EMAIL_PROVIDER`, `EMAIL_FROM` and `RESEND_API_KEY` are set on Netlify |
| Planday (or other workforce provider)                               | Automatic schedule sync and clock-in activation                                                                                                                                      | All six providers are registered as Coming Soon; `docs/INTEGRATIONS.md` describes how to implement Planday against the `WorkforceProvider` interface                               |
| App Store Connect                                                   | TestFlight/App Store distribution                                                                                                                                                    | Not started; see Deployment → Manual steps                                                                                                                                         |

## Partial or deliberately limited

- **Multi-instance deployment:** the rate limiter and the realtime event bus are in-process. Running more than
  one web instance needs the Redis adapters (interfaces exist; selecting `redis` currently fails fast).
- **Content Security Policy** still allows inline scripts because Next.js injects inline bootstrap scripts.
  Nonce support is built in the middleware but not wired through the root layout.
- **Billing** shows plans and usage from `@clockoff/shared/plans`; upgrade/downgrade are disabled "Coming soon"
  and there is no payment processing (by design for the MVP). Plan limits are enforced for employees and
  locations.
- **Audit log retention** is enforced when reading (per plan); there is no purge job yet.
- **Deleting an organisation** has no endpoint; the Danger zone sends owners to support.
- **Invite history:** the employee page shows the latest invite only (there is no list endpoint).
- **Recurring shifts:** "this and future" cancel/delete applies to occurrences already materialised (the next
  8 weeks); later occurrences are created by the job from the series rule. An anchor whose local start fell in a
  spring-forward gap materialises later occurrences at the shifted time.
- **Bulk shift edits** are last-writer-wins per item; single-shift edits use optimistic concurrency.
- **Join rate limits** (10/hour per IP, 20/15 min per company code) are conservative; a whole team onboarding
  from one shop Wi-Fi can hit them. Tune `RATE_LIMITS.mobileJoin` before rollout.
- **`restrictionConfig.requireEmployeeAppSelection`** is enforced in the policy editor and onboarding copy, but
  the phone always requires the employee's own selection, so the flag does not change device behaviour.
- **iOS Background Modes** includes `processing`, which is not used yet; consider removing it before App Review.

## Deployment

Production runs on **Netlify** (site `clockoff`, free plan) with **Neon** Postgres in London and **Resend** for
email. DNS for `clockoff.online` is a **Cloudflare** zone (free plan) managed through the Cloudflare API, not
edited by hand. The domain is still registered at IONOS, and the IONOS mailbox is unchanged. Runbook:
`docs/DEPLOYMENT.md`. DNS records: `docs/DNS_RECORDS.md`. Why DNS moved: `docs/DECISIONS.md` D-020.

| Piece                                                           | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Netlify site, continuous deployment from GitHub `main`          | ✅ Live at `https://clockoff.netlify.app` and on the three custom hostnames below. Every push to `main` builds and publishes; CI (JS + iOS) runs on GitHub Actions.                                                                                                                                                                                                                                                                                                                                                                                       |
| Database (Neon, `eu-west-2`)                                    | ✅ All migrations applied; no seed in production; holds the owner's organisation since 2026-10-07. `/api/health` on the apex and app hosts reports `database: ok`, `migrations: up_to_date`.                                                                                                                                                                                                                                                                                                                                                              |
| DNS (Cloudflare zone, registrar IONOS)                          | ✅ Zone `active`; the `.online` registry delegates to `lola.ns.cloudflare.com` and `thaddeus.ns.cloudflare.com`. Managed through the Cloudflare API. 7 records added, all **DNS only** (not proxied): apex A `75.2.60.5`, `www` and `app` CNAMEs to `clockoff.netlify.app`, and the 4 Resend records. The 6 IONOS records (2 MX, apex SPF, `_dmarc`, `autodiscover`, `_domainconnect`) are preserved byte-identical; they were backed up first to `docs/dns-backup-20261006T205519Z.json`. MX and apex SPF still resolve unchanged from public resolvers. |
| `clockoff.online`, `www.clockoff.online`, `app.clockoff.online` | ✅ Live with valid TLS. One Let's Encrypt certificate covers all three (valid until 2027-01-04; Netlify renews it automatically while the records point at Netlify). The apex serves the marketing site (200); `www` 301 → apex; `app` serves the dashboard (`/` 307 → `/overview`, `/login` renders) and every `/api/*` route; `http://` 301 → `https://`. Cross-host routing works: apex `/login` and `/overview` 308 → app, app `/pricing` 308 → apex, apex `/api/mobile/v1/me` 404.                                                                   |
| Security headers, locked-down routes                            | ✅ CSP, HSTS (`max-age=63072000; includeSubDomains`), `X-Frame-Options: DENY`, `nosniff`, Referrer-Policy, Permissions-Policy, COOP and `x-request-id` on apex and app responses. `/api/dev/*` answers 404; `/api/jobs/tick` without the secret answers 401.                                                                                                                                                                                                                                                                                              |
| Mobile API errors                                               | ✅ Bad or unknown join requests on `app.clockoff.online` return structured 4xx JSON (`VALIDATION_ERROR` 400 with field details, `INVALID_COMPANY_CODE` 404, malformed JSON 400).                                                                                                                                                                                                                                                                                                                                                                          |
| Email (Resend, `noreply@clockoff.online`)                       | ✅ Domain verified by Resend (all four records). A test email to `support@clockoff.online` was delivered at 22:40 UTC. A throwaway manager registration received its verification email through the app, verified through the link and signed in; the account was then deleted and the database is empty again. SPF and bounces use the `send` subdomain; the apex SPF is untouched.                                                                                                                                                                      |
| Scheduled tick (`work-mode-tick`, every minute)                 | ✅ Succeeding once a minute since 21:01 UTC (3–5 s per run, because the database is across the Atlantic), with no errors. Before `app.clockoff.online` resolved, each run failed with a DNS-lookup error and Netlify retried it about 3 times; the tick is idempotent, so the retries were harmless.                                                                                                                                                                                                                                                      |
| iOS Release build                                               | ✅ Points at `https://app.clockoff.online/api/mobile/v1` (`verify-release.sh` enforces https and the path). Not distributed yet (see the manual steps).                                                                                                                                                                                                                                                                                                                                                                                                   |

### Mocked or limited in production

- **Push notifications** use the no-op provider until an APNs key is configured. Phones still re-sync on launch,
  foreground, background refresh (about every 15 minutes) and reconnect.
- **Workforce integrations** (Planday and the others) are all "Coming soon"; schedules are entered in the
  dashboard.
- **Billing** shows plans and usage only; there is no payment processing.
- **Functions run in the US** (Netlify free plan, `us-east-2`) while the database is in London, so every query
  crosses the Atlantic and employee data is processed in the US under Netlify's DPA. Remedy: Netlify Pro, then
  set the functions region to London (`eu-west-2`).
- **Realtime and rate limiting are per function instance.** Dashboard events raised on another instance arrive
  through the 30-second polling fallback, and rate limits are best effort. Remedy: the Redis adapters.
- **Free-tier quotas:** Resend's free plan sends 100 emails a day; Neon's free plan keeps a 6-hour restore window.

### Manual steps

DNS is no longer a manual step: record changes go through the Cloudflare API (back up the zone first).

Done since the previous update: the first owner account (`support@clockoff.online`) was registered and verified
on 2026-10-07, so production now holds the owner's organisation.

1. **Rotate the credentials that were pasted into chat**: the Netlify personal access token, the Neon API key,
   the Resend API key and the Cloudflare API token. Update `.env.deploy` with the new values. For the running
   app, create a Resend key with **sending access only**, restricted to `clockoff.online`, and set it as
   `RESEND_API_KEY` on Netlify (the full-access key was only needed to register the domain). Create the new
   Cloudflare token with the same scope (Zone → DNS → Edit on `clockoff.online` only), store it as
   `DNS_API_TOKEN` in `.env.deploy`, and revoke the old one; it is never set on Netlify. The deploy key and
   webhook do not need rotating.
2. **Apple Developer Program and the new identifiers.** The rename gave the app new bundle ids, so everything
   Apple-side is created under them (nothing under `com.workmode.*` carries over):
   - register the App IDs `online.clockoff.app`, `online.clockoff.app.devicemonitor`,
     `online.clockoff.app.shieldconfig` and `online.clockoff.app.shieldaction`;
   - register the App Group `group.online.clockoff.app.shared` and enable it, plus Family Controls, on all four;
   - request the **Family Controls (Distribution)** entitlement for all four ids;
   - create the provisioning profiles for them (Xcode automatic signing does this once the team is set), and set
     `DEVELOPMENT_TEAM` in `apps/ios/Config/Signing.local.xcconfig` (`docs/IOS_SETUP.md`).
3. **APNs auth key** (Apple Developer → Keys → enable Apple Push Notifications service). Set `APNS_KEY_ID`,
   `APNS_TEAM_ID`, `APNS_P8_BASE64` (base64 of the `.p8`), `APNS_BUNDLE_ID=online.clockoff.app` and
   `APNS_ENVIRONMENT=production` on Netlify, then redeploy. The app switches to real silent pushes
   automatically. Push notifications need this.
4. **App Store Connect and TestFlight**: create the app record for `online.clockoff.app` (name ClockOff), archive
   the Release scheme `ClockOffApp` with your signing team, upload it and add testers. Once the app is listed, set
   `NEXT_PUBLIC_APP_STORE_URL` on Netlify so invite instructions link to it (until then they link to the web app).
5. **Run the physical-device script** (Definition of Done items 7–10, above) on a real iPhone against
   production or a local server.
6. **Decide the ambiguous "Work Mode" lines** listed in `docs/RENAME_AUDIT.md` (Part 2). They were left as
   "Work Mode" on purpose; the most visible are on the iOS welcome, Screen Time and privacy screens.
7. **Optional: Netlify Pro** and move the functions region to London to remove the US-region limitation.
8. **Optional: DMARC reporting.** The `_dmarc` CNAME to IONOS (`v=DMARC1; p=none;`) already satisfies Resend.
   If you want aggregate reports, replace that CNAME with **one** TXT record, for example
   `v=DMARC1; p=none; rua=mailto:support@clockoff.online`, through the Cloudflare API after a backup. Never add a
   second `_dmarc` record. This is the owner's call and is not needed for sending.
9. **Optional: rename the GitHub repository** `FrxshCutt/workmode` and the local `~/workmode` folder. Neither is
   user-visible; GitHub redirects the old URL and the Netlify deploy key and webhook stay attached.

## Where to look next

- Decisions and assumptions: `docs/DECISIONS.md`
- How to run everything: `README.md`, `docs/LOCAL_DEVELOPMENT.md`
- Tests and how to add tenant-isolation cases: `docs/TESTING.md`, `docs/DEVELOPER_GUIDE.md`
