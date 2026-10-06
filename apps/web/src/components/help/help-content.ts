import type { DeviceStatusBadge } from "@workmode/shared/enums";
import { DEVICE_STATUS_THRESHOLDS } from "@workmode/shared/status/deriveDeviceStatus";
import { ROUTES, routeFor } from "@/config/navigation";
import { SITE } from "@/config/site";

/**
 * Content for the Help page: FAQ, the employee setup guide (mirroring the iOS onboarding flow screen by
 * screen), troubleshooting and support. Plain data so it is unit-testable and reusable on the marketing site.
 */

export const HELP_ANCHORS = {
  gettingStarted: "getting-started",
  setup: "employee-setup",
  faq: "faq",
  privacy: "privacy",
  troubleshooting: "troubleshooting",
  support: "support",
} as const;

export interface FaqItem {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  /** Optional internal link that follows the answer. */
  readonly href?: string;
  readonly linkLabel?: string;
}

export const FAQ_ITEMS: readonly FaqItem[] = [
  {
    id: "what-it-does",
    question: "What does Work Mode actually do on an employee's phone?",
    answer:
      "During a scheduled shift the Work Mode app uses Apple's Screen Time frameworks to shield the app categories in your Work Policy (and, if you allow it, specific apps the employee picks). Shields lift for breaks according to your Break Rules and when the shift ends. Everything is enforced on the phone itself; the server only sends the schedule and policy.",
  },
  {
    id: "what-can-i-see",
    question: "What can I see about an employee's phone?",
    answer:
      "Operational status only: whether they have joined, whether Screen Time permission is granted, whether Work Mode is on right now, break start and end times and when the phone last synced. Never messages, photos, browsing, notifications, app usage or which apps they chose to shield.",
    href: `${ROUTES.help}#${HELP_ANCHORS.privacy}`,
    linkLabel: "See the full list",
  },
  {
    id: "how-employees-join",
    question: "How do employees join?",
    answer:
      "Add them in Employees first, then share your company join code. They install Work Mode on their iPhone, enter the code and their name, and the app matches them to your employee list. If the name matches more than one person they also enter the personal invite code from their invite.",
    href: routeFor.settingsTab("join-code"),
    linkLabel: "Join code settings",
  },
  {
    id: "android",
    question: "Does Work Mode work on Android?",
    answer:
      "Not yet. Work Mode relies on Apple's Screen Time frameworks (FamilyControls, ManagedSettings and DeviceActivity), which exist only on iPhone running iOS 16.4 or later. Android support depends on equivalent platform controls.",
  },
  {
    id: "breaks",
    question: "What happens during a break?",
    answer:
      "Your Break Rules decide how long a break can last, how many are allowed per shift, how soon after the shift starts and what relaxes: every restriction, only certain categories, or nothing. An employee starts a break in the app (if you allow it) or you schedule breaks on the shift; shields come back automatically when the break ends.",
    href: ROUTES.breakRules,
    linkLabel: "Break Rules",
  },
  {
    id: "precedence",
    question: "An employee is in a team and a location with different policies. Which one applies?",
    answer:
      "The most specific assignment wins: a policy assigned directly to the employee beats their team, which beats their location, which beats the organisation default. If two teams the employee belongs to assign different policies the result is ambiguous: Work Mode applies one, records a warning in Activity and you should remove one of the assignments.",
    href: ROUTES.policies,
    linkLabel: "Policies",
  },
  {
    id: "rota-changes",
    question: "What if the rota changes after shifts are already on phones?",
    answer:
      "Edit the shift or import the rota again. Each phone fetches changes on its next sync, which a silent push triggers within minutes while it is online, and otherwise at its next check-in or when the app is opened.",
    href: ROUTES.schedule,
    linkLabel: "Schedule",
  },
  {
    id: "employee-turns-off",
    question: "Can an employee just turn it off?",
    answer:
      "Yes. Screen Time access can be revoked at any time in iOS Settings, and the app can leave the workplace. The dashboard then shows that the device needs attention; it never shows what the employee did instead. Work Mode makes agreed rules effortless to follow, it does not enforce them against someone's will.",
  },
  {
    id: "override",
    question: "How do I lift restrictions for someone right now?",
    answer:
      "Open the employee and create a manager override: end Work Mode early, exempt them temporarily or apply an emergency exception. Overrides have a duration and a reason, and they are recorded in the audit log.",
    href: ROUTES.employees,
    linkLabel: "Employees",
  },
  {
    id: "integrations",
    question: "Can I connect my rota software?",
    answer:
      "Rota integrations (Planday, Deputy, 7shifts, When I Work, Rotaready and Homebase) are coming soon; you can ask to be notified on the Integrations page. CSV import works today and checks every row before anything is saved.",
    href: ROUTES.integrations,
    linkLabel: "Integrations",
  },
  {
    id: "billing",
    question: "How is Work Mode billed?",
    answer:
      "Per organisation, on a monthly plan sized by employees, locations and integrations. There are no card payments in the dashboard yet: plans are set up and changed with our team.",
    href: ROUTES.billing,
    linkLabel: "Billing",
  },
];

