import { DEVICE_REPORTABLE_EVENT_TYPES, INTEGRATION_PROVIDERS } from "./enums";
import { PROVIDERS } from "./providers/registry";

/**
 * Single source of truth for ClockOff's privacy promise (§12): what an employer CAN see about an
 * employee's phone, what it CANNOT see, and the only fields a device is permitted to send to the server.
 *
 * Consumed by: the marketing/privacy and help pages (web), the iOS Welcome and Privacy screens
 * (`EMPLOYEE_PRIVACY_SUMMARY`, CAN_SEE / CANNOT_SEE), the mobile API payload allow-list
 * (`DEVICE_TO_SERVER_ALLOWED_FIELD_KEYS`) and `docs/PRIVACY.md`, which is GENERATED from
 * `renderPrivacyMarkdown()` — never hand-edit that file (see `PRIVACY_DOC_GENERATED_NOTICE`).
 *
 * Technical grounding: the iOS app uses Apple's Screen Time frameworks (FamilyControls, ManagedSettings,
 * DeviceActivity). The apps, categories and websites an employee chooses come back from Apple's picker as
 * opaque tokens (`FamilyActivitySelection`) that can only be interpreted on the device that created them.
 * The app keeps them in its on-device App Group container and sends the server nothing but counts.
 * ClockOff registers time-based schedules only (no usage thresholds) and ships no DeviceActivityReport
 * extension, so it never learns which apps were used or for how long.
 */

export interface PrivacyStatement {
  /** Stable identifier used for i18n keys and test assertions. */
  readonly key: string;
  /** Short heading shown in lists. */
  readonly label: string;
  /** One to three plain-English sentences; technically accurate. */
  readonly detail: string;
}

export const PRIVACY_PRINCIPLE = "Block distractions. Don't spy on employees.";

/** Operational status is the ONLY category of information an employer receives about the phone. */
export const CAN_SEE = [
  {
    key: "connection",
    label: "Whether the employee has joined and their device is connected",
    detail:
      "The employee's setup stage (not invited, invited, joined, setup incomplete, connected or deactivated) and whether the ClockOff app is active on their phone.",
  },
  {
    key: "permissionState",
    label: "Whether Screen Time authorisation is granted",
    detail:
      "Only the state of the authorisation: not determined, approved, denied or revoked. Managers see that permission needs attention, never anything the permission gives access to.",
  },
  {
    key: "selectionCounts",
    label: "Whether apps have been selected, and how many",
    detail:
      "Whether the employee has chosen what to shield and how many categories, apps and websites that choice contains. Never which ones: the choice is held on the phone as opaque Apple tokens that neither the employer nor ClockOff's servers can read.",
  },
  {
    key: "workModeState",
    label: "Whether Work Mode is active right now",
    detail:
      "The on-device Work Mode state: off shift, starting soon, working, on break, shift ending, manager override, permission error or sync error. It confirms whether shields are applied, not what the employee is doing on the phone.",
  },
  {
    key: "breaks",
    label: "Break start and end times during a shift",
    detail:
      "When a break started and ended and how many breaks were taken, so they can be checked against the Break Rules. Breaks are either started by the employee in the app or scheduled on the shift by the employer.",
  },
  {
    key: "syncTimes",
    label: "When the device last synced",
    detail:
      "Timestamps of the last device check-in, policy sync and schedule sync, so managers can tell a connected device from one that has not checked in for hours or days.",
  },
  {
    key: "deviceBasics",
    label: "App version, iOS version and generic device model",
    detail:
      "For support and compatibility only, for example app 1.2.0 on iOS 17.5 on an iPhone. No hardware or advertising identifiers (serial number, IMEI, phone number, advertising ID or vendor ID) are collected.",
  },
  {
    key: "clock",
    label: "Device timezone and clock skew",
    detail:
      "The timezone setting the phone reports (for example Europe/London) and how far its clock is from server time, so shifts start at the right moment and a wrong clock is flagged. A timezone is a region setting, not a location.",
  },
  {
    key: "activity",
    label: "A timeline of operational events",
    detail:
      "Events from a fixed list, such as joined, setup completed, Work Mode started or ended, break started or ended, and permission needs attention. Each has a time and no free text.",
  },
  {
    key: "schedule",
    label: "The shifts, policies and break rules the employer created",
    detail:
      "This is the employer's own data, not something observed from the phone. The dashboard combines it with the operational status above to show who should be in Work Mode and whether their phone agrees.",
  },
] as const satisfies readonly PrivacyStatement[];

export type CanSeeKey = (typeof CAN_SEE)[number]["key"];

