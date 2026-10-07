# Device testing (iPhone)

A step-by-step checklist for proving Work Mode on a real iPhone. Run it with a **Debug** build on the phone,
the production dashboard and the **ClockOff Test** organisation. Each step says what to do, what the phone
should show, what to check on the Diagnostics screen (with its exact labels) and what the manager dashboard
should show.

The Diagnostics screen exists so you can tell **"Work Mode failed"** (no shield when there should be one)
apart from **"Work Mode worked but the app shows the wrong thing"**. The shield on a blocked app is the
ground truth. Diagnostics then shows which part of ClockOff put it there, and when.

Allow about three hours, most of it waiting for shifts to start and end. Steps 4–7 share one test shift.
Steps 8 and 9 each need a new one.

## Before you start

| What                 | Value                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dashboard            | `https://app.clockoff.online`, signed in as the owner. Use the organisation switcher in the top bar to choose **ClockOff Test**.                       |
| Organisation         | ClockOff Test (id `77340865-337d-4ab5-8a18-8f75bf5ab306`, time zone Europe/London)                                                                     |
| Company code         | `SCALE-0090`                                                                                                                                           |
| Location             | Test site                                                                                                                                              |
| Employee             | Zach Stephens                                                                                                                                          |
| Work Policy          | Standard Staff (default): Social Media, Games, Entertainment. Shield message "Work Mode is on. This app will be available again after your shift."     |
| Break Policy         | Standard Break (default): 2 breaks of 15 minutes, 30 minutes in total, `RELAX_ALL` (every app opens), allowed from the start of a shift, no gap needed |
| "Create test shift…" | Shown only for organisations listed in `TEST_TOOLS_ORGANISATION_IDS` on the Netlify site (`docs/ENVIRONMENT.md`)                                       |

On the phone:

- iOS 16.4 or later, **Developer Mode** on (Settings › Privacy & Security › Developer Mode, then restart).
- Settings › General › Date & Time › **Set Automatically** on. DeviceActivity runs on the phone's clock.
- At least one installed app in a blocked category, such as Instagram. You also need one app outside those
  categories (Maps, Calculator) to confirm it stays usable.
- A Debug build that includes the Diagnostics screen (next section). TestFlight and App Store builds are
  Release builds. They enforce Work Mode the same way but have **no Diagnostics screen**.

Two rules for every step that says "close the app":

- **Close ClockOff completely:** swipe up from the bottom and pause to open the App Switcher, then swipe
  ClockOff up and off the screen. While
  ClockOff is open it switches shields itself at each boundary. Only with it closed do you test the
  DeviceActivity monitor extension, which is what enforces Work Mode on a real employee's phone.
- **Don't leave it attached to Xcode.** After installing from Xcode, stop the run (⌘.) and start ClockOff
  from the Home Screen. A debugger session keeps the app alive.

There are no push notifications yet: no APNs key is configured on the server. The phone learns about a new
shift only when it syncs: on launch, on returning to the foreground, on pull to refresh, Settings › "Sync
now", Diagnostics › "Force sync", or a background refresh (iOS decides when). The dashboard learns what the
phone did only when the phone next syncs.

## Install a development build

Debug builds for a physical iPhone use the production API (`https://app.clockoff.online/api/mobile/v1`)
and Apple's real Screen Time provider. They show no yellow "DEVELOPMENT MODE" banner and contain the
Diagnostics screen. Signing is automatic for team `78B9UY2V8C`. Xcode needs an Apple ID with access to that
team (Xcode › Settings › Accounts). Details are in `docs/IOS_SETUP.md` › "Installing on an iPhone".

**From Xcode:** connect and unlock the iPhone, and tap **Trust** if asked. Open `apps/ios/ClockOff.xcodeproj`,
choose the **ClockOffApp** scheme and your iPhone as the destination, and press Run (⌘R). Then stop the run
(⌘.) and open ClockOff from the Home Screen.

**From the command line:**

```sh
make -C apps/ios device-install
```

This builds Debug for the first paired iPhone (`xcodebuild … -allowProvisioningUpdates`), then installs and
launches it (`xcrun devicectl device install app` and `xcrun devicectl device process launch`). The script
is `apps/ios/Scripts/device-install.sh`. If it says "No paired iPhone found", plug the phone in, unlock it,
tap Trust and check Developer Mode.

