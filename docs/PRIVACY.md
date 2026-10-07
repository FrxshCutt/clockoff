<!-- GENERATED FILE — do not edit by hand. Source: packages/shared/src/privacyStatements.ts (renderPrivacyMarkdown). Regenerate: cd packages/shared && UPDATE_PRIVACY_DOC=1 pnpm vitest run src/privacyStatements.test.ts -->

# Privacy

> **Block distractions. Don't spy on employees.**

ClockOff exists to make shift work less distracting, not to monitor people. The employer sees operational status only. This document is the authoritative statement of what that means; the same definitions drive the dashboard, the employee app and the mobile API allow-list.

## How it works, technically

- The iOS app uses Apple's Screen Time frameworks (FamilyControls, ManagedSettings and DeviceActivity). They let an app shield apps, categories and websites on a schedule. They do not give the app message content, photos, notifications or browsing history.
- When an employee chooses what to shield, Apple's picker returns the choice as opaque tokens (`FamilyActivitySelection`). The tokens can only be interpreted on the phone that created them. The app stores them in its on-device App Group container; the server receives only the number of categories, apps and websites selected.
- Shields are applied and lifted by the app's DeviceActivity extension at the shift and break times the server synced to the phone. ClockOff registers time-based schedules only, with no usage thresholds and no activity-report extension, so it never learns which apps were used or for how long.
- Enforcement is local. The server never controls the phone: it supplies the schedule and policy (and may send a silent push asking the app to sync) and receives the resulting engine state.
- Everything managers see is derived from the fields listed under "What the device sends" plus the employer's own shifts, policies and break rules.

## What the employer CAN see

- **Whether the employee has joined and their device is connected.** The employee's setup stage (not invited, invited, joined, setup incomplete, connected or deactivated) and whether the ClockOff app is active on their phone.
- **Whether Screen Time authorisation is granted.** Only the state of the authorisation: not determined, approved, denied or revoked. Managers see that permission needs attention, never anything the permission gives access to.
- **Whether apps have been selected, and how many.** Whether the employee has chosen what to shield and how many categories, apps and websites that choice contains. Never which ones: the choice is held on the phone as opaque Apple tokens that neither the employer nor ClockOff's servers can read.
- **Whether Work Mode is active right now.** The on-device Work Mode state: off shift, starting soon, working, on break, shift ending, manager override, permission error or sync error. It confirms whether shields are applied, not what the employee is doing on the phone.
- **Break start and end times during a shift.** When a break started and ended and how many breaks were taken, so they can be checked against the Break Rules. Breaks are either started by the employee in the app or scheduled on the shift by the employer.
- **When the device last synced.** Timestamps of the last device check-in, policy sync and schedule sync, so managers can tell a connected device from one that has not checked in for hours or days.
- **App version, iOS version and generic device model.** For support and compatibility only, for example app 1.2.0 on iOS 17.5 on an iPhone. No hardware or advertising identifiers (serial number, IMEI, phone number, advertising ID or vendor ID) are collected.
- **Device timezone and clock skew.** The timezone setting the phone reports (for example Europe/London) and how far its clock is from server time, so shifts start at the right moment and a wrong clock is flagged. A timezone is a region setting, not a location.
- **A timeline of operational events.** Events from a fixed list, such as joined, setup completed, Work Mode started or ended, break started or ended, and permission needs attention. Each has a time and no free text.
- **The shifts, policies and break rules the employer created.** This is the employer's own data, not something observed from the phone. The dashboard combines it with the operational status above to show who should be in Work Mode and whether their phone agrees.

## What the employer CANNOT see

- **Messages and calls.** No iMessage, SMS, WhatsApp, email or call content or history. The Screen Time frameworks ClockOff uses do not expose messaging or calls at all.
- **Photos, videos, camera and files.** The app does not request access to Photos, the camera, the microphone or files, so it cannot read any media.
- **Browsing history and searches.** No websites visited, search terms or other web activity. Websites an employee chooses to shield are opaque tokens on the phone: counted, never sent.
- **App usage, screen time or which apps were opened.** ClockOff registers time-based schedules only and receives no usage reports. When a shielded app is opened, the shield and its buttons are handled on the phone; nothing about which app, how often or for how long is sent to the server.
- **Which specific apps, categories or websites were selected.** Apple returns the selection as opaque tokens that are meaningless off the phone that created them. They are stored only in the app's on-device container and are never uploaded; the server receives counts only.
- **Notifications.** Neither the content nor the existence of notifications from other apps is visible to Work Mode.
- **Location.** The app does not use Location Services, Wi-Fi or Bluetooth scanning. Like any internet service, the server sees the network address of each request for security and rate limiting; it is not used to locate anyone and is never shown to the employer.
- **Contacts, calendar, health, passwords, keystrokes or screenshots.** ClockOff requests none of these permissions and contains no keyboard, screen-recording or screenshot capability.
- **What happens on the phone outside shifts.** Shields lift when the shift ends. Off shift the app only performs routine sync check-ins, which carry the same operational fields as always and nothing about how the phone is used.

