# iOS setup

The employee app lives in `apps/ios`: a SwiftUI app, three Screen Time app extensions and a local Swift
package, `WorkModeCore`, that holds everything that is not UI. The Xcode project is generated from
`apps/ios/project.yml` with [XcodeGen](https://github.com/yonaskolb/XcodeGen). Settings live in
`apps/ios/Config/*.xcconfig`.

| Requirement       | Version                                                                       |
| ----------------- | ----------------------------------------------------------------------------- |
| Xcode             | 26.x (Swift 6 toolchain, Swift 5 language mode, strict concurrency `minimal`) |
| XcodeGen          | 2.46 (`brew install xcodegen`)                                                |
| Deployment target | iOS 16.4                                                                      |

## Quick start (simulator)

```sh
cd apps/ios
make generate        # WorkMode.xcodeproj from project.yml
make build           # Debug build of the app + 3 extensions for the iPhone 17 Pro simulator
make test            # WorkModeCore tests + the app's hosted tests on the simulator
make build-release   # Release build for the simulator, then product checks (see "Release safety")
```

All four run unsigned (`CODE_SIGNING_ALLOWED=NO`), so no Apple Developer account is needed. To use another
simulator, run `make test SIMULATOR="iPhone 16"`. Build output goes to `apps/ios/build/` (git-ignored).

To run the app, open `apps/ios/WorkMode.xcodeproj`, choose the **WorkModeApp** scheme and a simulator, and
press Run. Start the API first (`pnpm dev` at the repo root). The Debug build talks to `http://localhost:3000`.

## Targets

| Target                                        | Type                                                                       | Bundle id                        | Entitlements                                   | Role                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------ |
| `WorkModeApp`                                 | app                                                                        | `com.workmode.app`               | Family Controls, App Groups, `aps-environment` | Onboarding, Home/Schedule/Settings, sync, owns the `RestrictionProvider` |
| `WorkModeDeviceActivityMonitor`               | app extension (`com.apple.deviceactivity.monitor-extension`)               | `com.workmode.app.devicemonitor` | Family Controls, App Groups                    | Woken by iOS at shift and break boundaries, even when the app is closed  |
| `WorkModeShieldConfiguration`                 | app extension (`com.apple.ManagedSettingsUI.shield-configuration-service`) | `com.workmode.app.shieldconfig`  | Family Controls, App Groups                    | Draws the screen shown over a blocked app                                |
| `WorkModeShieldAction`                        | app extension (`com.apple.ManagedSettings.shield-action-service`)          | `com.workmode.app.shieldaction`  | Family Controls, App Groups                    | Handles taps on that screen's buttons                                    |
| `WorkModeAppTests`                            | unit tests, hosted by the app                                              | `com.workmode.app.tests`         | none                                           | View models, sync, the mock provider                                     |
| `WorkModeCore` (SPM, `Packages/WorkModeCore`) | static library                                                             | none                             | none                                           | Models, API client, Keychain, App Group storage, engine, planner         |

The extensions link only `WorkModeCore`, which imports Foundation, `os` and Security, and never UIKit,
SwiftUI or the Screen Time frameworks. Extensions have tight memory limits. The shield configuration
extension also imports UIKit, because `ShieldConfiguration` takes `UIColor`s.

## Configuration (xcconfig)

| File                      | What it sets                                                                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Config/Base.xcconfig`    | Version numbers, deployment target, Swift settings. Includes `Signing.xcconfig`.                                                                           |
| `Config/Signing.xcconfig` | `DEVELOPMENT_TEAM` (blank), bundle ids, `WORKMODE_APP_GROUP`. Optionally includes the git-ignored `Signing.local.xcconfig`.                                |
| `Config/Debug.xcconfig`   | `DEBUG_MOCK_RESTRICTIONS`, `API_BASE_URL = http://localhost:3000`, local HTTP allowed, APNs sandbox. Optionally includes the git-ignored `Local.xcconfig`. |
| `Config/Release.xcconfig` | No compilation conditions, `API_BASE_URL = https://app.clockoff.online` (production; the mobile API lives under `/api/mobile/v1`), APNs production.        |

Settings that matter:

| Setting                               | Debug                           | Release                       | Used by                                                                           |
| ------------------------------------- | ------------------------------- | ----------------------------- | --------------------------------------------------------------------------------- |
| `SWIFT_ACTIVE_COMPILATION_CONDITIONS` | `DEBUG DEBUG_MOCK_RESTRICTIONS` | _(empty)_                     | `#if DEBUG_MOCK_RESTRICTIONS` compiles `MockRestrictionProvider`                  |
| `API_BASE_URL`                        | `http://localhost:3000`         | `https://app.clockoff.online` | Info.plist `API_BASE_URL` → `AppConfiguration.apiBaseURL`                         |
| `WORKMODE_ALLOW_LOCAL_HTTP`           | `YES`                           | `NO`                          | A build phase adds `NSAllowsLocalNetworking` and `NSLocalNetworkUsageDescription` |
| `WORKMODE_PUSH_ENVIRONMENT`           | `sandbox`                       | `production`                  | Info.plist `WorkModePushEnvironment`, sent with the push token                    |

In xcconfig, `//` starts a comment. URLs are therefore written as `http:/$()/host:port`.

Per-developer overrides go in two git-ignored files, so nothing personal is committed:

```xcconfig
// apps/ios/Config/Signing.local.xcconfig — used by Debug AND Release
DEVELOPMENT_TEAM = ABCDE12345

// apps/ios/Config/Local.xcconfig — Debug only
API_BASE_URL = http:/$()/my-mac.local:3000
WORKMODE_MOCK_RESTRICTIONS_CONDITION =      // use the real Screen Time provider in Debug on a device
```

## Capabilities

### App Group

`group.com.workmode.app.shared` is on all four targets. It must match `AppGroup.identifier` in WorkModeCore,
`WORKMODE_APP_GROUP` and every `*.entitlements` file. The container holds:

| File                  | Writer       | Reader                        | Contents                                                                                                                                               |
| --------------------- | ------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WorkMode/state.json` | app, monitor | app, monitor                  | `CachedState`: organisation, employee, policy, break policy, shifts, versions, active break and overrides, sync timestamps, engine state, event outbox |
| `WorkMode/plans.json` | app          | monitor, shield configuration | `PlansFile`: DeviceActivity name → `{ shiftId, plan, activity, breakBehaviour }`, plus the employer name for the shield                                |

Files are written atomically with `completeUntilFirstUserAuthentication` protection, so the monitor
extension can read them while the phone is locked after its first unlock. Writes go through
`NSFileCoordinator`. Tokens are never stored in the App Group. They live in the Keychain
(`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, so a backup restored to another phone never carries a
refresh token).

