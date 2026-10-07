# iOS setup

The employee app lives in `apps/ios`: a SwiftUI app, three Screen Time app extensions and a local Swift
package, `ClockOffCore`, that holds everything that is not UI. The Xcode project is generated from
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
make generate        # ClockOff.xcodeproj from project.yml
make build           # Debug build of the app + 3 extensions for the iPhone 17 Pro simulator
make test            # ClockOffCore tests + the app's hosted tests on the simulator
make build-release   # Release build for the simulator, then product checks (see "Release safety")
```

All four run unsigned (`CODE_SIGNING_ALLOWED=NO`), so no Apple Developer account is needed. To use another
simulator, run `make test SIMULATOR="iPhone 16"`. Build output goes to `apps/ios/build/` (git-ignored).

To run the app, open `apps/ios/ClockOff.xcodeproj`, choose the **ClockOffApp** scheme and a simulator, and
press Run. Start the API first (`pnpm dev` at the repo root). The Debug build for the simulator talks to the
mobile API at `http://localhost:3000/api/mobile/v1`.

For a physical iPhone, see "Installing on an iPhone" (`make device-install`). For TestFlight, see
"TestFlight" (`make testflight`). The owner's on-device checklist is `docs/DEVICE_TESTING.md`.

## Targets

| Target                                        | Type                                                                       | Bundle id                           | Entitlements                                   | Role                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------ |
| `ClockOffApp`                                 | app                                                                        | `online.clockoff.app`               | Family Controls, App Groups, `aps-environment` | Onboarding, Home/Schedule/Settings, sync, owns the `RestrictionProvider` |
| `ClockOffDeviceActivityMonitor`               | app extension (`com.apple.deviceactivity.monitor-extension`)               | `online.clockoff.app.devicemonitor` | Family Controls, App Groups                    | Woken by iOS at shift and break boundaries, even when the app is closed  |
| `ClockOffShieldConfiguration`                 | app extension (`com.apple.ManagedSettingsUI.shield-configuration-service`) | `online.clockoff.app.shieldconfig`  | Family Controls, App Groups                    | Draws the screen shown over a blocked app                                |
| `ClockOffShieldAction`                        | app extension (`com.apple.ManagedSettings.shield-action-service`)          | `online.clockoff.app.shieldaction`  | Family Controls, App Groups                    | Handles taps on that screen's buttons                                    |
| `ClockOffAppTests`                            | unit tests, hosted by the app                                              | `online.clockoff.app.tests`         | none                                           | View models, sync, the mock provider                                     |
| `ClockOffCore` (SPM, `Packages/ClockOffCore`) | static library                                                             | none                                | none                                           | Models, API client, Keychain, App Group storage, engine, planner         |

The extensions link only `ClockOffCore`, which imports Foundation, `os` and Security, and never UIKit,
SwiftUI or the Screen Time frameworks. Extensions have tight memory limits. The shield configuration
extension also imports UIKit, because `ShieldConfiguration` takes `UIColor`s.

## Configuration (xcconfig)

| File                      | What it sets                                                                                                                                                                                                                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Config/Base.xcconfig`    | `MARKETING_VERSION` (`0.1.0`), `CURRENT_PROJECT_VERSION` (`1`; `make testflight` overrides it with a date-based build number), deployment target, Swift settings. Includes `Signing.xcconfig`.                                                                                                                         |
| `Config/Signing.xcconfig` | `DEVELOPMENT_TEAM = 78B9UY2V8C`, `CODE_SIGN_STYLE = Automatic`, bundle ids, `CLOCKOFF_APP_GROUP`. Optionally includes the git-ignored `Signing.local.xcconfig`.                                                                                                                                                        |
| `Config/Debug.xcconfig`   | `DEBUG`. Simulator: `DEBUG_MOCK_RESTRICTIONS` and `API_BASE_URL = http://localhost:3000/api/mobile/v1`. Physical iPhone (`[sdk=iphoneos*]`): no mock condition and `API_BASE_URL = https://app.clockoff.online/api/mobile/v1`. Local HTTP allowed, APNs sandbox. Optionally includes the git-ignored `Local.xcconfig`. |
| `Config/Release.xcconfig` | No compilation conditions, `API_BASE_URL = https://app.clockoff.online/api/mobile/v1` (the production mobile API), APNs production.                                                                                                                                                                                    |