/**
 * The iOS onboarding steps, exactly as `OnboardingViewModel.Step` enumerates them in
 * apps/ios/WorkModeApp/Onboarding/OnboardingViewModel.swift. `help-content.test.ts` pins the list.
 */
export const IOS_ONBOARDING_STEP_KEYS = [
  "welcome",
  "name",
  "joinWorkplace",
  "confirmIdentity",
  "screenTimeExplained",
  "authorise",
  "chooseApps",
  "confirmPolicy",
] as const;
export type IosOnboardingStepKey = (typeof IOS_ONBOARDING_STEP_KEYS)[number];

export interface SetupStep {
  readonly key: IosOnboardingStepKey;
  /** Screen name as the employee sees it in the app. */
  readonly screen: string;
  readonly title: string;
  readonly detail: string;
  /** What the manager can do to help at this step. */
  readonly managerTip?: string;
}

export const SETUP_STEPS: readonly SetupStep[] = [
  {
    key: "welcome",
    screen: "Welcome",
    title: "Open Work Mode",
    detail:
      "The first screen explains that their employer uses Work Mode to reduce phone distractions while they're working, and summarises what managers can and cannot see.",
  },
  {
    key: "name",
    screen: "Your name",
    title: "Enter their name",
    detail: "First and last name, exactly as you entered them in Employees, so the app can find their record.",
    managerTip: "Check the spelling on the employee's record matches the name they go by.",
  },
  {
    key: "joinWorkplace",
    screen: "Join workplace",
    title: "Enter the company code",
    detail:
      "The company join code from Settings. If more than one employee shares their name, they tap \"I have an employee code\" and enter the personal invite code too.",
    managerTip: "Share the join code from Settings or the top bar; send a personal invite when names clash.",
  },
  {
    key: "confirmIdentity",
    screen: "Confirm identity",
    title: "Confirm it's them",
    detail: "The app shows the matched name and workplace and asks them to confirm before connecting the phone.",
  },
  {
    key: "screenTimeExplained",
    screen: "Screen Time explained",
    title: "Learn what Screen Time access means",
    detail:
      "A plain explanation that iOS will ask to allow Work Mode to use Screen Time, that it only blocks apps during shifts, and that access can be turned off at any time in Settings › Screen Time.",
  },
  {
    key: "authorise",
    screen: "Allow Screen Time",
    title: "Approve the iOS prompt",
    detail:
      "iOS shows its own Screen Time permission dialog. Approving it lets the app apply shields; declining leaves the phone connected but shows \"Permissions missing\" on your dashboard.",
    managerTip: "If someone declines by mistake they can approve later from the app's Settings screen.",
  },
  {
    key: "chooseApps",
    screen: "Choose apps",
    title: "Pick what to pause during shifts",
    detail:
      "Apple's picker lets them choose categories and specific apps. The choice stays on the iPhone as opaque tokens; the dashboard only ever shows how many were picked.",
  },
  {
    key: "confirmPolicy",
    screen: "Your Work Policy",
    title: "Review the Work Policy",
    detail:
      "A summary of what is blocked during shifts, what is always allowed and how breaks work under your Work Policy and Break Rules. Once confirmed, setup is complete and the status badge turns to Ready.",
    managerTip: "Publish a Work Policy first; until then the app says one will apply automatically once published.",
  },
];

