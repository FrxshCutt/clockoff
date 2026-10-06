import type { WorkModeState } from "@workmode/shared/enums";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  CalendarClock,
  Coffee,
  KeyRound,
  MapPin,
  Plug,
  ShieldCheck,
  ShoppingBag,
  Smartphone,
  UtensilsCrossed,
  Warehouse,
} from "lucide-react";
import { ROUTES } from "@/config/navigation";
import { SITE } from "@/config/site";

/** Routes, navigation and copy for the public marketing site (`app/(marketing)`). Plain data, unit-tested. */

export const MARKETING_ROUTES = {
  home: "/",
  product: "/product",
  howItWorks: "/how-it-works",
  forBusinesses: "/for-businesses",
  pricing: "/pricing",
  privacy: "/privacy",
  requestDemo: "/request-demo",
} as const;
export type MarketingRoute = (typeof MARKETING_ROUTES)[keyof typeof MARKETING_ROUTES];

export interface MarketingNavItem {
  readonly label: string;
  readonly href: MarketingRoute;
}

export const MARKETING_NAV: readonly MarketingNavItem[] = [
  { label: "Product", href: MARKETING_ROUTES.product },
  { label: "How it works", href: MARKETING_ROUTES.howItWorks },
  { label: "For businesses", href: MARKETING_ROUTES.forBusinesses },
  { label: "Pricing", href: MARKETING_ROUTES.pricing },
  { label: "Privacy", href: MARKETING_ROUTES.privacy },
];

export const MARKETING_CTA = {
  primary: { label: "Request a demo", href: MARKETING_ROUTES.requestDemo },
  login: { label: "Log in", href: ROUTES.login },
} as const;

export const HERO = {
  headline: SITE.tagline,
  subheadline: "Your rota manages when your team works. We make sure their phones know they're working too.",
  privacyLine: SITE.privacyLine,
  secondaryCta: { label: "See how it works", href: MARKETING_ROUTES.howItWorks },
  platformNote: "For iPhone (iOS 16.4 or later), built on Apple Screen Time.",
} as const;

export interface Step {
  readonly title: string;
  readonly body: string;
}

export const HOW_IT_WORKS_STRIP: readonly Step[] = [
  {
    title: "Set a Work Policy",
    body: "Pick the app categories that should pause during shifts, such as social media, games and streaming, and how breaks relax them.",
  },
  {
    title: "Employees connect their iPhone",
    body: "They install Work Mode, enter your company code and approve Screen Time access. Their app choices stay on their phone.",
  },
  {
    title: "Shifts do the rest",
    body: "Work Mode switches on when a scheduled shift starts, eases off for breaks and switches off when the shift ends. Nobody has to remember.",
  },
];

export interface Feature {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly body: string;
}

export const FEATURES: readonly Feature[] = [
  {
    icon: ShieldCheck,
    title: "Work Policies",
    body: "Choose restricted categories once. Assign a policy to the whole organisation, a location, a team or one person; the most specific wins.",
  },
  {
    icon: Coffee,
    title: "Break Rules that match your floor",
    body: "How long, how many, how soon after the shift starts and what relaxes during a break. Breaks end on time without a manager watching the clock.",
  },
  {
    icon: CalendarClock,
    title: "Scheduling and CSV import",
    body: "Add shifts, repeat them, or upload the rota you already have. Every row is checked before anything is saved.",
  },
  {
    icon: Activity,
    title: "Live status, not surveillance",
    body: "See who is in Work Mode, on a break or needs attention. Never what anyone does on their phone.",
  },
  {
    icon: MapPin,
    title: "Locations and teams",
    body: "Sites with their own time zones and teams within them, so policies and rotas land on the right people at once.",
  },
  {
    icon: KeyRound,
    title: "Manager overrides with a paper trail",
    body: "End Work Mode early or exempt someone for a while, with a reason and a duration, recorded in the audit log.",
  },
  {
    icon: Plug,
    title: "Rota integrations (coming soon)",
    body: "Planday, Deputy, 7shifts, When I Work, Rotaready and Homebase, following either the schedule or clock-in events.",
  },
  {
    icon: Smartphone,
    title: "Built on Apple Screen Time",
    body: "Enforcement happens on the phone with Apple's own frameworks. No MDM, no company-owned device required.",
  },
];

export interface FlowStep {
  readonly key: string;
  readonly title: string;
  readonly body: string;
  /** The Work Mode state the phone is in at this point, when there is one. */
  readonly state: WorkModeState | null;
  readonly actor: "Manager" | "Employee" | "Work Mode";
}