### Family Controls (Screen Time)

`com.apple.developer.family-controls` is on the app and on all three extensions (the DeviceActivity monitor
and both ManagedSettings shield extensions), so every bundle id that uses a Screen Time framework carries
it. `make build-release` fails if any of the four targets loses it.

- **Development:** Family Controls works on a real device with the development entitlement, which any team
  can use once the capability is enabled for each App ID.
- **Distribution (TestFlight/App Store):** request the Family Controls distribution entitlement from Apple
  for **each** of the four bundle ids (`com.workmode.app`, `.devicemonitor`, `.shieldconfig`,
  `.shieldaction`) via Account › Certificates, IDs & Profiles › the App ID › Additional Capabilities, or the
  Family Controls request form. Until Apple approves it, distribution builds cannot be signed with the
  entitlement.
- `NSFamilyControlsUsageDescription` in the app's Info.plist explains Screen Time access in plain words:
  blocking runs only during shifts, and the employer never sees which apps are chosen or how the phone is
  used.

### Push notifications

`aps-environment = development` is in the app's entitlements. With automatic signing, Xcode switches it to
`production` when an archive is exported for distribution. A Release build installed straight from Xcode
with a development profile still talks to the APNs sandbox while reporting `production`
(`WORKMODE_PUSH_ENVIRONMENT`); test pushes with Debug builds. The server sends **silent** pushes only (`content-available: 1`), which
mean "sync now". The app registers its token with `POST /api/mobile/v1/device/push-token`, sending
`environment: sandbox|production` from `WORKMODE_PUSH_ENVIRONMENT`.

### Background modes

The app's Info.plist declares `UIBackgroundModes = fetch, remote-notification, processing` and
`BGTaskSchedulerPermittedIdentifiers = [com.workmode.app.refresh]`. `BackgroundRefresh` registers that
identifier at launch and requests a `BGAppRefreshTask` no earlier than 15 minutes ahead each time the app
goes to the background. iOS decides when a refresh actually runs. Shifts are enforced on time by
DeviceActivity schedules, not by background refresh.

## Signing

No signing identity exists on the build machine, so `DEVELOPMENT_TEAM` is blank and every `make` target
builds unsigned. To sign for a device:

1. In the Apple Developer portal, register four explicit App IDs: `com.workmode.app`,
   `com.workmode.app.devicemonitor`, `com.workmode.app.shieldconfig` and `com.workmode.app.shieldaction`.
2. Create the App Group `group.com.workmode.app.shared`. Enable **App Groups** on all four App IDs and
   assign the group.
3. Enable **Family Controls** on all four App IDs, and **Push Notifications** on the app.
4. Put your Team ID in `apps/ios/Config/Signing.local.xcconfig` (`DEVELOPMENT_TEAM = …`).
5. Run `make generate` (only needed after editing `project.yml`), open the project and run on your device.
   Signing is automatic.

With a free personal team, bundle ids must be globally unique. Override all five `WORKMODE_*_BUNDLE_ID`
values in `Signing.local.xcconfig`, plus `WORKMODE_APP_GROUP`. Keep the entitlements and
`AppGroup.identifier` in step with the group.

## Regenerating the project

`project.yml` is the source of truth. Never edit `WorkMode.xcodeproj` by hand. After adding or removing
files, or changing targets, settings or Info.plist properties:

```sh
make -C apps/ios generate
```

XcodeGen rewrites the `Info.plist` and `*.entitlements` files from the `info:` and `entitlements:` sections
of `project.yml`. Change them there, not in the files. Commit the regenerated project with the change.

## Simulator vs. real device

Apple's Screen Time frameworks do not work in the simulator. To keep the simulator fully usable:

- **Debug builds use `MockRestrictionProvider`.** It is compiled only under `DEBUG_MOCK_RESTRICTIONS`, which
  is set in Debug and never in Release. It simulates authorisation (approve, deny or fail), app selection
  (counts only), applying and clearing shields, and DeviceActivity scheduling (it enforces Apple's 20-activity
  and 15-minute limits). It records everything for tests. While it is active, every screen shows a yellow
  banner: **"DEVELOPMENT MODE — restrictions are simulated"**. No app is really blocked.
- **Keychain in unsigned simulator builds.** An unsigned app has no keychain access group, so every
  Keychain call fails with `errSecMissingEntitlement` (-34018). Debug simulator builds use
  `SimulatorTokenStore`, which tries the Keychain first and, for that error only, keeps the token pair in
  a protected file in the app's own container. This store is compiled only for
  `DEBUG && targetEnvironment(simulator)`. Device builds and Release builds always use the Keychain.
- **App Group in unsigned builds.** If the container is unavailable, `AppGroupFileStore.live()` falls back
  to `Application Support/WorkModeShared` and logs an error. On a device, that log line means the App Group
  entitlement is misconfigured.
- Background tasks and APNs do not run in the simulator. To exercise them, use:
  - **Silent push:** `xcrun simctl push booted com.workmode.app push.json`, where `push.json` is
    `{"aps":{"content-available":1}}`. This calls the sync hook.
  - **Background refresh:** pause in the debugger, then run
    `e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateLaunchForTaskWithIdentifier:@"com.workmode.app.refresh"]`.

On a real device (iOS 16.4+), a Release build or a Debug build with the mock condition switched off uses
`AppleScreenTimeRestrictionProvider`. That provider performs real authorisation (`AuthorizationCenter.requestAuthorization(for: .individual)`),
persists the employee's `FamilyActivitySelection` on-device, applies `ManagedSettingsStore` shields, schedules
`DeviceActivity` intervals for upcoming shifts and breaks, and the DeviceActivityMonitor extension enforces them
even when the app is closed. The full design, Apple limits and the manual device test script are in
`docs/SCREEN_TIME_IMPLEMENTATION.md`.

## Pointing a device at a local API

The simulator shares the Mac's network, so `http://localhost:3000` works there. A phone needs your Mac's
address:

1. Start the API so it is reachable on the LAN. `pnpm dev` prints a **Network** URL. The phone and the Mac
   must be on the same Wi-Fi.
2. In `apps/ios/Config/Local.xcconfig` (git-ignored, Debug only), use the Mac's Bonjour name (preferred) or
   its LAN IP:

   ```xcconfig
   API_BASE_URL = http:/$()/my-mac.local:3000
   // or: API_BASE_URL = http:/$()/192.168.1.20:3000
   ```

   Find the Bonjour name with `scutil --get LocalHostName` and add `.local`.