export interface IosScreen {
  readonly name: string;
  readonly detail: string;
}

/** The app's main tabs after setup, by their navigation titles. */
export const IOS_MAIN_SCREENS: readonly IosScreen[] = [
  {
    name: "Work Mode",
    detail: "Home: the current state (Off shift, Starting soon, Working, On break…), the next shift and when the phone last synced.",
  },
  { name: "Schedule", detail: "Today's and upcoming shifts, as synced from your rota." },
  {
    name: "Settings",
    detail: "Privacy (the same can / cannot see lists as this page), Help, Screen Time status and Leave Workplace.",
  },
];

const HOUR_MS = 60 * 60 * 1000;
const syncDelayedOnShiftHours = DEVICE_STATUS_THRESHOLDS.syncDelayedOnShiftMs / HOUR_MS;
const syncDelayedOffShiftHours = DEVICE_STATUS_THRESHOLDS.syncDelayedOffShiftMs / HOUR_MS;
const offlineHours = DEVICE_STATUS_THRESHOLDS.offlineMs / HOUR_MS;
const clockSkewMinutes = DEVICE_STATUS_THRESHOLDS.clockSkewSeconds / 60;

export interface TroubleshootingItem {
  readonly id: string;
  readonly title: string;
  /** The dashboard badge this problem shows as, when it maps to one. */
  readonly badge: DeviceStatusBadge | null;
  readonly symptom: string;
  readonly cause: string;
  readonly steps: readonly string[];
}

export const TROUBLESHOOTING: readonly TroubleshootingItem[] = [
  {
    id: "permission-revoked",
    title: "Screen Time permission revoked or never approved",
    badge: "PERMISSIONS_MISSING",
    symptom: "The employee shows \"Permissions missing\" and Work Mode does not switch on at the start of their shift.",
    cause:
      "Screen Time access was declined during setup or turned off later in iOS Settings, or no apps have been selected yet. Without it the app cannot apply shields.",
    steps: [
      "Ask the employee to open Work Mode › Settings and tap the Screen Time prompt, or go to iOS Settings › Screen Time and allow Work Mode.",
      "If they never chose what to pause, they can do that from the same Settings screen.",
      "The badge updates on the phone's next sync; opening the app forces one.",
    ],
  },
  {
    id: "sync-delayed",
    title: "Sync delayed",
    badge: "SYNC_DELAYED",
    symptom: `The device shows "Sync delayed": it hasn't checked in for over ${syncDelayedOnShiftHours} hours during a shift, or over ${syncDelayedOffShiftHours} hours otherwise. After ${offlineHours} hours it shows as Offline.`,
    cause:
      "The phone has been off, out of coverage or in Low Power Mode, or iOS has not woken the app in the background. Shifts already on the phone still run on time; what's delayed is the status you see and any rota changes reaching the phone.",
    steps: [
      "Ask the employee to open the app once; it syncs immediately.",
      "Check the phone has a data connection and that Background App Refresh is on for Work Mode.",
      "If the badge persists for days the app may have been deleted: the device can be deactivated from its page and the employee re-invited.",
    ],
  },
  {
    id: "clock-skew",
    title: "Device clock out of sync",
    badge: "NEEDS_ATTENTION",
    symptom: `Breaks or shift times look shifted, or the device is flagged for attention because its clock is more than ${clockSkewMinutes} minutes away from server time.`,
    cause:
      "The phone's date and time are set manually or wrong. Shifts start and end by the phone's clock, so a skewed clock starts Work Mode early or late. The server records the difference and adjusts break timestamps it receives.",
    steps: [
      "Ask the employee to turn on iOS Settings › General › Date & Time › Set Automatically.",
      "Have them open the app so it syncs with the corrected clock.",
      "If a break was logged at the wrong time, the Activity feed shows the server-adjusted time.",
    ],
  },
];

export const SUPPORT = {
  email: SITE.supportEmail,
  subject: "Work Mode support",
  hours: "Replies within one working day.",
  include: ["Your organisation name", "The employee or shift affected (no need to include personal details)", "What you expected and what happened"],
} as const;