Settings that matter:

| Setting                               | Debug, simulator                      | Debug, iPhone (`[sdk=iphoneos*]`)           | Release                                     | Used by                                                                                                       |
| ------------------------------------- | ------------------------------------- | ------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `SWIFT_ACTIVE_COMPILATION_CONDITIONS` | `DEBUG DEBUG_MOCK_RESTRICTIONS`       | `DEBUG`                                     | _(empty)_                                   | `#if DEBUG_MOCK_RESTRICTIONS` compiles `MockRestrictionProvider`; `#if DEBUG` compiles the Diagnostics screen |
| `API_BASE_URL`                        | `http://localhost:3000/api/mobile/v1` | `https://app.clockoff.online/api/mobile/v1` | `https://app.clockoff.online/api/mobile/v1` | Info.plist `API_BASE_URL` → `AppConfiguration.apiBaseURL` → `APIClientConfiguration.baseURL`                  |
| `CLOCKOFF_ALLOW_LOCAL_HTTP`           | `YES`                                 | `YES`                                       | `NO`                                        | A build phase adds `NSAllowsLocalNetworking` and `NSLocalNetworkUsageDescription`                             |
| `CLOCKOFF_PUSH_ENVIRONMENT`           | `sandbox`                             | `sandbox`                                   | `production`                                | Info.plist `ClockOffPushEnvironment`, sent with the push token                                                |

The mock condition is set through `CLOCKOFF_MOCK_RESTRICTIONS_CONDITION`, which `Debug.xcconfig` empties for
`[sdk=iphoneos*]`. A Debug build on a phone is therefore a real build: it talks to production, uses Apple's
Screen Time provider and shows no "DEVELOPMENT MODE" banner. It differs from Release in its optimisation and
in the Debug-only extras: the Diagnostics screen, local HTTP and the APNs sandbox.

`API_BASE_URL` is the **root of the mobile API**, not the server origin: the client appends endpoint paths
such as `/sync` to it (`Endpoint.url(apiRoot:)`, which keeps the root's path and puts exactly one `/` between
the two, with or without a trailing slash on the root) and adds no prefix of its own. A value whose path does
not end with `/api/mobile/v1` exactly once (a bare origin such as `http://localhost:3000`, a partial path such
as `…/api/mobile`, an empty `//` segment or a doubled `/api/mobile/v1`) is refused at launch
(`AppConfiguration.apiBaseURL(from:)`). Web pages such as Settings › Help are derived from it by dropping the
trailing `/api/mobile/v1` (`AppConfiguration.helpURL`).

In xcconfig, `//` starts a comment. URLs are therefore written as `http:/$()/host:port/api/mobile/v1`.

Per-developer overrides go in two git-ignored files, so nothing personal is committed:

```xcconfig
// apps/ios/Config/Signing.local.xcconfig — used by Debug AND Release; only to sign with another team
DEVELOPMENT_TEAM = ABCDE12345

// apps/ios/Config/Local.xcconfig — Debug only
API_BASE_URL[sdk=iphoneos*] = http:/$()/my-mac.local:3000/api/mobile/v1   // a phone against your Mac
CLOCKOFF_MOCK_RESTRICTIONS_CONDITION[sdk=iphoneos*] = DEBUG_MOCK_RESTRICTIONS   // force the mock on a phone
```

Keep the `[sdk=iphoneos*]` condition. `Local.xcconfig` is included last, so an unconditional value there
replaces the setting for the simulator as well. An unconditional `CLOCKOFF_MOCK_RESTRICTIONS_CONDITION =`
removes the mock from simulator builds and breaks `make test`.