/** The employer never receives any of the following: the app does not collect them, so there is nothing to send. */
export const CANNOT_SEE = [
  {
    key: "messages",
    label: "Messages and calls",
    detail:
      "No iMessage, SMS, WhatsApp, email or call content or history. The Screen Time frameworks ClockOff uses do not expose messaging or calls at all.",
  },
  {
    key: "photos",
    label: "Photos, videos, camera and files",
    detail:
      "The app does not request access to Photos, the camera, the microphone or files, so it cannot read any media.",
  },
  {
    key: "browsing",
    label: "Browsing history and searches",
    detail:
      "No websites visited, search terms or other web activity. Websites an employee chooses to shield are opaque tokens on the phone: counted, never sent.",
  },
  {
    key: "appUsage",
    label: "App usage, screen time or which apps were opened",
    detail:
      "ClockOff registers time-based schedules only and receives no usage reports. When a shielded app is opened, the shield and its buttons are handled on the phone; nothing about which app, how often or for how long is sent to the server.",
  },
  {
    key: "selectedApps",
    label: "Which specific apps, categories or websites were selected",
    detail:
      "Apple returns the selection as opaque tokens that are meaningless off the phone that created them. They are stored only in the app's on-device container and are never uploaded; the server receives counts only.",
  },
  {
    key: "notifications",
    label: "Notifications",
    detail:
      "Neither the content nor the existence of notifications from other apps is visible to Work Mode.",
  },
  {
    key: "location",
    label: "Location",
    detail:
      "The app does not use Location Services, Wi-Fi or Bluetooth scanning. Like any internet service, the server sees the network address of each request for security and rate limiting; it is not used to locate anyone and is never shown to the employer.",
  },
  {
    key: "personalData",
    label: "Contacts, calendar, health, passwords, keystrokes or screenshots",
    detail:
      "ClockOff requests none of these permissions and contains no keyboard, screen-recording or screenshot capability.",
  },
  {
    key: "offShift",
    label: "What happens on the phone outside shifts",
    detail:
      "Shields lift when the shift ends. Off shift the app only performs routine sync check-ins, which carry the same operational fields as always and nothing about how the phone is used.",
  },
] as const satisfies readonly PrivacyStatement[];

export type CannotSeeKey = (typeof CANNOT_SEE)[number]["key"];

/**
 * The plain-language summary for employee-facing copy (onboarding, help pages, store listing). The iOS
 * Welcome screen and the Screen Time permission prompt show shorter excerpts of it.
 */
export const EMPLOYEE_PRIVACY_SUMMARY =
  "ClockOff blocks distracting apps during your shifts. Your employer sees operational status only: whether the app is set up and working, when you take breaks, when your phone last synced, and basics such as the app version and your timezone. " +
  "They cannot see your messages, photos, browsing history, notifications, what you do on your phone, or which apps you chose to block. " +
  "Your app choices stay on this device.";

export interface DeviceToServerField {
  /** Stable identifier for the group of fields. */
  readonly key: string;
  readonly label: string;
  readonly detail: string;
  /**
   * The wire field names this entry permits, exactly as they appear (at any nesting level) in mobile API
   * request bodies and queries — see `MOBILE_REQUEST_FIELD_PRIVACY` in packages/validation/src/mobile.ts,
   * which classifies every request field under one of these group keys.
   */
  readonly fields: readonly string[];
}

/**
 * The ONLY data the iOS app may send to the server. Mobile API request schemas are strict objects and must
 * not accept a field that is not listed here (`DEVICE_TO_SERVER_ALLOWED_FIELD_KEYS`). Adding one means
 * changing this list, which regenerates docs/PRIVACY.md — a deliberate, reviewable privacy decision.
 *
 * Not listed because they are not information about the employee or the phone: authentication material
 * (access/refresh tokens), ids the server itself issued (employee, shift and break-session ids) and purely
 * structural fields (the `device` and `metadata` containers and the `from` / `to` window of a schedule query).
 */