3. Build and run the Debug configuration. Plain HTTP is allowed **in Debug only**: the "Debug-only local
   HTTP (ATS)" build phase adds `NSAppTransportSecurity › NSAllowsLocalNetworking`, which covers `.local`
   names, unqualified host names and local IP addresses. It also adds `NSLocalNetworkUsageDescription`. On
   the first request, iOS asks for local-network access; allow it. Release never gets either key, and
   `make build-release` fails if it does. If a raw IP is refused, use the `.local` name.

## Release safety

`make build-release` builds the Release configuration for the simulator, then runs
`Scripts/verify-release.sh`, which fails if any of these is true:

- a target's Release build settings define `DEBUG` or `DEBUG_MOCK_RESTRICTIONS`
  (`SWIFT_ACTIVE_COMPILATION_CONDITIONS`, read with `xcodebuild -showBuildSettings`);
- a target's bundle id is not the one in the Targets table, or its entitlements lack the App Group or
  Family Controls;
- any executable or dylib in the Release app contains `MockRestrictionProvider`, `SimulatorTokenStore` or the
  "DEVELOPMENT MODE" banner text (all three are compiled only under Debug conditions, and this confirms it);
- the Release Info.plist contains `NSAllowsLocalNetworking` or `NSLocalNetworkUsageDescription`;
- `API_BASE_URL` is not `https://…`, or `WorkModePushEnvironment` is not `production`;
- any of the three extensions is missing from `WorkModeApp.app/PlugIns`.

The mock is compiled only under `#if DEBUG_MOCK_RESTRICTIONS`, deliberately not also under
`targetEnvironment(simulator)`: `make build-release` builds Release _for the simulator_, and that build must
not contain the mock. A Release simulator build therefore uses `AppleScreenTimeRestrictionProvider`.

## Sessions, tokens and the event outbox

- **Keychain.** One generic-password item (`com.workmode.app.auth`) holds the access + refresh pair with
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: readable by background work after the first unlock,
  never synced to iCloud and never restored to another phone.
- **Single-flight refresh.** `TokenRefresher` (an actor) lets exactly one `POST /auth/refresh` run however
  many requests hit a 401 at once; the others await its result, and a request whose rejected token is
  already outdated simply retries with the stored one. Refresh is never retried automatically: refresh tokens
  are single-use and the server revokes the whole family on reuse (`TOKEN_REUSED`).
- **No lost rotations.** The production token store is `ResilientTokenStore` wrapping the Keychain store: if
  the Keychain refuses a freshly rotated pair, the pair is kept in memory and the save retried on every
  access, instead of falling back to the rotated-out refresh token (which the server would treat as reuse).
- **Unreadable ≠ signed out.** A Keychain read failure (locked before first unlock, a broken item) is
  `CREDENTIALS_UNAVAILABLE`, not an authentication failure: the phone stays joined, keeps enforcing from its
  cached schedule and keeps its queued events. Only a server refusal (`TOKEN_REUSED`, `TOKEN_EXPIRED`,
  `INVALID_TOKEN`, `DEVICE_INACTIVE`, a second `UNAUTHENTICATED`) or missing tokens end the session, which
  lifts restrictions, wipes the cache and returns to Welcome.
- **Outbox.** Events are queued in `state.json` and de-duplicated by `clientEventId` (case-insensitive; the
  server is idempotent on it too). One-off onboarding events (`PERMISSION_GRANTED`, `SELECTION_CONFIGURED`,
  `SETUP_COMPLETED`) are not queued again while one of the same type is waiting, so retrying a step offline
  does not create duplicates. Batches of up to 200 are removed only after `POST /events` succeeds; network
  errors, 5xx, 401 and 429 keep them queued. A batch the server refuses outright (400 / 413 / 415 / 422, e.g.
  `VALIDATION_ERROR`) is dropped and logged, so one malformed event can never block every later event. The
  queue is capped at 500 events (oldest dropped first).

## Code map and seams for the Screen Time stage