## Capabilities

### App Group

`group.online.clockoff.app.shared` is on all four targets. It must match `AppGroup.identifier` in ClockOffCore,
`CLOCKOFF_APP_GROUP` and every `*.entitlements` file. The container holds:

| File                  | Writer       | Reader                        | Contents                                                                                                                                               |
| --------------------- | ------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ClockOff/state.json` | app, monitor | app, monitor                  | `CachedState`: organisation, employee, policy, break policy, shifts, versions, active break and overrides, sync timestamps, engine state, event outbox |
| `ClockOff/plans.json` | app          | monitor, shield configuration | `PlansFile`: DeviceActivity name → `{ shiftId, plan, activity, breakBehaviour }`, plus the employer name for the shield                                |

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
- **Distribution (TestFlight/App Store):** App Store profiles carry Family Controls only once Apple has
  approved the Family Controls (Distribution) entitlement for **each** of the four bundle ids
  (`online.clockoff.app`, `.devicemonitor`, `.shieldconfig`, `.shieldaction`). It is requested via Account ›
  Certificates, IDs & Profiles › the App ID › Additional Capabilities, or the Family Controls request form.
  Team `78B9UY2V8C` has it. On 2026-10-07 a local App Store export signed all four bundles with
  `com.apple.developer.family-controls` and the App Group, and the app with `aps-environment = production`.
- `NSFamilyControlsUsageDescription` in the app's Info.plist explains Screen Time access in plain words:
  blocking runs only during shifts, and the employer never sees which apps are chosen or how the phone is
  used.

### Push notifications

`aps-environment = development` is in the app's entitlements. With automatic signing, Xcode switches it to
`production` when an archive is exported for distribution. A Release build installed straight from Xcode
with a development profile still talks to the APNs sandbox while reporting `production`
(`CLOCKOFF_PUSH_ENVIRONMENT`); test pushes with Debug builds. The server sends **silent** pushes only (`content-available: 1`), which
mean "sync now". The app registers its token with `POST /api/mobile/v1/device/push-token`, sending
`environment: sandbox|production` from `CLOCKOFF_PUSH_ENVIRONMENT`.

### Background modes

The app's Info.plist declares `UIBackgroundModes = fetch, remote-notification, processing` and
`BGTaskSchedulerPermittedIdentifiers = [online.clockoff.app.refresh]`. `BackgroundRefresh` registers that
identifier at launch and requests a `BGAppRefreshTask` no earlier than 15 minutes ahead each time the app
goes to the background. iOS decides when a refresh actually runs. Shifts are enforced on time by
DeviceActivity schedules, not by background refresh.

## Signing

`Config/Signing.xcconfig` sets `DEVELOPMENT_TEAM = 78B9UY2V8C` (the team that owns the `online.clockoff.app`
App IDs, the App Group and the App Store Connect record) and `CODE_SIGN_STYLE = Automatic`. The simulator
targets (`make build`, `make test`, `make build-release`) still pass `CODE_SIGNING_ALLOWED=NO`, so they need
no account. Device builds, archives and exports sign automatically.

- Xcode needs an Apple ID with access to the team (Xcode › Settings › Accounts).
- Command-line builds pass `-allowProvisioningUpdates`, so `xcodebuild` may create the development
  certificate and profiles and register a new iPhone. It uses that Apple ID, or an App Store Connect API
  key (see "TestFlight").
- The four explicit App IDs (`online.clockoff.app`, `.devicemonitor`, `.shieldconfig`, `.shieldaction`)
  carry App Groups (`group.online.clockoff.app.shared`) and Family Controls; the app also carries Push
  Notifications.

To sign with a different team (for example a free personal team), set `DEVELOPMENT_TEAM` in the git-ignored
`apps/ios/Config/Signing.local.xcconfig`. A personal team needs globally unique bundle ids, so also override
all five `CLOCKOFF_*_BUNDLE_ID` values and `CLOCKOFF_APP_GROUP`. Keep the entitlements and
`AppGroup.identifier` in step with the group.

To check that the device-only code (the real provider path) compiles without signing anything:

```sh
cd apps/ios
xcodebuild -project ClockOff.xcodeproj -scheme ClockOffApp -configuration Debug -destination 'generic/platform=iOS' \
  -derivedDataPath build/DeviceCompileCheck CODE_SIGNING_ALLOWED=NO build