export const DEVICE_TO_SERVER_ALLOWED_FIELDS = [
  {
    key: "joinDetails",
    label: "Join details",
    fields: ["companyCode", "inviteCode", "firstName", "lastName"],
    detail:
      "Sent only when joining: the company code, the optional employee invite code, and the first and last name the employee types, used only to find the employee record the employer already created.",
  },
  {
    key: "permissionState",
    label: "Permission state",
    fields: ["permissionState"],
    detail:
      "Screen Time authorisation state: NOT_DETERMINED, APPROVED, DENIED, REVOKED or UNKNOWN.",
  },
  {
    key: "selectionState",
    label: "Selection state and counts",
    fields: ["selectionState", "selectionCounts", "categories", "applications", "webDomains"],
    detail:
      "Whether a selection exists (NONE or CONFIGURED) and three numbers: how many categories, apps and websites it contains. Never the tokens, names or bundle identifiers of what was selected.",
  },
  {
    key: "restrictionEngineState",
    label: "Engine state",
    fields: ["restrictionEngineState", "engineState"],
    detail:
      "The on-device Work Mode state (also attached to some events): OFF_SHIFT, SHIFT_STARTING_SOON, WORKING, ON_BREAK, SHIFT_ENDING, MANAGER_OVERRIDE, PERMISSION_ERROR, SYNC_ERROR or UNKNOWN.",
  },
  {
    key: "versions",
    label: "App and OS version",
    fields: ["appVersion", "osVersion"],
    detail:
      "The ClockOff app version (for example 1.2.0) and the iOS version (for example 17.5.1).",
  },
  {
    key: "deviceModel",
    label: "Platform and generic device model",
    fields: ["platform", "model"],
    detail:
      "The platform (IOS) and the generic model family iOS reports, such as iPhone or iPad. Never the device's name, serial number or any other per-device identifier.",
  },
  {
    key: "syncTimestamps",
    label: "Applied policy and schedule versions",
    fields: ["policyVersionApplied", "scheduleVersionApplied", "policyVersion", "scheduleVersion"],
    detail:
      "Which policy version and schedule version the device has applied (both were issued by the server). The server records when it receives them; that is the last policy and schedule sync time managers see.",
  },
  {
    key: "timezone",
    label: "Timezone",
    fields: ["timezone"],
    detail: "The phone's IANA timezone setting, for example Europe/London.",
  },
  {
    key: "deviceTime",
    label: "Local time (clock skew)",
    fields: ["localTime"],
    detail:
      "The phone's clock reading when it checks in. The server keeps only the difference from server time, in whole seconds.",
  },
  {
    key: "breaks",
    label: "Break start and end",
    fields: ["clientBreakId", "requestedAt", "requestedDurationMinutes", "endedAt"],
    detail:
      "Starting or ending a break: an idempotency id generated by the app, the phone's time when the break was requested, the requested length in minutes, and the time it ended (with an enumerated end reason).",
  },
  {
    key: "events",
    label: "Enumerated events",
    fields: ["events", "clientEventId", "type", "occurredAt", "reason"],
    detail: `Operational events from a fixed list, each with an idempotency id generated by the app, the time it happened and optional metadata limited to the fields on this list, server-issued ids and an UPPER_SNAKE_CASE reason code; no free text. The event types are ${DEVICE_REPORTABLE_EVENT_TYPES.join(", ")}.`,
  },
  {
    key: "pushToken",
    label: "Push token",
    fields: ["token", "environment"],
    detail:
      "The Apple Push Notification token for this app install and whether it belongs to Apple's sandbox or production service. Stored encrypted and used only to ask the app to sync. It identifies the app install to Apple, not the person.",
  },
] as const satisfies readonly DeviceToServerField[];

export type DeviceToServerFieldGroupKey = (typeof DEVICE_TO_SERVER_ALLOWED_FIELDS)[number]["key"];
export type DeviceToServerFieldKey =
  (typeof DEVICE_TO_SERVER_ALLOWED_FIELDS)[number]["fields"][number];

/** Flat list of every permitted wire field name, for allow-list checks in mobile API schemas and tests. */
export const DEVICE_TO_SERVER_ALLOWED_FIELD_KEYS: readonly DeviceToServerFieldKey[] =
  DEVICE_TO_SERVER_ALLOWED_FIELDS.flatMap((group) => group.fields);

/** True when `field` is a wire field name a device is allowed to send. */
export function isDeviceToServerAllowedField(field: string): field is DeviceToServerFieldKey {
  return (DEVICE_TO_SERVER_ALLOWED_FIELD_KEYS as readonly string[]).includes(field);
}

/** Command that regenerates docs/PRIVACY.md (also printed by the failing test). */
export const PRIVACY_DOC_REGENERATE_COMMAND =
  "cd packages/shared && UPDATE_PRIVACY_DOC=1 pnpm vitest run src/privacyStatements.test.ts";

export const PRIVACY_DOC_GENERATED_NOTICE =
  "<!-- GENERATED FILE — do not edit by hand. Source: packages/shared/src/privacyStatements.ts (renderPrivacyMarkdown). " +
  `Regenerate: ${PRIVACY_DOC_REGENERATE_COMMAND} -->`;

function renderStatements(items: readonly PrivacyStatement[]): string {
  return items.map((s) => `- **${s.label}.** ${s.detail}`).join("\n");
}