/** The end-to-end flow on the How it works page, in order. */
export const FLOW: readonly FlowStep[] = [
  {
    key: "policy",
    actor: "Manager",
    title: "Create a Work Policy and Break Rules",
    body: "Decide which categories pause during shifts and how breaks behave. Publish the policy so phones can receive it.",
    state: null,
  },
  {
    key: "connect",
    actor: "Employee",
    title: "Connect the phone",
    body: "The employee installs Work Mode, enters the company code and their name, approves Screen Time and chooses what to pause. The choice never leaves the phone.",
    state: null,
  },
  {
    key: "schedule",
    actor: "Manager",
    title: "Schedule shifts",
    body: "Add shifts or import the rota. Each phone syncs its own upcoming shifts and the policy that applies to it.",
    state: "OFF_SHIFT",
  },
  {
    key: "starting",
    actor: "Work Mode",
    title: "Shift starts",
    body: "Shortly before the start the app shows a heads-up. At the start time the phone's own Screen Time schedule fires, even if the app is closed.",
    state: "SHIFT_STARTING_SOON",
  },
  {
    key: "shields",
    actor: "Work Mode",
    title: "Shields go up",
    body: "Restricted apps show a shield explaining that Work Mode is on. Calls, messages and anything not in the policy keep working.",
    state: "WORKING",
  },
  {
    key: "break",
    actor: "Employee",
    title: "Break",
    body: "The employee starts a break in the app, within the Break Rules, or a scheduled break begins. Restrictions relax as the rules allow.",
    state: "ON_BREAK",
  },
  {
    key: "restore",
    actor: "Work Mode",
    title: "Back to work",
    body: "When the break ends, shields return automatically. Breaks that run long end themselves.",
    state: "WORKING",
  },
  {
    key: "end",
    actor: "Work Mode",
    title: "Shift ends",
    body: "Every shield lifts at the scheduled end. Off shift, the phone is the employee's own again and the app only checks in for schedule changes.",
    state: "OFF_SHIFT",
  },
];

export interface UseCase {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly headline: string;
  readonly pains: readonly string[];
  readonly outcome: string;
}

export const USE_CASES: readonly UseCase[] = [
  {
    icon: UtensilsCrossed,
    title: "Hospitality",
    headline: "Full attention at the pass, the bar and the tables.",
    pains: [
      "Phones out during service slow the pass and the floor.",
      "Split shifts and late changes make 'no phones' rules impossible to police fairly.",
      "Breaks drift when nobody is tracking them.",
    ],
    outcome: "Work Mode follows the rota you already write, relaxes for the breaks you allow, and treats every shift the same way without a manager playing phone police.",
  },
  {
    icon: ShoppingBag,
    title: "Retail",
    headline: "Present on the shop floor, not on a feed.",
    pains: [
      "Customers notice staff on phones before managers do.",
      "Multiple stores mean multiple local rules and time zones.",
      "Part-time rotas change weekly.",
    ],
    outcome: "Assign a policy per store or team, import each week's rota, and let shifts switch Work Mode on and off. Head office sees status, never screens.",
  },
  {
    icon: Warehouse,
    title: "Warehouse and logistics",
    headline: "Fewer distractions where safety matters.",
    pains: [
      "Phones near forklifts, conveyors and loading bays are a safety risk.",
      "Shift patterns run around the clock, including overnight.",
      "Agency and seasonal staff need a setup that takes minutes.",
    ],
    outcome: "Overnight and rotating shifts are handled by the rota itself. New starters join with a company code in minutes, and leave just as easily.",
  },
];

export interface ProductSection {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly points: readonly string[];
}

export const PRODUCT_SECTIONS: readonly ProductSection[] = [
  {
    id: "policies",
    title: "Work Policies and Break Rules",
    body: "A Work Policy says what pauses during shifts; Break Rules say how breaks behave. Both are reusable and versioned, so a change rolls out to every phone it applies to.",
    points: [
      "Restrict categories such as social media, games, entertainment, streaming, video, shopping and dating.",
      "Optionally let employees add specific apps from their own phone; you only ever see how many.",
      "Break length, breaks per shift, minimum gap, and whether everything, some categories or nothing relaxes.",
      "Precedence that is easy to reason about: employee, then team, then location, then organisation default.",
    ],
  },
  {
    id: "scheduling",
    title: "Scheduling that fits the rota you have",
    body: "Create shifts by local time in each location's zone, repeat them, or import a CSV and fix problems before anything is saved.",
    points: [
      "Overnight shifts, daylight-saving changes and multiple time zones handled correctly.",
      "CSV import with column mapping, employee matching and a downloadable errors file.",
      "Rota integrations coming soon for Planday, Deputy, 7shifts, When I Work, Rotaready and Homebase.",
    ],
  },
  {
    id: "status",
    title: "Live status, honestly scoped",
    body: "The overview shows who should be in Work Mode and whether their phone agrees. Each badge is derived from a short list of operational signals, and nothing else.",
    points: [
      "Ready, Working, On break, Permissions missing, Sync delayed, Offline, Needs attention.",
      "An activity feed of operational events with timestamps and no free text.",
      "Manager overrides and every change you make are recorded in the audit log.",
    ],
  },
  {
    id: "people",
    title: "Employees, locations and teams",
    body: "Add people once, group them by site and team, and invite them with a company code. Deactivate anyone in one click when they leave.",
    points: [
      "Company join code plus personal invite codes when names clash.",
      "Locations with their own time zones; teams that can sit within a location.",
      "Owner, admin and manager roles for the dashboard, each with the right permissions.",
    ],
  },
];