```

## Installing on an iPhone

The phone needs:

- iOS 16.4 or later.
- **Developer Mode** (Settings › Privacy & Security › Developer Mode, then restart).
- Pairing with the Mac: connect it by cable, unlock it and tap **Trust**.

The Debug build it gets uses production (`https://app.clockoff.online/api/mobile/v1`) and Apple's real
Screen Time provider, and includes the Diagnostics screen.

**Xcode:** open `ClockOff.xcodeproj`, choose the **ClockOffApp** scheme and the iPhone, and press Run. Stop
the run (⌘.) before testing Work Mode, and start ClockOff from the Home Screen. A debugger session keeps the
app alive, which hides what happens when it is closed.

**Command line:**

```sh
make -C apps/ios device-install
```

`Scripts/device-install.sh` does the following:

1. Picks the first paired physical iPhone from `xcrun devicectl list devices`.
2. Builds Debug for it with `xcodebuild -destination "platform=iOS,id=<udid>" -allowProvisioningUpdates`
   into `build/DeviceDerivedData`.
3. Prints the embedded extensions.
4. Installs the app with `xcrun devicectl device install app --device <id> <ClockOffApp.app>`.
5. Launches `online.clockoff.app` with `xcrun devicectl device process launch --terminate-existing`.

Run the same commands by hand to target a particular phone.

Install again after code changes. Every Debug build shows version `0.1.0 (1)`.

## Diagnostics screen (Debug builds only)

**Opening it:** Settings › Device › tap **App version** five times, each tap within 1.5 s of the last. This
pushes **Diagnostics**. It is reachable once onboarding is complete.

**What it shows**, refreshed every 2 seconds while visible, on foreground and when Screen Time access
changes:

| Section                  | Contents                                                                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Snapshot                 | Capture time, app version, time zone                                                                                                                                               |
| Screen Time access       | Family Controls status, the permission reported to the workplace, which provider is active                                                                                         |
| App selection            | Counts only, never names or tokens                                                                                                                                                 |
| Work Mode engine         | What the app shows, the engine state and the reason it computed it, the expected restriction, and what the shield stores read back as                                              |
| DeviceActivity schedules | `DeviceActivityCenter().activities` with `schedule(for:)` on a phone; the mock's list on the simulator                                                                             |
| plans.json               | Entries, and whether each is registered with iOS                                                                                                                                   |
| Shield stores            | Which sets are set, and their token counts, in the `.work` and `.breakRelaxed` ManagedSettings stores                                                                              |
| App Group                | Container, `state.json` timestamps, the extension-written engine state, the monitor extension's last callback, outbox length, offline breaks queued, the selection-incomplete flag |
| Sync                     | Last sync and error, policy and schedule versions, clock skew, last check-in, API host                                                                                             |

**Buttons:** "Force sync", "Re-plan schedules", "Clear all shields" (with a confirmation dialog) and "Copy
diagnostics to clipboard". The copied plain-text report holds counts, states, activity names and times only:
no app, category, organisation or employee names. Rows that need attention show an orange triangle, and
`[!]` in the copied text.

The exact labels, and how to read them during a test, are in `docs/DEVICE_TESTING.md`.

**Code:** `ClockOffApp/Features/Diagnostics/`.

- The screen and its view model.
- `DiagnosticsDataSource` with `LiveDiagnosticsDataSource`: reads the app's real objects.
- `DiagnosticsSnapshot`.
- `DiagnosticsReport`: the pure formatter shared by the screen and the copied text, unit-tested in
  `ClockOffAppTests/Features/DiagnosticsReportTests.swift`.
