# Status

_Last updated: 2026-10-07. This is the honest state of the MVP: what works and how it was verified, what is
partial, and what needs external credentials or hardware that were not available while building it._

## Summary

All 26 build stages are implemented. Every quality gate passes on the build machine:

| Gate                                                  | Result                                                                                                               |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck` · `pnpm lint` · `pnpm format:check`  | clean                                                                                                                |
| `packages/shared` unit tests                          | 1,930 passed                                                                                                         |
| `packages/validation` unit tests                      | 114 passed                                                                                                           |
| `packages/db` unit tests                              | 7 passed                                                                                                             |
| `apps/web` unit tests                                 | 860 passed                                                                                                           |
| `apps/web` integration tests (real Postgres)          | 364 passed, incl. 85-case tenant-isolation matrix and the Definition-of-Done journey                                 |
| Playwright manager journey (`apps/web/e2e`)           | passes on a fresh `pnpm dev`                                                                                         |
| `pnpm build` (Next.js production build)               | succeeds                                                                                                             |
| iOS `make build` / `make test`                        | ClockOffCore 195, ClockOffScreenTime 4, app 145 passed (1 Keychain test skipped on unsigned simulator hosts)         |
| iOS `make build-release`                              | succeeds with the real Apple provider; `Scripts/verify-release.sh` confirms no mock code or Diagnostics screen ships |
| iOS Debug build for a device (`generic/platform=iOS`) | succeeds (compiles the real Screen Time provider path and the Diagnostics screen)                                    |

Real Screen Time enforcement on a physical iPhone has **not been verified yet**. Apple's FamilyControls,
ManagedSettings and DeviceActivity only enforce on a device. Everything around them is built, compiled for
Release and covered by tests with the mock provider.

Signing works since 2026-10-07: a signed Debug build (production API, real provider) was installed and
launched on the owner's iPhone. The owner's checklist is `docs/DEVICE_TESTING.md` (see "On-device testing
and TestFlight" below). Definition of Done items 7–10 stay "device pending" until it has been run.

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

`docs/DEVICE_TESTING.md` is the owner's step-by-step checklist. It has ten steps, and each says what the
phone, the Diagnostics screen and the dashboard should show:

1. Fresh install and join ClockOff Test with `SCALE-0090`.
2. Approve Screen Time access.
3. Select apps and categories.
4. "Create test shift…", then Force sync, so the DeviceActivity appears.
5. With the app closed, the shield appears at the shift start.
6. A break relaxes the shields, and they return at the break end with the app closed.
7. The shields lift at the shift end.
8. The shields survive a reboot mid-shift.
9. Restrictions apply on schedule in Airplane Mode.
10. Revoking Screen Time access shows Action Required, and "Permissions missing" on the dashboard.

`docs/SCREEN_TIME_IMPLEMENTATION.md` §11 keeps the engineering version, which adds the `RELAX_CATEGORIES`
and manager-override cases.

## On-device testing and TestFlight

| Piece                | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signing              | ✅ `apps/ios/Config/Signing.xcconfig`: `DEVELOPMENT_TEAM = 78B9UY2V8C`, automatic signing. Development profiles exist for the four bundle ids. A local App Store export (2026-10-07) signed all four with Family Controls and the App Group, and the app with `aps-environment = production`, so the Family Controls distribution entitlement is in place.                                                                                                                                                                                                                                                                                                                                                                               |
| Device builds        | ✅ Debug builds for a physical iPhone (`[sdk=iphoneos*]` in `Config/Debug.xcconfig`) use `https://app.clockoff.online/api/mobile/v1` and Apple's real Screen Time provider, with no "simulated" banner. The simulator keeps `localhost` and the mock. Install with Xcode Run or `make -C apps/ios device-install` (`xcodebuild -allowProvisioningUpdates` + `xcrun devicectl`).                                                                                                                                                                                                                                                                                                                                                          |
| Owner's iPhone       | ✅ An iPhone17,3 on iOS 26.6.2, registered with the team (automatic signing created the Apple Development certificate and profiles). The current Debug build — production API, real Screen Time provider, Diagnostics screen, three extensions embedded — was installed on 2026-10-07 at 21:42 from commit `53c31a0` (`make -C apps/ios device-install`). The phone was locked, so iOS refused the automatic launch; open ClockOff from the Home Screen.                                                                                                                                                                                                                                                                                 |
| Diagnostics screen   | ✅ Debug builds only: Settings › tap "App version" five times. It shows the live Screen Time state, the selection counts, the engine state and its reason, the registered DeviceActivity schedules against `plans.json`, the shield stores, the App Group contents and the sync metadata. It has buttons to force a sync, re-plan, clear shields and copy a report (counts and states only). `verify-release.sh` fails if it reaches a Release binary.                                                                                                                                                                                                                                                                                   |
| Test organisation    | ✅ **ClockOff Test** in production: id `77340865-337d-4ab5-8a18-8f75bf5ab306`, company code **`SCALE-0090`**, location "Test site", employee "Zach Stephens", Work Policy "Standard Staff" (Social Media, Games, Entertainment) and Break Policy "Standard Break" (2 × 15 min `RELAX_ALL`, from the shift start, no gap), both defaults. It is owned by the owner account and created or found again by `apps/web/scripts/setup-test-organisation.ts` (idempotent).                                                                                                                                                                                                                                                                      |
| "Create test shift…" | ⏳ Built and tested (dashboard action on the employee and Schedule pages; `POST /api/test-tools/test-shift`: 15–480 minutes, starting 1–240 minutes from now, created through `createShift`, 30 per hour; only for organisations in `TEST_TOOLS_ORGANISATION_IDS`). `TEST_TOOLS_ORGANISATION_IDS=77340865-337d-4ab5-8a18-8f75bf5ab306` is set on the Netlify site, but the deploy of commit `7f8256f` was **skipped by Netlify: "account credit usage exceeded"** (the Free plan's monthly credits are used up), so production still runs `3ac25d4` and the button is not live yet. Until it is, create an ordinary shift on the Schedule page (starts ≥ 20 minutes from now, lasts ≥ 15 minutes).                                       |
| TestFlight           | ✅ Build **202610072043** (version 0.1.0) of commit `53c31a0` was archived, passed `verify-release.sh`, signed with the Apple Distribution certificate (Family Controls and production push in all four App Store profiles) and **uploaded on 2026-10-07 at 21:45 UTC**; App Store Connect answered "Uploaded package is processing". Processing status was not polled: the App Store Connect API key file (`AuthKey_7JXT9C365S.p8`) is not on the build Mac, so the upload used the Apple ID signed into Xcode. Pipeline: `make -C apps/ios testflight` (`Scripts/testflight.sh`, `ExportOptions.plist`, date-based build numbers; with the key at `ASC_API_KEY_PATH` it also waits for processing via `Scripts/asc-build-status.mjs`). |
| Device checklist     | ⏳ Not run yet: needs the owner and the phone (`docs/DEVICE_TESTING.md`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## Needs external credentials or accounts

| What                                                                | Why it matters                                                                                                                                                                       | How to configure                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Apple Developer team + Family Controls **distribution** entitlement | Real-device builds and App Store distribution. All four bundle ids carry the entitlement (`online.clockoff.app`, `.devicemonitor`, `.shieldconfig`, `.shieldaction`)                 | ✅ Team `78B9UY2V8C` in `apps/ios/Config/Signing.xcconfig`, automatic signing; device builds and an App Store export with Family Controls work (`docs/IOS_SETUP.md`)                                                                                                                       |
| APNs auth key                                                       | Silent pushes that make phones re-sync immediately after policy/schedule/override changes. Without it, phones sync on launch, foreground, background refresh (~15 min) and reconnect | Set `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_P8_BASE64`, `APNS_BUNDLE_ID`, `APNS_ENVIRONMENT`; `ApnsPushProvider` is selected automatically                                                                                                                                                    |
| Email delivery                                                      | Verification, password reset and invite emails go through Resend (`EMAIL_PROVIDER=resend`) from `noreply@clockoff.online`                                                            | Live: the domain is verified in Resend, its records are in the Cloudflare zone (`docs/DNS_RECORDS.md`), and `EMAIL_PROVIDER`, `EMAIL_FROM` and `RESEND_API_KEY` are set on Netlify                                                                                                         |
| Planday (or other workforce provider)                               | Automatic schedule sync and clock-in activation                                                                                                                                      | All six providers are registered as Coming Soon; `docs/INTEGRATIONS.md` describes how to implement Planday against the `WorkforceProvider` interface                                                                                                                                       |
| App Store Connect                                                   | TestFlight/App Store distribution                                                                                                                                                    | `make -C apps/ios testflight` is ready (`docs/IOS_SETUP.md` › "TestFlight"). It needs the app record for `online.clockoff.app` and testers. An App Store Connect API key (`ASC_API_KEY_*`) is optional and enables unattended uploads and processing status. See Deployment → Manual steps |

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
| iOS Release build                                               | ✅ Points at `https://app.clockoff.online/api/mobile/v1` (`verify-release.sh` enforces https and the path). TestFlight pipeline ready (`make testflight`); see "On-device testing and TestFlight".                                                                                                                                                                                                                                                                                                                                                        |

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
  through the dashboard's refresh of realtime-backed data every 30 seconds while connected, and rate limits are
  best effort. The server ends each realtime stream after 20 s with a `reconnect` control event (this site's
  streaming limit is 30 s in practice) and the dashboard reconnects silently. Remedy: the Redis adapters.
- **Free-tier quotas:** Resend's free plan sends 100 emails a day; Neon's free plan keeps a 6-hour restore window.

### Manual steps

DNS is no longer a manual step: record changes go through the Cloudflare API (back up the zone first).

Done since the previous update: the first owner account (`support@clockoff.online`) was registered and verified
on 2026-10-07, so production now holds the owner's organisation. On the same day everything else was renamed to
ClockOff (`docs/DECISIONS.md` D-022): the lines previously left as "Work Mode" because they were ambiguous, the
internal names, the local database names and the GitHub repository (now `FrxshCutt/clockoff`, checked out at
`~/clockoff`). "Work Mode" remains the name of the shift state until the owner decides otherwise.

**Sign in again once after that deploy:** the dashboard session cookie is now `clockoff_session`, so the old
session is no longer recognised. Nothing else is needed. Existing local checkouts follow
`docs/LOCAL_DEVELOPMENT.md` › "Upgrading an existing checkout".

1. **Rotate the credentials that were pasted into chat**: the Netlify personal access token, the Neon API key,
   the Resend API key and the Cloudflare API token. Update `.env.deploy` with the new values. For the running
   app, create a Resend key with **sending access only**, restricted to `clockoff.online`, and set it as
   `RESEND_API_KEY` on Netlify (the full-access key was only needed to register the domain). Create the new
   Cloudflare token with the same scope (Zone → DNS → Edit on `clockoff.online` only), store it as
   `DNS_API_TOKEN` in `.env.deploy`, and revoke the old one; it is never set on Netlify. The deploy key and
   webhook do not need rotating.
2. **Apple Developer Program and the new identifiers: done (2026-10-07).** Team `78B9UY2V8C` is set in
   `apps/ios/Config/Signing.xcconfig`. The four App IDs, the App Group and Family Controls are in place, and
   automatic signing produced development and App Store profiles. A signed Debug build runs on the owner's
   iPhone.
3. **APNs auth key** (Apple Developer → Keys → enable Apple Push Notifications service). Set `APNS_KEY_ID`,
   `APNS_TEAM_ID`, `APNS_P8_BASE64` (base64 of the `.p8`), `APNS_BUNDLE_ID=online.clockoff.app` and
   `APNS_ENVIRONMENT=production` on Netlify, then redeploy. The app switches to real silent pushes
   automatically. Push notifications need this.
4. **App Store Connect and TestFlight.**
   - Make sure the app record for `online.clockoff.app` (name ClockOff) exists.
   - Run `make -C apps/ios testflight`: it archives, verifies, signs and uploads, with the Apple ID in Xcode or
     an App Store Connect API key. An API key (`ASC_API_KEY_ID`, `ASC_API_ISSUER_ID` and `ASC_API_KEY_PATH`
     to a `.p8` outside the repo) lets the script wait for processing.
   - Add testers in TestFlight once the build is processed.
   - Once the app is listed, set `NEXT_PUBLIC_APP_STORE_URL` on Netlify so invite instructions link to it.
     Until then they link to the web app.
5. **Run the device checklist** (`docs/DEVICE_TESTING.md`; Definition of Done items 7–10) on the iPhone.
   - The current Debug build with the Diagnostics screen is already installed (reinstall any time with
     `make -C apps/ios device-install`).
   - "Create test shift…" goes live with the next successful Netlify deploy (the variable is already set);
     until then add the test shift on the Schedule page by hand.
   - Record the results in the checklist's table.
6. **Optional: Netlify Pro** and move the functions region to London to remove the US-region limitation.
7. **Optional: DMARC reporting.** The `_dmarc` CNAME to IONOS (`v=DMARC1; p=none;`) already satisfies Resend.
   If you want aggregate reports, replace that CNAME with **one** TXT record, for example
   `v=DMARC1; p=none; rua=mailto:support@clockoff.online`, through the Cloudflare API after a backup. Never add a
   second `_dmarc` record. This is the owner's call and is not needed for sending.

## Where to look next

- Decisions and assumptions: `docs/DECISIONS.md`
- How to run everything: `README.md`, `docs/LOCAL_DEVELOPMENT.md`
- iOS builds, signing, device installs and TestFlight: `docs/IOS_SETUP.md`; the on-device checklist:
  `docs/DEVICE_TESTING.md`
- Tests and how to add tenant-isolation cases: `docs/TESTING.md`, `docs/DEVELOPER_GUIDE.md`
