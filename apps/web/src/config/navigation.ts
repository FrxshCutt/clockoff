import type { LucideIcon } from "lucide-react";
import {
  Activity,
  CalendarClock,
  Coffee,
  CreditCard,
  LayoutDashboard,
  LifeBuoy,
  MapPin,
  Plug,
  Settings,
  ShieldCheck,
  Users,
} from "lucide-react";

/**
 * Single source of truth for dashboard routes, sidebar navigation and breadcrumb labels. Pages, links and
 * redirects import `ROUTES` instead of hard-coding paths.
 */
export const ROUTES = {
  home: "/",
  // auth
  login: "/login",
  register: "/register",
  forgotPassword: "/forgot-password",
  resetPassword: "/reset-password",
  verifyEmail: "/verify-email",
  acceptInvite: "/accept-invite",
  createOrganisation: "/create-organisation",
  // dashboard
  overview: "/overview",
  employees: "/employees",
  schedule: "/schedule",
  scheduleImport: "/schedule/import",
  policies: "/policies",
  policyNew: "/policies/new",
  breakRules: "/break-rules",
  breakRuleNew: "/break-rules/new",
  integrations: "/integrations",
  activity: "/activity",
  locations: "/locations",
  settings: "/settings",
  billing: "/billing",
  help: "/help",
  devices: "/devices",
  auditLogs: "/audit-logs",
} as const;

export type AppRoute = (typeof ROUTES)[keyof typeof ROUTES];

const RESOURCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every dashboard resource id is a UUID; detail routes 404 for anything else instead of calling the API. */
export function isResourceId(value: string | null | undefined): value is string {
  return typeof value === "string" && RESOURCE_ID_PATTERN.test(value);
}

export const routeFor = {
  employee: (id: string) => `${ROUTES.employees}/${encodeURIComponent(id)}`,
  policy: (id: string) => `${ROUTES.policies}/${encodeURIComponent(id)}`,
  breakRule: (id: string) => `${ROUTES.breakRules}/${encodeURIComponent(id)}`,
  device: (id: string) => `${ROUTES.devices}/${encodeURIComponent(id)}`,
  settingsTab: (tab: string) => `${ROUTES.settings}?tab=${encodeURIComponent(tab)}`,
} as const;

export interface NavItem {
  readonly title: string;
  readonly href: AppRoute;
  readonly icon: LucideIcon;
  /** Short hint for tooltips (collapsed sidebar) and screen readers. */
  readonly description: string;
}

export interface NavSection {
  readonly id: string;
  readonly label: string;
  readonly items: readonly NavItem[];
}

export const NAV_SECTIONS: readonly NavSection[] = [
  {
    id: "workspace",
    label: "Workspace",
    items: [
      { title: "Overview", href: ROUTES.overview, icon: LayoutDashboard, description: "Live status and setup progress" },
      { title: "Employees", href: ROUTES.employees, icon: Users, description: "People, invites and devices" },
      { title: "Schedule", href: ROUTES.schedule, icon: CalendarClock, description: "Shifts and rota imports" },
      { title: "Policies", href: ROUTES.policies, icon: ShieldCheck, description: "What is restricted during shifts" },
      { title: "Break Rules", href: ROUTES.breakRules, icon: Coffee, description: "How breaks relax restrictions" },
    ],
  },
  {
    id: "operations",
    label: "Operations",
    items: [
      { title: "Integrations", href: ROUTES.integrations, icon: Plug, description: "Connect rota software" },
      { title: "Activity", href: ROUTES.activity, icon: Activity, description: "What happened, and when" },
      { title: "Locations & Teams", href: ROUTES.locations, icon: MapPin, description: "Sites and teams" },
    ],
  },
  {
    id: "organisation",
    label: "Organisation",
    items: [
      { title: "Settings", href: ROUTES.settings, icon: Settings, description: "Organisation, join code and managers" },
      { title: "Billing", href: ROUTES.billing, icon: CreditCard, description: "Plan and invoices" },
      { title: "Help", href: ROUTES.help, icon: LifeBuoy, description: "Guides and support" },
    ],
  },
];

export const NAV_ITEMS: readonly NavItem[] = NAV_SECTIONS.flatMap((section) => section.items);