- `ClockOffApp/Restrictions/ScreenTimeDiagnostics.swift`: reads DeviceActivity and ManagedSettings, or the
  mock.

Every file, and the tap gesture in `SettingsView`, is inside `#if DEBUG`. `make build-release` fails if a
Release binary contains the screen (see "Release safety").

## TestFlight

```sh
make -C apps/ios testflight
```

`Scripts/testflight.sh` takes these steps:

1. **Archive.** Archives the Release configuration for `generic/platform=iOS` with
   `-allowProvisioningUpdates`, into `build/ClockOff-<build>.xcarchive`.
   - The marketing version comes from `MARKETING_VERSION` in `Config/Base.xcconfig` (`0.1.0`).
   - The build number is date-based: `YYYYMMDDHHMM` in UTC, passed as `CURRENT_PROJECT_VERSION`. Set
     `BUILD_NUMBER=…` to override it.
2. **Verify.** Runs `Scripts/verify-release.sh` on the archived app, so a TestFlight build gets the same
   checks as `make build-release`.
3. **Export and upload.** Runs `xcodebuild -exportArchive` with `apps/ios/ExportOptions.plist`:
   - `method` `app-store-connect`, `destination` `upload`, `teamID` `78B9UY2V8C`, automatic signing;
   - `manageAppVersionAndBuildNumber` `false`, so App Store Connect keeps the date-based number;
   - `uploadSymbols` `true`.

   The export output goes to `build/export-<build>`.

4. **Wait for processing.** Only when an API key was used: `node Scripts/asc-build-status.mjs … --wait`
   polls App Store Connect every 30 s until the build is `VALID`, `FAILED` or `INVALID`, for up to 45
   minutes. Without a key, check App Store Connect › ClockOff › TestFlight.

**Authentication**, in this order:

1. **An App Store Connect API key.** It is used when `ASC_API_KEY_ID`, `ASC_API_ISSUER_ID` and
   `ASC_API_KEY_PATH` are all set:
   - each value comes from the environment, else from the repo's git-ignored `.env.deploy`;
   - `ASC_API_KEY_PATH` is the `AuthKey_<id>.p8` file, kept outside the repo; `~` is expanded;
   - the file must exist.
2. **The Apple ID signed into Xcode** (Xcode › Settings › Accounts), when no key file is found.

The upload needs the App Store Connect app record for `online.clockoff.app`. After processing, add testers in
App Store Connect › TestFlight. TestFlight builds are Release builds: they enforce Work Mode exactly like a
Debug device build but have no Diagnostics screen.

## Regenerating the project

`project.yml` is the source of truth. Never edit `ClockOff.xcodeproj` by hand. After adding or removing
files, or changing targets, settings or Info.plist properties:

```sh
make -C apps/ios generate
```

XcodeGen rewrites the `Info.plist` and `*.entitlements` files from the `info:` and `entitlements:` sections
of `project.yml`. Change them there, not in the files. Commit the regenerated project with the change.

## Simulator vs. real device

Apple's Screen Time frameworks do not work in the simulator. To keep the simulator fully usable:

- **Debug builds for the simulator use `MockRestrictionProvider`.** It is compiled only under
  `DEBUG_MOCK_RESTRICTIONS`, which is set for Debug simulator builds and never for device or Release builds. It simulates authorisation (approve, deny or fail), app selection
  (counts only), applying and clearing shields, and DeviceActivity scheduling (it enforces Apple's 20-activity
  and 15-minute limits). It records everything for tests. While it is active, every screen shows a yellow
  banner: **"DEVELOPMENT MODE — restrictions are simulated"**. No app is really blocked.
