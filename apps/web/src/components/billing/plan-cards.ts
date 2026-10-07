import type { Plan } from "@clockoff/shared/enums";
import {
  PLAN_CONFIG,
  PLAN_LIMIT_METRICS,
  PLAN_ORDER,
  UNLIMITED,
  limitFeatureLines,
  type LimitValue,
  type PlanLimitMetric,
} from "@clockoff/shared/plans";
import { SITE } from "@/config/site";

/**
 * Pure helpers for the plan cards on Billing and the marketing pricing page. Prices, limits and features come
 * from `PLAN_CONFIG` (@clockoff/shared) so the two pages and plan enforcement can never disagree.
 */

export type PlanCardCta = "current" | "upgrade" | "downgrade" | "contact-sales";

/** What the card's button should offer relative to the organisation's current plan. */
export function planCardCta(plan: Plan, currentPlan: Plan): PlanCardCta {
  if (plan === currentPlan) return "current";
  if (plan === "ENTERPRISE") return "contact-sales";
  return PLAN_ORDER.indexOf(plan) > PLAN_ORDER.indexOf(currentPlan) ? "upgrade" : "downgrade";
}

export const PLAN_CTA_LABELS: Record<PlanCardCta, string> = {
  current: "Current plan",
  upgrade: "Upgrade",
  downgrade: "Downgrade",
  "contact-sales": "Contact sales",
};

/** Self-serve plan changes are not built yet; every plan change goes through sales. */
export const PLAN_CHANGE_COMING_SOON = "Coming soon";

export type PlanLimitKey = PlanLimitMetric | "analytics";

export const PLAN_LIMIT_KEYS: readonly PlanLimitKey[] = [...PLAN_LIMIT_METRICS, "analytics"];

export const PLAN_LIMIT_TITLES: Record<PlanLimitKey, string> = {
  employees: "Employees",
  locations: "Locations",
  integrations: "Rota integrations",
  analytics: "Compliance analytics",
};

export interface PlanLimitLine {
  readonly key: PlanLimitKey;
  readonly label: string;
  readonly value: string;
  /** False when the plan has none of this (0 or analytics off). */
  readonly included: boolean;
}

/** `25` → "Up to 25", `1` → "1", UNLIMITED → "Unlimited", `0` → "Not included". */
export function formatPlanLimitValue(metric: PlanLimitMetric, value: LimitValue): string {
  const suffix = metric === "integrations" ? " (coming soon)" : "";
  if (value === UNLIMITED) return `Unlimited${suffix}`;
  if (value === 0) return "Not included";
  if (value === 1) return `1${suffix}`;
  return `Up to ${value}${suffix}`;
}

/** The four limit rows shown on every plan card, in a fixed order. */
export function planLimitLines(plan: Plan): PlanLimitLine[] {
  const { limits } = PLAN_CONFIG[plan];
  const lines: PlanLimitLine[] = PLAN_LIMIT_METRICS.map((metric) => ({
    key: metric,
    label: PLAN_LIMIT_TITLES[metric],
    value: formatPlanLimitValue(metric, limits[metric]),
    included: limits[metric] !== 0,
  }));
  lines.push({
    key: "analytics",
    label: PLAN_LIMIT_TITLES.analytics,
    value: limits.analytics ? "Included" : "Not included",
    included: limits.analytics,
  });
  return lines;
}

/** Feature bullets that are not already expressed by the limit rows (e.g. "Priority support"). */
export function planHighlights(plan: Plan): string[] {
  const { features, limits } = PLAN_CONFIG[plan];
  const generated = new Set(limitFeatureLines(limits));
  return features.filter((feature) => !generated.has(feature));
}

/** Pre-filled email to the team that sets plans up (billing has no self-serve checkout yet). */
export function salesMailto(subject: string, body?: string): string {
  const params = new URLSearchParams({ subject });
  if (body) params.set("body", body);
  return `mailto:${SITE.supportEmail}?${params.toString().replace(/\+/g, "%20")}`;
}
