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
| `apps/web` unit tests                                | 771 passed                                                                                                   |
| `apps/web` integration tests (real Postgres)         | 351 passed, incl. 85-case tenant-isolation matrix and the Definition-of-Done journey                         |
| Playwright manager journey (`apps/web/e2e`)          | passes on a fresh `pnpm dev`                                                                                 |
| `pnpm build` (Next.js production build)              | succeeds                                                                                                     |
| iOS `make build` / `make test`                       | WorkModeCore 182, WorkModeScreenTime 4, app 129 passed (1 Keychain test skipped on unsigned simulator hosts) |
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

| What                                                                | Why it matters                                                                                                                                                                       | How to configure                                                                                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apple Developer team + Family Controls **distribution** entitlement | Real-device builds and App Store distribution. All four bundle ids carry the entitlement (`com.workmode.app`, `.devicemonitor`, `.shieldconfig`, `.shieldaction`)                    | Request the distribution entitlement from Apple for each id; put `DEVELOPMENT_TEAM` in `apps/ios/Config/Signing.local.xcconfig`; see `docs/IOS_SETUP.md` |
| APNs auth key                                                       | Silent pushes that make phones re-sync immediately after policy/schedule/override changes. Without it, phones sync on launch, foreground, background refresh (~15 min) and reconnect | Set `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_P8_BASE64`, `APNS_BUNDLE_ID`, `APNS_ENVIRONMENT`; `ApnsPushProvider` is selected automatically                  |
| Email delivery                                                      | Verification, password reset and invite emails go through Resend (`EMAIL_PROVIDER=resend`) from `noreply@clockoff.online`                                                            | Add the Resend DNS records in `docs/DNS_RECORDS.md` §3; Resend verifies the domain automatically                                                         |
| Planday (or other workforce provider)                               | Automatic schedule sync and clock-in activation                                                                                                                                      | All six providers are registered as Coming Soon; `docs/INTEGRATIONS.md` describes how to implement Planday against the `WorkforceProvider` interface     |
| App Store Connect                                                   | TestFlight/App Store distribution                                                                                                                                                    | Not started                                                                                                                                              |

## Partial or deliberately limited

- **Multi-instance deployment:** the rate limiter and the realtime event bus are in-process. Running more than
  one web instance needs the Redis adapters (interfaces exist; selecting `redis` currently fails fast).
- **Content Security Policy** still allows inline scripts because Next.js injects inline bootstrap scripts.
  Nonce support is built in the middleware but not wired through the root layout.
- **Billing** shows plans and usage from `@workmode/shared/plans`; upgrade/downgrade are disabled "Coming soon"
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

**Not deployed yet.** Target: Netlify (hosting) + Neon London (database) + IONOS DNS for `clockoff.online`
(`clockoff.online`/`www` → marketing, `app.clockoff.online` → dashboard + API). Runbook: `docs/DEPLOYMENT.md`.

Prepared and verified locally:

- `apps/web/netlify.toml` — the Netlify build ran end to end with Netlify's CLI: one server function (with
  Prisma's Lambda engine bundled), the Next.js middleware as an Edge Function (reads its routing variables at
  runtime), and the `work-mode-tick` Scheduled Function (every minute).
- Hostname routing (`HOST_ROUTING=on`), client IPs from Netlify's `x-nf-client-connection-ip`.
- `/api/health` reports database and migration status; the demo seed refuses production and remote databases.
- iOS Release build points at `https://app.clockoff.online/api/mobile/v1`.

Waiting on credentials in `.env.deploy`: Netlify token, Neon key (or connection strings), IONOS DNS key.

## Where to look next

- Decisions and assumptions: `docs/DECISIONS.md`
- How to run everything: `README.md`, `docs/LOCAL_DEVELOPMENT.md`
- Tests and how to add tenant-isolation cases: `docs/TESTING.md`, `docs/DEVELOPER_GUIDE.md`