- **Keychain in unsigned simulator builds.** An unsigned app has no keychain access group, so every
  Keychain call fails with `errSecMissingEntitlement` (-34018). Debug simulator builds use
  `SimulatorTokenStore`, which tries the Keychain first and, for that error only, keeps the token pair in
  a protected file in the app's own container. This store is compiled only for
  `DEBUG && targetEnvironment(simulator)`. Device builds and Release builds always use the Keychain.
- **App Group in unsigned builds.** If the container is unavailable, `AppGroupFileStore.live()` falls back
  to `Application Support/ClockOffShared` and logs an error. On a device, that log line means the App Group
  entitlement is misconfigured.
- Background tasks and APNs do not run in the simulator. To exercise them, use:
  - **Silent push:** `xcrun simctl push booted online.clockoff.app push.json`, where `push.json` is
    `{"aps":{"content-available":1}}`. This calls the sync hook.
  - **Background refresh:** pause in the debugger, then run
    `e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateLaunchForTaskWithIdentifier:@"online.clockoff.app.refresh"]`.

On a real device (iOS 16.4+), every build, Debug or Release, uses `AppleScreenTimeRestrictionProvider`. That provider performs real authorisation (`AuthorizationCenter.requestAuthorization(for: .individual)`),
persists the employee's `FamilyActivitySelection` on-device, applies `ManagedSettingsStore` shields, schedules
`DeviceActivity` intervals for upcoming shifts and breaks, and the DeviceActivityMonitor extension enforces them
even when the app is closed. The full design, Apple limits and the manual device test script are in
`docs/SCREEN_TIME_IMPLEMENTATION.md`.

## Pointing a device at a local API

The simulator shares the Mac's network, so the default `http://localhost:3000/api/mobile/v1` works there. A
Debug build on a phone talks to production by default. To point it at your Mac instead, it needs your Mac's
address:

1. Start the API so it is reachable on the LAN. `pnpm dev` prints a **Network** URL. The phone and the Mac
   must be on the same Wi-Fi.
2. In `apps/ios/Config/Local.xcconfig` (git-ignored, Debug only), use the Mac's Bonjour name (preferred) or
   its LAN IP, followed by the mobile API path `/api/mobile/v1`. Keep the `[sdk=iphoneos*]` condition so the
   simulator stays on `localhost`:

   ```xcconfig
   API_BASE_URL[sdk=iphoneos*] = http:/$()/my-mac.local:3000/api/mobile/v1
   // or: API_BASE_URL[sdk=iphoneos*] = http:/$()/192.168.1.20:3000/api/mobile/v1
   ```

   Find the Bonjour name with `scutil --get LocalHostName` and add `.local`. Without `/api/mobile/v1` the
   app stops at launch with `Info.plist API_BASE_URL is missing or invalid`.

3. Build and run the Debug configuration. Plain HTTP is allowed **in Debug only**: the "Debug-only local
   HTTP (ATS)" build phase adds `NSAppTransportSecurity › NSAllowsLocalNetworking`, which covers `.local`
   names, unqualified host names and local IP addresses. It also adds `NSLocalNetworkUsageDescription`. On
   the first request, iOS asks for local-network access; allow it. Release never gets either key, and
   `make build-release` fails if it does. If a raw IP is refused, use the `.local` name.

## Release safety

`make build-release` builds the Release configuration for the simulator, then runs
`Scripts/verify-release.sh`. `make testflight` runs the same script on the archived device app before it
uploads anything. The script fails if any of these is true:

- a target's Release build settings define `DEBUG` or `DEBUG_MOCK_RESTRICTIONS`
  (`SWIFT_ACTIVE_COMPILATION_CONDITIONS`, read with `xcodebuild -showBuildSettings`);
- a target's bundle id is not the one in the Targets table, or its entitlements lack the App Group or
  Family Controls;
- any executable or dylib in the Release app contains `MockRestrictionProvider`, `SimulatorTokenStore` or the
  "DEVELOPMENT MODE" banner text (all three are compiled only under Debug conditions, and this confirms it);