## What the employee is told

This is the summary for employee-facing copy. Before joining, the iOS Welcome screen and the Screen Time permission prompt show shorter versions of it:

> ClockOff blocks distracting apps during your shifts. Your employer sees operational status only: whether the app is set up and working, when you take breaks, when your phone last synced, and basics such as the app version and your timezone. They cannot see your messages, photos, browsing history, notifications, what you do on your phone, or which apps you chose to block. Your app choices stay on this device.

To join, the employee enters their company code and their name, plus an employee invite code if the name matches more than one person. That links the app to the employee record the employer already holds; it does not give the employer access to the phone. The app's Settings screen repeats the CAN and CANNOT lists above.

## What the device sends

The mobile API accepts only the fields below, by their exact request field names. Request schemas are strict: unknown fields are rejected. Adding a field means changing `packages/shared/src/privacyStatements.ts`, which regenerates this document, so the allow-list and this statement cannot drift apart. Not listed, because they carry no information about the employee or the phone: authentication tokens, ids the server itself issued (employee, shift and break ids), and structural fields (the `device` and `metadata` containers and the `from` / `to` window of a schedule request).

- **Join details** (`companyCode`, `inviteCode`, `firstName`, `lastName`). Sent only when joining: the company code, the optional employee invite code, and the first and last name the employee types, used only to find the employee record the employer already created.
- **Permission state** (`permissionState`). Screen Time authorisation state: NOT_DETERMINED, APPROVED, DENIED, REVOKED or UNKNOWN.
- **Selection state and counts** (`selectionState`, `selectionCounts`, `categories`, `applications`, `webDomains`). Whether a selection exists (NONE or CONFIGURED) and three numbers: how many categories, apps and websites it contains. Never the tokens, names or bundle identifiers of what was selected.
- **Engine state** (`restrictionEngineState`, `engineState`). The on-device Work Mode state (also attached to some events): OFF_SHIFT, SHIFT_STARTING_SOON, WORKING, ON_BREAK, SHIFT_ENDING, MANAGER_OVERRIDE, PERMISSION_ERROR, SYNC_ERROR or UNKNOWN.
- **App and OS version** (`appVersion`, `osVersion`). The ClockOff app version (for example 1.2.0) and the iOS version (for example 17.5.1).
- **Platform and generic device model** (`platform`, `model`). The platform (IOS) and the generic model family iOS reports, such as iPhone or iPad. Never the device's name, serial number or any other per-device identifier.
- **Applied policy and schedule versions** (`policyVersionApplied`, `scheduleVersionApplied`, `policyVersion`, `scheduleVersion`). Which policy version and schedule version the device has applied (both were issued by the server). The server records when it receives them; that is the last policy and schedule sync time managers see.
- **Timezone** (`timezone`). The phone's IANA timezone setting, for example Europe/London.
- **Local time (clock skew)** (`localTime`). The phone's clock reading when it checks in. The server keeps only the difference from server time, in whole seconds.
- **Break start and end** (`clientBreakId`, `requestedAt`, `requestedDurationMinutes`, `endedAt`). Starting or ending a break: an idempotency id generated by the app, the phone's time when the break was requested, the requested length in minutes, and the time it ended (with an enumerated end reason).
- **Enumerated events** (`events`, `clientEventId`, `type`, `occurredAt`, `reason`). Operational events from a fixed list, each with an idempotency id generated by the app, the time it happened and optional metadata limited to the fields on this list, server-issued ids and an UPPER_SNAKE_CASE reason code; no free text. The event types are SETUP_COMPLETED, PERMISSION_GRANTED, PERMISSION_NEEDS_ATTENTION, SELECTION_CONFIGURED, WORK_MODE_STARTED, WORK_MODE_ENDED, BREAK_STARTED, BREAK_ENDED, BREAK_EXPIRED, SCHEDULE_SYNCED, POLICY_SYNCED.
- **Push token** (`token`, `environment`). The Apple Push Notification token for this app install and whether it belongs to Apple's sandbox or production service. Stored encrypted and used only to ask the app to sync. It identifies the app install to Apple, not the person.

## Data handling

- Push tokens and workforce-integration credentials are encrypted at rest with AES-256-GCM (`INTEGRATION_ENCRYPTION_KEY`).
- Audit logs record what managers do (who changed a policy, who created an override), not what employees do on their phones.
- Leaving the workplace from the app removes Work Mode's shields and schedules from the phone and deletes its local copy of the schedule. A manager deactivating an employee or device revokes that device's access, so it can no longer sync.
- Workforce integrations (Planday, Deputy, 7shifts, When I Work, Rotaready and Homebase) are not available yet. When they are, they will only bring employees, teams, locations, shifts and clock events into ClockOff; nothing about the phone will be sent to them.