/** "A, B and C" */
function formatList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`;
}

/**
 * The integrations bullet, derived from the provider registry so it cannot claim a sync that does not
 * exist: while every provider is Coming Soon it says so.
 */
function integrationsStatement(): string {
  const names = formatList(INTEGRATION_PROVIDERS.map((id) => PROVIDERS[id].displayName));
  const anyAvailable = INTEGRATION_PROVIDERS.some((id) => PROVIDERS[id].status === "AVAILABLE");
  return anyAvailable
    ? `- Workforce integrations (${names}) only bring employees, teams, locations, shifts and clock events into ClockOff. Nothing about the phone is sent to them.`
    : `- Workforce integrations (${names}) are not available yet. When they are, they will only bring employees, teams, locations, shifts and clock events into ClockOff; nothing about the phone will be sent to them.`;
}

function renderAllowedFields(items: readonly DeviceToServerField[]): string {
  return items
    .map((g) => `- **${g.label}** (${g.fields.map((f) => `\`${f}\``).join(", ")}). ${g.detail}`)
    .join("\n");
}

/**
 * Renders the complete contents of `docs/PRIVACY.md` (including the generated-file notice). The committed
 * file must equal this output byte for byte; `privacyStatements.test.ts` enforces it. The output is kept
 * Prettier-stable (ATX headings, `-` bullets, no tables, no trailing spaces) so `pnpm format` leaves it alone.
 */
export function renderPrivacyMarkdown(): string {
  const lines: string[] = [
    PRIVACY_DOC_GENERATED_NOTICE,
    "",
    "# Privacy",
    "",
    `> **${PRIVACY_PRINCIPLE}**`,
    "",
    "ClockOff exists to make shift work less distracting, not to monitor people. The employer sees operational status only. This document is the authoritative statement of what that means; the same definitions drive the dashboard, the employee app and the mobile API allow-list.",
    "",
    "## How it works, technically",
    "",
    "- The iOS app uses Apple's Screen Time frameworks (FamilyControls, ManagedSettings and DeviceActivity). They let an app shield apps, categories and websites on a schedule. They do not give the app message content, photos, notifications or browsing history.",
    "- When an employee chooses what to shield, Apple's picker returns the choice as opaque tokens (`FamilyActivitySelection`). The tokens can only be interpreted on the phone that created them. The app stores them in its on-device App Group container; the server receives only the number of categories, apps and websites selected.",
    "- Shields are applied and lifted by the app's DeviceActivity extension at the shift and break times the server synced to the phone. ClockOff registers time-based schedules only, with no usage thresholds and no activity-report extension, so it never learns which apps were used or for how long.",
    "- Enforcement is local. The server never controls the phone: it supplies the schedule and policy (and may send a silent push asking the app to sync) and receives the resulting engine state.",
    '- Everything managers see is derived from the fields listed under "What the device sends" plus the employer\'s own shifts, policies and break rules.',
    "",
    "## What the employer CAN see",
    "",
    renderStatements(CAN_SEE),
    "",
    "## What the employer CANNOT see",
    "",
    renderStatements(CANNOT_SEE),
    "",
    "## What the employee is told",
    "",
    "This is the summary for employee-facing copy. Before joining, the iOS Welcome screen and the Screen Time permission prompt show shorter versions of it:",
    "",
    `> ${EMPLOYEE_PRIVACY_SUMMARY}`,
    "",
    "To join, the employee enters their company code and their name, plus an employee invite code if the name matches more than one person. That links the app to the employee record the employer already holds; it does not give the employer access to the phone. The app's Settings screen repeats the CAN and CANNOT lists above.",
    "",
    "## What the device sends",
    "",
    "The mobile API accepts only the fields below, by their exact request field names. Request schemas are strict: unknown fields are rejected. Adding a field means changing `packages/shared/src/privacyStatements.ts`, which regenerates this document, so the allow-list and this statement cannot drift apart. Not listed, because they carry no information about the employee or the phone: authentication tokens, ids the server itself issued (employee, shift and break ids), and structural fields (the `device` and `metadata` containers and the `from` / `to` window of a schedule request).",
    "",
    renderAllowedFields(DEVICE_TO_SERVER_ALLOWED_FIELDS),
    "",
    "## Data handling",
    "",
    "- Push tokens and workforce-integration credentials are encrypted at rest with AES-256-GCM (`INTEGRATION_ENCRYPTION_KEY`).",
    "- Audit logs record what managers do (who changed a policy, who created an override), not what employees do on their phones.",
    "- Leaving the workplace from the app removes Work Mode's shields and schedules from the phone and deletes its local copy of the schedule. A manager deactivating an employee or device revokes that device's access, so it can no longer sync.",
    integrationsStatement(),
    "",
  ];
  return lines.join("\n");
}