- any of them contains the Debug-only Diagnostics screen: its report title "ClockOff Diagnostics", the
  `DiagnosticsSnapshot` type or the `DiagnosticsUnlock` tap counter behind Settings › App version;
- the Release Info.plist contains `NSAllowsLocalNetworking` or `NSLocalNetworkUsageDescription`;
- `API_BASE_URL` is not `https://…`, or its path does not end with `/api/mobile/v1` exactly once (it must be
  the mobile API root, with no trailing slash, query, fragment or empty `//` segment; the script prints the
  value it checked);
- `ClockOffPushEnvironment` is not `production`;
- any of the three extensions is missing from `ClockOffApp.app/PlugIns`.

The mock is compiled only under `#if DEBUG_MOCK_RESTRICTIONS`, deliberately not also under
`targetEnvironment(simulator)`: `make build-release` builds Release _for the simulator_, and that build must
not contain the mock. A Release simulator build therefore uses `AppleScreenTimeRestrictionProvider`.

## Sessions, tokens and the event outbox

- **Keychain.** One generic-password item (`online.clockoff.app.auth`) holds the access + refresh pair with
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
| §8.3 protocol and value types                    | `Packages/ClockOffCore/Sources/ClockOffCore/Restrictions/RestrictionProvider.swift` (`RestrictionProvider`, `RestrictionPlan`, `BreakBehaviour`, `ActivityPlan`, `RestrictionEngineState`, `RestrictionAuthorizationStatus`, `SelectionCountsProviding`)                                                                      |
| Planning and reconciling                         | `Restrictions/ActivityPlanner.swift` (`ActivityPlanner`, `RestrictionReconciler`, `RestrictionAction`)                                                                                                                                                                                                                        |
| Engine (placeholder for the fixture-tested port) | `Engine/WorkModeEngine.swift` (`WorkModeEngineProtocol`, `WorkModeEngine`), `Engine/WorkModeEvents.swift`                                                                                                                                                                                                                     |
| App Group                                        | `Storage/AppGroup.swift`, `AppGroupFileStore.swift`, `StateCache.swift`, `EventOutbox.swift`, `PlansStore.swift`                                                                                                                                                                                                              |
| Networking                                       | `Networking/APIClient.swift`, `TokenRefresher.swift`, `MobileAPI.swift`, `Endpoint.swift`; `Security/TokenStore.swift` (`KeychainTokenStore`, `ResilientTokenStore`, `InMemoryTokenStore`)                                                                                                                                    |
| Release checks                                   | `Scripts/verify-release.sh` (run by `make build-release`)                                                                                                                                                                                                                                                                     |
| Apple provider                                   | `ClockOffApp/Restrictions/AppleScreenTimeRestrictionProvider.swift` (authorisation, `SelectionStore`, two `ManagedSettingsStore`s, `DeviceActivity` scheduling) — see `docs/SCREEN_TIME_IMPLEMENTATION.md`                                                                                                                    |
| App picker                                       | `ClockOffApp/Restrictions/ScreenTimeSelectionPicker.swift` (`FamilyActivityPicker` sheet, `SelectionConfiguring`) and onboarding screens 5–8 in `ClockOffApp/Features/Onboarding/ScreenTimeSetupViews.swift`                                                                                                                  |
| Extensions                                       | `ClockOffDeviceActivityMonitor/DeviceActivityMonitorExtension.swift` (delegates to `MonitorEventHandler` in Core: reads `plans.json`, applies/clears shields, records engine state, queues events); `ClockOffShieldConfiguration/…` (shield card from App Group strings); `ClockOffShieldAction/…` (close / open-status flag) |
| Diagnostics (Debug only)                         | `ClockOffApp/Features/Diagnostics/` (screen, `DiagnosticsDataSource`, `DiagnosticsSnapshot`, `DiagnosticsReport`), `ClockOffApp/Restrictions/ScreenTimeDiagnostics.swift`; opened from `SettingsView`                                                                                                                         |
| Sync                                             | `ClockOffApp/Sync/SyncCoordinator.swift`: replay queued offline breaks → `GET /sync` → cache diff → engine → `ActivityPlanner` → write `plans.json` → `provider.scheduleActivities` → reconcile shields → local notifications → `POST /events` → `POST /device/state`; see `docs/SYNC_AND_OFFLINE.md`                         |