Install again after every code change. The app version row reads `0.1.0 (1)` for every Debug build, so it
does not tell builds apart. The Diagnostics screen itself confirms the build is new enough.

## Open the Diagnostics screen

1. Finish onboarding. The screen sits behind the tab bar, so it can't be opened during setup.
2. Open the **Settings** tab and scroll to the **Device** section.
3. Tap **App version** five times quickly, each tap within 1.5 seconds of the last.
4. The **Diagnostics** screen opens.

Release builds (TestFlight, App Store) do not respond to the taps. The screen is compiled only into Debug
builds, and `make build-release` fails if it ever reaches a Release binary.

The screen updates every 2 seconds while it is open. It also updates when ClockOff returns to the
foreground and when Screen Time access changes. Rows that need attention show an **orange warning
triangle**. Times look like `2026-10-07 21:05:33 +01:00 (3 min ago)`. Schedule windows look like
`2026-10-07 10:20 → 10:50 +01:00 · starts in 12 min`.

**Actions** (footer: "Debug builds only. Updates every 2 seconds. Counts and states only: no app or category
names."):

| Button                          | What it does                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Force sync"                    | A full sync and reconcile. Shows "Sync finished at …" or "Sync failed at …: CODE — message".                                                                                                                                                                                                                      |
| "Re-plan schedules"             | Rewrites `plans.json` and registers every DeviceActivity again. Shows "Re-planned: plans.json rewritten with N entries and DeviceActivity schedules registered again." or "Nothing re-planned: …" when the phone isn't joined or access isn't approved.                                                           |
| "Clear all shields"             | Asks first ("Clear all shields?"). Removes every ClockOff shield now. If a shift is in progress, Work Mode puts them back at its next check (app foreground, sync or a schedule boundary). Use it to recover, not during a test.                                                                                  |
| "Copy diagnostics to clipboard" | Copies a plain-text report that starts with "ClockOff Diagnostics": `== Section ==` headings, one `Label: value` line per row, and `[!]` after rows that need attention. It contains counts, states, activity names and times only: no app, category, organisation or employee names. Paste it into a bug report. |

**Sections and the rows that matter most:**

| Section                  | Rows                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Snapshot                 | Updated · App version · Time zone                                                                                                                                                                                                                                                                                        |
| Screen Time access       | **Family Controls** ("Approved" / "Denied" / "Not determined") · **Reported to workplace** (`APPROVED` / `DENIED` / `REVOKED` / `NOT_DETERMINED`) · **Restriction provider** (must be "Apple Screen Time" on a phone)                                                                                                    |
| App selection            | Selection saved · Apps · Categories · Web domains (counts) · Kept blocked on breaks ("Not needed by the break policy" for ClockOff Test)                                                                                                                                                                                 |
| Work Mode engine         | **Shown in the app** (what Home shows) · **Engine state** · **Reason** · Effective restriction · **Restrictions should be active** · Next change · **Shield stores read back as** (orange when it disagrees: shields missing during a shift, or shields up when none should be) · Last reconcile · Last reconcile result |
| DeviceActivity schedules | **Registered with iOS** ("None" / "N activities"), then one row per activity named `shift-<shift id>-v<n>` or `break-<break id>` with its window and "warning 15 min" (orange "· not in plans.json" if iOS has an activity ClockOff didn't plan) · Re-registration pending                                               |
| plans.json               | File modified · Generated at · Entries, then one row per entry: "shift" or "break", its window, and "· not registered with iOS" (orange) when iOS lacks it                                                                                                                                                               |
| Shield stores            | Source ("ManagedSettings (live)") · **Work store (.work)** ("Shielding" / "Empty") · Work store sets · **Break store (.breakRelaxed)** · Break store sets. A sets row reads like `applications 1 · applicationCategories specific(3) · webDomains 0 · webDomainCategories specific(3)` (`nil` = not set)                 |
| App Group                | **Container** (must be "Shared App Group") · state.json modified · Engine state in state.json · **Last extension callback** ("kind · activity · time · outcome", or "None yet") · Outbox · Offline breaks queued · Selection incomplete flag                                                                             |
| Sync                     | Last sync · Server last reached · Last sync error · Policy version · Schedule version · Clock skew · Last check-in · **API host** (must be `app.clockoff.online`)                                                                                                                                                        |

**Last extension callback** is the key row. It is written by the DeviceActivity monitor extension, which
iOS wakes at shift and break boundaries even with ClockOff closed. Its time shows whether the extension ran
at the boundary, and its outcome says what it did:

| Outcome                                            | Meaning                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `flagged starting soon`                            | `intervalWillStartWarning`, 15 minutes before a shift                                       |
| `applied work shields for shift <id>`              | `intervalDidStart` of a shift: shields applied                                              |
| `break expired: work shields restored`             | `intervalDidEnd` of a break that ran its full length                                        |
| `shift interval ended: shields cleared`            | `intervalDidEnd` of a shift                                                                 |
| `no selection to shield with`                      | The extension had nothing to shield with (no saved app selection)                           |
| `Screen Time permission missing: nothing enforced` | Screen Time access was off at the boundary                                                  |
| `ignored: stale activity (no plan entry)`          | The schedule changed after this activity was registered; the newer activity is the live one |

## The checklist

Record each result in the table at the end. If a step fails, copy the diagnostics (Diagnostics › "Copy
diagnostics to clipboard") **before** doing anything else, then see "If something fails".

### 1. Fresh install, onboarding, join ClockOff Test

**Do**

1. If ClockOff is already on the phone and joined: open Settings › **Leave Workplace** and confirm. An
   employee who is linked to another active phone is never matched by name. Alternatively, on the dashboard,
   open Devices › the phone › **Deactivate**.
2. Delete ClockOff (touch and hold its icon › Remove App › Delete App), then install the Debug build (see
   above). Open ClockOff from the Home Screen.
3. **Get Started** → "Your name": First name `Zach`, Last name `Stephens` → **Continue**.
4. "Join your workplace": Company code `SCALE-0090` → **Find me**.
5. "Confirm it's you": check Workplace "ClockOff Test", Name "Zach Stephens", Location "Test site" → **Yes,
   that's me**.

**Phone:** the next screen is "How ClockOff works".

**Diagnostics:** not reachable yet. The checks for steps 1–3 are at the end of step 3.

**Dashboard** (Employees › Zach Stephens, no reload needed):

- **Connection** card: Status "Joined" with the device badge "Permissions missing".
- Device "iPhone", App version `0.1.0`, Last seen just now.
- **Activity** tab: "Joined".

### 2. Grant Family Controls (Screen Time access)

**Do:** "How ClockOff works" › **Continue** → "Allow Screen Time" › **Allow Screen Time access** → approve
the iOS prompt (it can ask for Face ID or the passcode).

**Phone:** moves on to "Choose apps to block". If you tapped Don't Allow, the screen offers "Open Settings"
and "Try again". That counts as a failure of this step: approve, then continue.

**Diagnostics** (check after step 3):

- Screen Time access › Family Controls **"Approved"**.
- Reported to workplace `APPROVED`.
- Restriction provider "Apple Screen Time".

All three without a warning triangle.

**Dashboard:**

- Permissions card: Screen Time authorisation "Approved".
- Activity: "Permission granted". It arrives with the phone's next upload of events; at the latest after
  step 3.

### 3. Select apps and categories

**Do**

1. "Choose apps to block" lists Social Media, Games and Entertainment. Tap **Choose apps**.
2. In Apple's picker, select the Social, Games and Entertainment categories, or at least the app you'll test
   with (Instagram is under Social). Tap Done.
3. **Continue** → "Your workplace settings" → **Complete Setup**.

**Phone:**

- Home shows **OFF SHIFT**, "No upcoming shifts · Work Mode inactive" and "Your apps work as normal."
- Settings › Permissions: Screen Time access "Allowed"; Apps to block shows the counts you picked.

**Diagnostics** (open it now):

| Section            | Expected                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Screen Time access | as in step 2                                                                                                                                                        |
| App selection      | Selection saved "Yes"; Apps, Categories and Web domains match what you picked (for example Categories `3`); Kept blocked on breaks "Not needed by the break policy" |
| Work Mode engine   | Shown in the app "Off shift"; Engine state `OFF_SHIFT`; Reason "No shift now and none upcoming in the cached schedule"; Restrictions should be active "No"          |
| Shield stores      | Source "ManagedSettings (live)"; Work store (.work) "Empty"; Break store (.breakRelaxed) "Empty"                                                                    |
| App Group          | Container "Shared App Group"; Outbox "Empty" (once the phone has synced)                                                                                            |
| Sync               | Last sync within the last minute; Last sync error "None"; API host `app.clockoff.online`                                                                            |

**Dashboard:**

- Connection: Status "Connected" with the device badge "Ready", or "Off shift" once the phone has reported
  its first engine state.
- Permissions: App selection "Configured", with counts only (for example "3 categories · 0 apps · 0
  websites").
- Activity: "Apps selected" and "Setup complete".

### 4. Create a test shift and sync it

**Do**

1. On the dashboard, open Employees › Zach Stephens and click **Create test shift…** in the page header.
   The Schedule page header has the same button, with an employee picker.
2. The dialog "Create test shift for Zach Stephens" shows its own note: "Apple requires at least 15 minutes;
   leave time for the phone to sync before it starts."
3. Set "Starts in (minutes)" to `20` and "Lasts (minutes)" to `45`. The default length of 30 is enough only
   if you start the break in step 6 within 10 minutes of the shift start. The preview reads "Starts at
   HH:MM and ends at HH:MM."
4. Click **Create test shift**. The toast "Test shift created" says, for example, "Zach Stephens, Wed 7
   Oct, 10:20–11:05. Sync ClockOff on the phone before it starts." Note both times.
5. On the phone: Diagnostics › **Force sync** → "Sync finished at …".

**Diagnostics:**

- **DeviceActivity schedules:**
  - Registered with iOS "1 activity", then a row named `shift-<shift id>-v1` with
    `2026-10-07 10:20 → 11:05 +01:00 · starts in 19 min · warning 15 min`. Neither row has a warning
    triangle.
  - Re-registration pending "No".
- **plans.json:**
  - File modified and Generated at are just now.
  - Entries `1`, then the same name with `shift · 2026-10-07 10:20 → 11:05 +01:00 · starts in 19 min`. It
    must **not** add "· not registered with iOS".
- **Work Mode engine:** Reason "No shift now; next shift 2026-10-07 10:20 → 11:05 +01:00 · starts in 19
  min".
- **Sync:** Schedule version is higher than before; Last sync is just now.
- **15 minutes before the start:**
  - Last extension callback "intervalWillStartWarning · shift-…-v1 · … · flagged starting soon".
  - Engine state `SHIFT_STARTING_SOON`, Shown in the app "Starting soon".

**Phone:**

- Home shows "OFF SHIFT", "Next shift today 10:20 – 11:05 · Work Mode inactive". The Schedule tab lists
  the shift.
- 15 minutes before the start, Home shows **STARTING SOON** with a "Work Mode starts in" countdown.

**Dashboard:**

- The shift is on the Schedule page and on the employee's Schedule tab.
- Activity: "Shift added".
- Overview › Today: "Next shift" with the times.

If **Create test shift…** is missing, the deployment doesn't list ClockOff Test in
`TEST_TOOLS_ORGANISATION_IDS`, or the switcher is on another organisation. As a fallback, add an ordinary
shift on the Schedule page that starts at least 20 minutes from now and lasts at least 15 minutes. The tool
refuses shorter test shifts because DeviceActivity's minimum interval is 15 minutes.

### 5. App closed: the shield appears at the shift start

**Do**

1. Before the start time, close ClockOff completely and leave it closed.
2. A minute after the start time, open Instagram (or another app you selected).
3. Then open an app you didn't select.
4. Only now open ClockOff.

**Phone:**

- Instagram shows the ClockOff shield:
  - title "ClockOff Test";
  - message "Work Mode is on. This app will be available again after your shift.";
  - buttons "OK" and "Open ClockOff".
- The unselected app opens normally.
- **This is the pass/fail point of the step.** The shield appeared while ClockOff was closed, so iOS woke
  the monitor extension and it applied the shields.
- ClockOff's Home then shows **WORK MODE ACTIVE**, "Distracting apps are blocked until 11:05." and a
  **Start Break** button.

**Diagnostics:**

- App Group:
  - Last extension callback "intervalDidStart · shift-…-v1 · 2026-10-07 10:20:02 +01:00 (…) · applied work
    shields for shift <id>". The time must be the shift start, **before** you opened ClockOff.
  - Engine state in state.json `WORKING · written by monitor extension · …`.
- Work Mode engine:
  - Shown in the app "Work Mode active".
  - Engine state `WORKING` (`SHIFT_ENDING` in the last 5 minutes).
  - Reason "Shift in progress … · running, ends in …".
  - Effective restriction `WORK`; Restrictions should be active "Yes".
  - Shield stores read back as "WORKING (source: provider)" with **no** warning triangle.
- Shield stores: Work store (.work) **"Shielding"**, its sets showing your counts (for example
  `applicationCategories specific(3)`); Break store (.breakRelaxed) "Empty".
- App Group › Outbox "Empty" once ClockOff has synced. The extension's `WORK_MODE_STARTED` event is uploaded
  then.

**Dashboard:**

- Before you open ClockOff:
  - the device badge is "Working" (a shift is active but the phone hasn't confirmed yet);
  - Overview › Today shows "Current shift", and Expected right now "Working" with "Restrictions on".
- After ClockOff syncs:
  - the badge is "Work Mode active";
  - Phone reports "Working";
  - Activity shows "Work Mode started".

### 6. Break: apps open, then the shield returns with the app closed

**Do**

1. Within the first 10 minutes of the shift, tap **Start Break** on Home. The break must end before the
   shift does, so this step tests break expiry and not the shift end.
2. Open Instagram. It opens.
3. Close ClockOff completely. Wait until a minute after the time shown in "Work Mode resumes at".
4. Open Instagram again.
5. Then open ClockOff.

**Phone:**

- During the break, Home shows:
  - **BREAK ACTIVE**, "Work Mode resumes at HH:MM.";
  - a "Break ends in" countdown;
  - "Relaxed: all apps are allowed during this break.";
  - an "End Break Early" button.
- After the break end, with ClockOff closed, Instagram shows the shield again within about a minute.
- Home shows WORK MODE ACTIVE again, with "Breaks: 1 of 2 left · 15 min remaining".

**Diagnostics during the break** (before you close the app):

- Work Mode engine:
  - Shown in the app "On break"; Engine state `ON_BREAK`.
  - Reason "Break running 2026-10-07 10:23 → 10:38 +01:00 · running, ends in 14 min, RELAX_ALL".
  - Effective restriction `BREAK_RELAXED`; Restrictions should be active "No".
  - Shield stores read back as "ON_BREAK (source: …)" with no triangle.
- Shield stores: both stores "Empty".
- DeviceActivity schedules: "2 activities", the shift and `break-<break id>`. plans.json lists both: one
  "shift" entry and one "break" entry.

**Diagnostics after the break:**

- Last extension callback "intervalDidEnd · break-… · <break end> · break expired: work shields restored".
- Work store (.work) "Shielding"; Shown in the app "Work Mode active".

**Dashboard:**

- On "Start Break": Activity "Break started"; the badge becomes "On break"; Overview › Today shows "Break in
  progress".
- After the break: Activity "Break ran out". The server also closes the break at its planned end. The
  badge returns to "Work Mode active" once the phone has synced.

### 7. Shift end with the app closed: the shield is removed

**Do:** close ClockOff completely before the shift's end time. A minute after the end, open Instagram, then
ClockOff.

**Phone:** Instagram opens normally. Home shows **OFF SHIFT**.

**Diagnostics:**

- Last extension callback "intervalDidEnd · shift-…-v1 · <end time> · shift interval ended: shields
  cleared".
- Work store (.work) "Empty"; Break store (.breakRelaxed) "Empty".
- Engine state `OFF_SHIFT`; Restrictions should be active "No".
- Shield stores read back as `OFF_SHIFT` with **no** warning triangle. A triangle here means shields were
  left behind: a failure.

**Dashboard:** Activity "Work Mode ended"; the badge is "Off shift"; Overview › Today no longer shows a
current shift.

### 8. Reboot mid-shift: the shield stays

**Do**

1. Create another test shift with the defaults (20 / 30) and run Force sync.
2. Close ClockOff. After the start, confirm the shield on Instagram, as in step 5.
3. Restart the phone (hold the side button and a volume button, slide to power off, then turn it on).
4. Unlock it once with the passcode. Don't open ClockOff.
5. Open Instagram.
6. Then open ClockOff.

**Phone:** Instagram still shows the shield after the restart. Shields are not shown before the first unlock
after a restart, so check after unlocking. Home shows WORK MODE ACTIVE.

**Diagnostics:**

- Work store (.work) "Shielding".
- Shield stores read back as "WORKING (source: provider)" with no triangle.
- Last extension callback is still the shift's `intervalDidStart` from before the restart. No new callback
  was needed: the shields survived the restart.

**Dashboard:** still "Work Mode active". The restart causes no "Work Mode ended" or second "Work Mode
started" in Activity.

**Optional variant:** restart the phone a few minutes **before** a test shift starts and unlock it. The shield
must still arrive at the start time, because DeviceActivity schedules survive a restart.

### 9. Airplane Mode before a shift: restrictions still apply on time

**Do**

1. Create another test shift with the defaults and run Force sync.
2. Check that Diagnostics lists the activity, as in step 4.
3. Turn on Airplane Mode and make sure Wi-Fi is off too (Control Center).
4. Close ClockOff. After the start time, open Instagram.
5. Then open ClockOff, still offline.
6. Finally, turn Airplane Mode off and tap Force sync.

**Phone:** the shield appears on time with no network. Offline, Home shows WORK MODE ACTIVE from the saved
schedule.

**Diagnostics offline:**

- Last extension callback "intervalDidStart · shift-… · <start> · applied work shields for shift <id>".
- Work store (.work) "Shielding".
- Sync › Last sync error shows a network code such as `NETWORK_ERROR`. It's orange and expected while
  offline.
- App Group › Outbox "N events waiting".

**Diagnostics back online:** Outbox "Empty"; Last sync error "None".

**Dashboard:**

- While the phone is offline, the badge stays "Working" (unconfirmed), and Activity has no "Work Mode
  started".
- After the sync: "Work Mode started" in Activity, and the badge is "Work Mode active".

Steps 8 and 9 can share one shift: stay in Airplane Mode and do the restart of step 8 mid-shift.

### 10. Revoke Screen Time access: Action Required

**Do**

1. Best done during a shift with the shield up. Create a test shift if none is running.
2. In iOS Settings, open Screen Time › Apps with Screen Time Access › ClockOff and turn access off. The exact
   wording can differ between iOS versions.
3. Open ClockOff, then Diagnostics.
4. Afterwards, turn access back on: in the same Settings screen, or with Home › **Open Setup**.

**Phone:**

- iOS removes ClockOff's shields: Instagram opens.
- Home shows **ACTION REQUIRED**: "Screen Time access is off, so ClockOff can't block apps during your
  shifts. Turn it back on in Settings › Screen Time." It has an **Open Setup** button.
- Settings › Permissions › Screen Time access shows "Turned off".

**Diagnostics:**

- Screen Time access: Family Controls "Denied" (orange); Reported to workplace `REVOKED` (orange).
- Work Mode engine:
  - Shown in the app "Action required: Screen Time access REVOKED" (orange).
  - Engine state `PERMISSION_ERROR`; Reason "Screen Time permission is REVOKED".
- Shield stores: both "Empty".

**Dashboard** (after the phone syncs; Force sync speeds this up):

- The device badge is **"Permissions missing"**.
- Permissions › Screen Time authorisation shows "Revoked".
- Activity: "Permission needs attention", with the sentence "Zach Stephens's Screen Time permission needs
  attention (revoked)".

**After turning access back on:**

- Family Controls returns to "Approved".
- During a shift, the shield returns and the dashboard goes back to "Work Mode active".

## Results

| #   | Step                               | Pass / fail | Notes (paste diagnostics for failures) |
| --- | ---------------------------------- | ----------- | -------------------------------------- |
| 1   | Fresh install and join             |             |                                        |
| 2   | Screen Time access approved        |             |                                        |
| 3   | Apps and categories selected       |             |                                        |
| 4   | Test shift synced and registered   |             |                                        |
| 5   | Shield at shift start, app closed  |             |                                        |
| 6   | Break relaxes, then shield returns |             |                                        |
| 7   | Shield removed at shift end        |             |                                        |
| 8   | Shield survives a restart          |             |                                        |
| 9   | Shield on time in Airplane Mode    |             |                                        |
| 10  | Revoked access: Action Required    |             |                                        |

## If something fails

| What you see                                                             | Look at                                                                                              | What it means                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No shield at the shift start (app closed)                                | Before the start: DeviceActivity schedules and plans.json. After it: Last extension callback         | Activity not listed: the phone never registered it. Check Last sync and Schedule version, and run Force sync again. "Re-registration pending: Yes": registering with iOS failed. Listed, but no callback at the start time: iOS did not wake the extension; note the time and copy the diagnostics. A callback with another outcome: see the outcome table above. |
| Callback "applied work shields…" but no shield                           | Shield stores › Work store (.work) and its sets                                                      | The extension applied the selection but ManagedSettings shows nothing, or the selection doesn't cover the app you opened. Compare the counts with what you picked.                                                                                                                                                                                                |
| Shield works but Home shows the wrong state (or the reverse)             | Shown in the app · Engine state · Shield stores read back as                                         | Enforcement is fine and the app's display is wrong: an app bug. Copy the diagnostics.                                                                                                                                                                                                                                                                             |
| Shields still up after the shift ends                                    | "Shield stores read back as" orange with Restrictions should be active "No"; Last extension callback | Shields were left behind. The callback shows whether `intervalDidEnd` ran. Copy the diagnostics, then use **Clear all shields** to recover.                                                                                                                                                                                                                       |
| Selection incomplete flag "Yes"                                          | App selection                                                                                        | The extension tried to shield without a saved selection. Choose apps again (Settings › Permissions).                                                                                                                                                                                                                                                              |
| Container "Private fallback (the extensions can't read it)"              | App Group                                                                                            | The App Group entitlement is missing from this build, so the extensions can't read `plans.json`. Reinstall a correctly signed build.                                                                                                                                                                                                                              |
| Restriction provider "Simulated (development)", or the yellow banner     | Screen Time access                                                                                   | `apps/ios/Config/Local.xcconfig` forces the mock on device builds. Remove that line and reinstall.                                                                                                                                                                                                                                                                |
| API host is not `app.clockoff.online`                                    | Sync                                                                                                 | A `Local.xcconfig` override points the phone at another server, which doesn't have ClockOff Test.                                                                                                                                                                                                                                                                 |
| Clock skew orange                                                        | Sync                                                                                                 | The phone's clock is more than 5 minutes off the server's. Turn on Set Automatically; schedules follow the phone's clock.                                                                                                                                                                                                                                         |
| "This employee has already joined from another phone." during step 1     | —                                                                                                    | The employee is still linked to an active phone. Leave Workplace on that phone, or deactivate it on the dashboard (Devices).                                                                                                                                                                                                                                      |
| "This shift overlaps another shift for the same employee." in the dialog | —                                                                                                    | A previous test shift is still scheduled. Wait for it to end, or cancel it on the Schedule page.                                                                                                                                                                                                                                                                  |

To read the phone's logs live, open Console on the Mac, select the iPhone in the sidebar, start streaming,
and filter on `subsystem:online.clockoff.app`. The monitor extension logs every callback there too.

## Recreating the test organisation

`apps/web/scripts/setup-test-organisation.ts` creates ClockOff Test, or finds it again, through the same
services the dashboard uses:

- the organisation (Europe/London) with its company code and the location "Test site";
- the "Standard Staff" Work Policy and the "Standard Break" Break Policy, both set as the defaults;
- the employee.

It is idempotent and only ever touches a "ClockOff Test" organisation owned by `OWNER_EMAIL`. Run it with
the target deployment's database. For production, that is the Neon connection string kept in
`.env.deploy`; the remaining variables come from the root `.env`. dotenv does not override a variable that
is already set.

```sh
cd apps/web
DATABASE_URL="<production DATABASE_URL>" OWNER_EMAIL="<owner's email>" TEST_EMPLOYEE_NAME="Zach Stephens" \
  pnpm exec dotenv -e ../../.env -- tsx scripts/setup-test-organisation.ts
```

It prints JSON with the organisation id, `companyCode`, policy names, employee and location, plus a
`testToolsEnv` line (`TEST_TOOLS_ORGANISATION_IDS=<id>`). If the organisation was created afresh (for example
after the old one was deleted), its id and company code are new:

- set the new id in `TEST_TOOLS_ORGANISATION_IDS` on the Netlify site and redeploy;
- update `apps/web/.env.production.example`;
- update the code in this document.

## Repeating the checklist

- To start again from step 1, leave the workplace on the phone (Settings › Leave Workplace) and delete the
  app. Leaving lifts every restriction, removes the saved schedule and app choices, and disconnects the
  phone.
- Test shifts are real shifts: they stay on ClockOff Test's schedule and in its Activity. The tool is
  limited to 30 per hour per IP address.
- "Create test shift…" is in production only for organisations listed in `TEST_TOOLS_ORGANISATION_IDS`. Every
  other organisation gets a 404 from `POST /api/test-tools/test-shift` and never sees the button.