/** Labels for every static dashboard path segment (used by breadcrumbs and page titles). */
export const SEGMENT_LABELS: Readonly<Record<string, string>> = {
  overview: "Overview",
  employees: "Employees",
  schedule: "Schedule",
  import: "Import",
  policies: "Policies",
  "break-rules": "Break Rules",
  integrations: "Integrations",
  activity: "Activity",
  locations: "Locations & Teams",
  settings: "Settings",
  billing: "Billing",
  help: "Help",
  devices: "Devices",
  "audit-logs": "Audit Log",
  new: "New",
};

/** Label used for dynamic segments (ids) unless a page registers a better one. */
export const DETAIL_SEGMENT_LABEL = "Details";

/** Paths outside the dashboard shell that never require an organisation. */
export const AUTH_ROUTES: readonly string[] = [
  ROUTES.login,
  ROUTES.register,
  ROUTES.forgotPassword,
  ROUTES.resetPassword,
  ROUTES.verifyEmail,
  ROUTES.acceptInvite,
  ROUTES.createOrganisation,
];

/** Whether `href` should be highlighted for `pathname` (exact match or a descendant path). */
export function isNavItemActive(pathname: string | null | undefined, href: string): boolean {
  if (!pathname) return false;
  const path = stripTrailingSlash(pathname.split(/[?#]/)[0] ?? "");
  const target = stripTrailingSlash(href);
  return path === target || path.startsWith(`${target}/`);
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

export function getActiveNavItem(pathname: string | null | undefined): NavItem | undefined {
  // Longest match wins so nested routes never highlight a shorter sibling.
  return [...NAV_ITEMS]
    .sort((a, b) => b.href.length - a.href.length)
    .find((item) => isNavItemActive(pathname, item.href));
}

export interface Crumb {
  readonly label: string;
  readonly href: string;
  /** The raw path segment (useful for dynamic labels). */
  readonly segment: string;
  readonly isDynamic: boolean;
}

/**
 * Breadcrumbs for a dashboard path: `/employees/abc` → Employees › Details. `labels` overrides labels for
 * specific segments (e.g. an employee's name for their id).
 */
export function getBreadcrumbs(pathname: string, labels: Readonly<Record<string, string>> = {}): Crumb[] {
  const segments = (pathname.split(/[?#]/)[0] ?? "").split("/").filter(Boolean);
  const crumbs: Crumb[] = [];
  let href = "";
  for (const raw of segments) {
    href += `/${raw}`;
    let segment = raw;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      // keep the raw segment
    }
    const known = SEGMENT_LABELS[segment];
    crumbs.push({
      segment,
      href,
      isDynamic: known === undefined,
      label: labels[segment] ?? known ?? DETAIL_SEGMENT_LABEL,
    });
  }
  return crumbs;
}

/**
 * True for a same-origin absolute path (`/employees?x=1`): no protocol-relative `//evil.com`, no backslash
 * tricks, no control characters. Use before rendering a link whose href comes from data.
 */
export function isInternalPath(href: string | null | undefined): href is string {
  if (!href || typeof href !== "string") return false;
  if (!href.startsWith("/") || href.startsWith("//")) return false;
  return !hasControlCharsOrBackslash(href);
}

/**
 * Validates a post-login `next` parameter: only same-origin absolute paths are allowed (see `isInternalPath`),
 * and never an auth page that would loop.
 */
export function safeRedirectPath(next: string | null | undefined): string | null {
  if (!isInternalPath(next)) return null;
  const path = next.split(/[?#]/)[0] ?? "";
  if (AUTH_ROUTES.some((route) => route !== ROUTES.acceptInvite && (path === route || path.startsWith(`${route}/`)))) {
    return null;
  }
  return next;
}

function hasControlCharsOrBackslash(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

/** Where to send a manager after sign-in / sign-up. */
export function getPostAuthRedirect(input: { organisationCount: number; next?: string | null }): string {
  if (input.organisationCount === 0) {
    const next = safeRedirectPath(input.next);
    // Accepting an invite creates the membership, so let that flow continue.
    if (next?.startsWith(ROUTES.acceptInvite)) return next;
    return ROUTES.createOrganisation;
  }
  return safeRedirectPath(input.next) ?? ROUTES.overview;
}

/** `/login?next=/employees%3Fq%3Dx` for the current location. */
export function loginRedirectUrl(currentPath: string | null | undefined): string {
  const next = safeRedirectPath(currentPath);
  return next && next !== ROUTES.overview ? `${ROUTES.login}?next=${encodeURIComponent(next)}` : ROUTES.login;
}