| Area                                             | File(s)                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §8.3 protocol and value types                    | `Packages/WorkModeCore/Sources/WorkModeCore/Restrictions/RestrictionProvider.swift` (`RestrictionProvider`, `RestrictionPlan`, `BreakBehaviour`, `ActivityPlan`, `RestrictionEngineState`, `RestrictionAuthorizationStatus`, `SelectionCountsProviding`)                                                                      |
| Planning and reconciling                         | `Restrictions/ActivityPlanner.swift` (`ActivityPlanner`, `RestrictionReconciler`, `RestrictionAction`)                                                                                                                                                                                                                        |
| Engine (placeholder for the fixture-tested port) | `Engine/WorkModeEngine.swift` (`WorkModeEngineProtocol`, `WorkModeEngine`), `Engine/WorkModeEvents.swift`                                                                                                                                                                                                                     |
| App Group                                        | `Storage/AppGroup.swift`, `AppGroupFileStore.swift`, `StateCache.swift`, `EventOutbox.swift`, `PlansStore.swift`                                                                                                                                                                                                              |
| Networking                                       | `Networking/APIClient.swift`, `TokenRefresher.swift`, `MobileAPI.swift`, `Endpoint.swift`; `Security/TokenStore.swift` (`KeychainTokenStore`, `ResilientTokenStore`, `InMemoryTokenStore`)                                                                                                                                    |
| Release checks                                   | `Scripts/verify-release.sh` (run by `make build-release`)                                                                                                                                                                                                                                                                     |
| Apple provider                                   | `WorkModeApp/Restrictions/AppleScreenTimeRestrictionProvider.swift` (authorisation, `SelectionStore`, two `ManagedSettingsStore`s, `DeviceActivity` scheduling) — see `docs/SCREEN_TIME_IMPLEMENTATION.md`                                                                                                                    |
| App picker                                       | `WorkModeApp/Restrictions/ScreenTimeSelectionPicker.swift` (`FamilyActivityPicker` sheet, `SelectionConfiguring`) and onboarding screens 5–8 in `WorkModeApp/Features/Onboarding/ScreenTimeSetupViews.swift`                                                                                                                  |
| Extensions                                       | `WorkModeDeviceActivityMonitor/DeviceActivityMonitorExtension.swift` (delegates to `MonitorEventHandler` in Core: reads `plans.json`, applies/clears shields, records engine state, queues events); `WorkModeShieldConfiguration/…` (shield card from App Group strings); `WorkModeShieldAction/…` (close / open-status flag) |
| Sync                                             | `WorkModeApp/Sync/SyncCoordinator.swift`: replay queued offline breaks → `GET /sync` → cache diff → engine → `ActivityPlanner` → write `plans.json` → `provider.scheduleActivities` → reconcile shields → local notifications → `POST /events` → `POST /device/state`; see `docs/SYNC_AND_OFFLINE.md`                         |

## Troubleshooting

| Symptom                                                               | Fix                                                                                                                                                                                       |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `xcodegen: command not found`                                         | `brew install xcodegen`                                                                                                                                                                   |
| `Unable to find a destination matching … iPhone 17 Pro`               | `xcrun simctl list devices available`, then `make test SIMULATOR="<name>"`                                                                                                                |
| Build error "Signing for … requires a development team"               | You built without `CODE_SIGNING_ALLOWED=NO` (for example from Xcode, for a device). Set `DEVELOPMENT_TEAM` in `Config/Signing.local.xcconfig`.                                            |
| "Provisioning profile doesn't include the Family Controls capability" | Enable Family Controls on all four App IDs. For distribution, Apple must approve the entitlement for each bundle id.                                                                      |
| `Info.plist API_BASE_URL is missing or invalid` crash at launch       | The xcconfig value is malformed. Remember `http:/$()/host`, because `//` starts a comment.                                                                                                |
| "Can't reach Work Mode" on a device                                   | The API is not reachable from the phone: check the Wi-Fi, the `.local` name, `Local.xcconfig`, and that local-network access is allowed in Settings › Privacy & Security › Local Network. |
| Keychain error -34018                                                 | Expected in unsigned builds. The simulator uses `SimulatorTokenStore`. On a device it means the build is not signed.                                                                      |
| `BGTaskScheduler refused com.workmode.app.refresh` in the log         | The identifier is missing from `BGTaskSchedulerPermittedIdentifiers`. Regenerate with `make generate`.                                                                                    |
| Yellow "DEVELOPMENT MODE" banner on a device                          | You are running Debug with the mock. Set `WORKMODE_MOCK_RESTRICTIONS_CONDITION =` in `Local.xcconfig`, or run Release.                                                                    |
| Tests fail to compile after disabling the mock in `Local.xcconfig`    | The hosted tests use `MockRestrictionProvider`. Remove the override before running `make test`.                                                                                           |
| "Your sign-in can't be read right now" on Home                        | `CREDENTIALS_UNAVAILABLE`: the Keychain could not be read (usually right after a restart, before the first unlock). The phone stays joined; it clears on the next sync after unlocking.   |
| Stale project after pulling                                           | `make generate`, then `make clean` if Xcode still shows removed files.                                                                                                                    |