## Troubleshooting

| Symptom                                                               | Fix                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `xcodegen: command not found`                                         | `brew install xcodegen`                                                                                                                                                                                                                                                         |
| `Unable to find a destination matching … iPhone 17 Pro`               | `xcrun simctl list devices available`, then `make test SIMULATOR="<name>"`                                                                                                                                                                                                      |
| Build error "Signing for … requires a development team"               | `DEVELOPMENT_TEAM` is empty: a `Signing.local.xcconfig` override blanked it. Remove the override (the team is `78B9UY2V8C` in `Signing.xcconfig`).                                                                                                                              |
| "No profiles for 'online.clockoff.app' were found" / "No Accounts"    | Sign in to Xcode with an Apple ID on team `78B9UY2V8C` (Xcode › Settings › Accounts), and build with `-allowProvisioningUpdates` (the `make` targets do).                                                                                                                       |
| `make device-install`: "No paired iPhone found"                       | Connect the phone, unlock it, tap Trust and turn on Developer Mode (Settings › Privacy & Security › Developer Mode, then restart). Check with `xcrun devicectl list devices`.                                                                                                   |
| Diagnostics doesn't open after five taps                              | It exists only in Debug builds (TestFlight and App Store builds are Release), the taps must each come within 1.5 s, and onboarding must be complete.                                                                                                                            |
| "Provisioning profile doesn't include the Family Controls capability" | Enable Family Controls on all four App IDs. For distribution, Apple must approve the entitlement for each bundle id.                                                                                                                                                            |
| `Info.plist API_BASE_URL is missing or invalid` crash at launch       | The xcconfig value is malformed, or its path does not end with `/api/mobile/v1` (e.g. a bare origin). It must be the mobile API root, e.g. `http:/$()/my-mac.local:3000/api/mobile/v1` (write `/$()/`, because `//` starts a comment).                                          |
| "Can't reach ClockOff" on a device                                    | The API is not reachable from the phone. With the default (production), check the phone's internet connection. With a `Local.xcconfig` override, check the Wi-Fi, the `.local` name, and that local-network access is allowed in Settings › Privacy & Security › Local Network. |
| Keychain error -34018                                                 | Expected in unsigned builds. The simulator uses `SimulatorTokenStore`. On a device it means the build is not signed.                                                                                                                                                            |
| `BGTaskScheduler refused online.clockoff.app.refresh` in the log      | The identifier is missing from `BGTaskSchedulerPermittedIdentifiers`. Regenerate with `make generate`.                                                                                                                                                                          |
| Yellow "DEVELOPMENT MODE" banner on a device                          | `Local.xcconfig` forces the mock on device builds (`CLOCKOFF_MOCK_RESTRICTIONS_CONDITION[sdk=iphoneos*] = DEBUG_MOCK_RESTRICTIONS`). Remove that line.                                                                                                                          |
| Tests fail to compile after changing the mock in `Local.xcconfig`     | The hosted tests use `MockRestrictionProvider` on the simulator. Remove an unconditional `CLOCKOFF_MOCK_RESTRICTIONS_CONDITION =` (keep overrides to `[sdk=iphoneos*]`).                                                                                                        |
| "Your sign-in can't be read right now" on Home                        | `CREDENTIALS_UNAVAILABLE`: the Keychain could not be read (usually right after a restart, before the first unlock). The phone stays joined; it clears on the next sync after unlocking.                                                                                         |
| Stale project after pulling                                           | `make generate`, then `make clean` if Xcode still shows removed files.                                                                                                                                                                                                          |