export interface PricingFaq {
  readonly question: string;
  readonly answer: string;
}

export const PRICING_FAQ: readonly PricingFaq[] = [
  {
    question: "How do I start?",
    answer: "Request a demo. We'll set up your organisation on the right plan with you; there's no card to enter and no self-serve checkout yet.",
  },
  {
    question: "What counts as an employee?",
    answer: "Anyone on your employee list who is active. Deactivated and archived employees don't count towards the limit.",
  },
  {
    question: "Do employees need a company phone?",
    answer: "No. Work Mode runs on the employee's own iPhone with their consent, using Apple Screen Time. It needs iOS 16.4 or later.",
  },
  {
    question: "Can I change plan later?",
    answer: "Yes. Plan changes are handled by our team today; contact sales from the Billing page and we'll switch you the same day.",
  },
];

export interface PrivacyTechPoint {
  readonly title: string;
  readonly body: string;
}

/** How Work Mode uses Apple Screen Time, stated precisely. Mirrors the technical section of docs/PRIVACY.md. */
export const PRIVACY_TECH_POINTS: readonly PrivacyTechPoint[] = [
  {
    title: "Apple's Screen Time frameworks, nothing else",
    body: "The iOS app uses FamilyControls, ManagedSettings and DeviceActivity. They let an app shield apps, categories and websites on a schedule. They do not give the app message content, photos, notifications or browsing history.",
  },
  {
    title: "App choices are opaque tokens",
    body: "When an employee chooses what to shield, Apple's picker returns opaque tokens that can only be interpreted on the phone that created them. The app stores them in its on-device container; the server receives only the number of categories, apps and websites selected.",
  },
  {
    title: "Time-based schedules only",
    body: "Shields are applied and lifted by the app's DeviceActivity extension at the shift and break times synced to the phone. Work Mode registers no usage thresholds and ships no activity-report extension, so it never learns which apps were used or for how long.",
  },
  {
    title: "Enforcement is local",
    body: "The server never controls the phone. It supplies the schedule and policy, may send a silent push asking the app to sync, and receives the resulting engine state.",
  },
  {
    title: "Everything managers see is derived from a short allow-list",
    body: "The mobile API accepts only the fields listed below, by exact name, and rejects anything else. The dashboard combines those fields with the employer's own shifts, policies and break rules.",
  },
];

export const PRIVACY_DATA_HANDLING: readonly string[] = [
  "Push tokens and workforce-integration credentials are encrypted at rest with AES-256-GCM.",
  "Audit logs record what managers do (who changed a policy, who created an override), not what employees do on their phones.",
  "Leaving the workplace from the app removes Work Mode's shields and schedules from the phone and deletes its local copy of the schedule. A manager deactivating an employee or device revokes that device's access, so it can no longer sync.",
  "Employees can revoke Screen Time access at any time in iOS Settings. The dashboard then shows that the device needs attention, and nothing more.",
];

export interface FooterGroup {
  readonly title: string;
  readonly links: readonly { readonly label: string; readonly href: string; readonly external?: boolean }[];
}

export const FOOTER_GROUPS: readonly FooterGroup[] = [
  {
    title: "Product",
    links: [
      { label: "Product", href: MARKETING_ROUTES.product },
      { label: "How it works", href: MARKETING_ROUTES.howItWorks },
      { label: "For businesses", href: MARKETING_ROUTES.forBusinesses },
      { label: "Pricing", href: MARKETING_ROUTES.pricing },
    ],
  },
  {
    title: "Trust",
    links: [
      { label: "Privacy", href: MARKETING_ROUTES.privacy },
      { label: "Request a demo", href: MARKETING_ROUTES.requestDemo },
    ],
  },
  {
    title: "Account",
    links: [
      { label: "Log in", href: ROUTES.login },
      { label: "Create your workspace", href: ROUTES.register },
      { label: `Support: ${SITE.supportEmail}`, href: `mailto:${SITE.supportEmail}`, external: true },
    ],
  },
];
