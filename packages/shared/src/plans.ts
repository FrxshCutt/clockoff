import type { Plan } from "./enums";
import { PLANS } from "./enums";

/**
 * Plan configuration keyed by the `Plan` enum. Prices and limits are placeholders for the MVP; billing
 * enforcement reads them through `planLimitsFor` / `isWithinLimit`, and the billing/pricing pages render
 * `PLAN_CONFIG`, so a change here is a change everywhere.
 *
 * Named `PLAN_CONFIG` (not `PLANS`) because `PLANS` is already the enum value list exported from `./enums`
 * and both modules are re-exported from the package barrel.
 *
 * The limit lines in each plan's `features` are generated from its `limits` so copy and enforcement cannot
 * drift. Workforce integrations are listed as "coming soon" while every provider is a ComingSoonProvider.
 */

/** Sentinel for "no limit". A string (not Infinity) so it survives JSON serialisation to the dashboard. */
export const UNLIMITED = "UNLIMITED" as const;
export type LimitValue = number | typeof UNLIMITED;

export interface PlanLimits {
  readonly employees: LimitValue;
  readonly locations: LimitValue;
  readonly integrations: LimitValue;
  readonly analytics: boolean;
  readonly auditLogRetentionDays: number;
}

export interface PlanDefinition {
  readonly name: string;
  readonly priceLabel: string;
  readonly limits: PlanLimits;
  readonly features: readonly string[];
}

/** Numeric limits that `isWithinLimit` can check. */
export const PLAN_LIMIT_METRICS = ["employees", "locations", "integrations"] as const;
export type PlanLimitMetric = (typeof PLAN_LIMIT_METRICS)[number];

export const PLAN_LIMIT_LABELS: Record<
  PlanLimitMetric,
  { readonly singular: string; readonly plural: string }
> = {
  employees: { singular: "employee", plural: "employees" },
  locations: { singular: "location", plural: "locations" },
  integrations: { singular: "workforce integration", plural: "workforce integrations" },
};

function countPhrase(metric: PlanLimitMetric, limit: LimitValue): string {
  const { singular, plural } = PLAN_LIMIT_LABELS[metric];
  if (limit === UNLIMITED) return `Unlimited ${plural}`;
  if (limit === 1) return `1 ${singular}`;
  return `Up to ${limit} ${plural}`;
}

function retentionPhrase(days: number): string {
  if (days % 365 === 0) {
    const years = days / 365;
    return `${years}-year audit log`;
  }
  return `${days}-day audit log`;
}

/** The feature lines implied by a plan's limits, in display order. */
export function limitFeatureLines(limits: PlanLimits): string[] {
  const lines = [
    countPhrase("employees", limits.employees),
    countPhrase("locations", limits.locations),
  ];
  if (limits.integrations !== 0)
    lines.push(`${countPhrase("integrations", limits.integrations)} (coming soon)`);
  if (limits.analytics) lines.push("Compliance analytics");
  lines.push(retentionPhrase(limits.auditLogRetentionDays));
  return lines;
}

function definePlan(
  name: string,
  priceLabel: string,
  limits: PlanLimits,
  extraFeatures: readonly string[],
): PlanDefinition {
  return { name, priceLabel, limits, features: [...limitFeatureLines(limits), ...extraFeatures] };
}

export const PLAN_CONFIG: Record<Plan, PlanDefinition> = {
  STARTER: definePlan(
    "Starter",
    "£49 / month",
    { employees: 25, locations: 1, integrations: 0, analytics: false, auditLogRetentionDays: 30 },
    [
      "Work Policies and Break Rules",
      "Shift scheduling and CSV import",
      "Company join code and employee invites",
      "Live device status",
    ],
  ),
  BUSINESS: definePlan(
    "Business",
    "£149 / month",
    { employees: 100, locations: 5, integrations: 1, analytics: true, auditLogRetentionDays: 90 },
    ["Everything in Starter"],
  ),
  PRO: definePlan(
    "Pro",
    "£349 / month",
    { employees: 500, locations: 25, integrations: 3, analytics: true, auditLogRetentionDays: 365 },
    ["Everything in Business", "Priority support"],
  ),
  ENTERPRISE: definePlan(
    "Enterprise",
    "Contact us",
    {
      employees: UNLIMITED,
      locations: UNLIMITED,
      integrations: UNLIMITED,
      analytics: true,
      auditLogRetentionDays: 730,
    },
    ["Everything in Pro", "Dedicated onboarding", "Custom contract and invoicing"],
  ),
};

/** Plans ordered from smallest to largest, for upgrade comparisons. Mirrors the enum order. */
export const PLAN_ORDER: readonly Plan[] = PLANS;

export function planLimitsFor(plan: Plan): PlanLimits {
  return PLAN_CONFIG[plan].limits;
}

function assertCount(current: number): void {
  if (!Number.isInteger(current) || current < 0) {
    throw new RangeError(`Usage count must be a non-negative integer; got ${String(current)}`);
  }
}

/**
 * True when `current` of `metric` fits the plan (`current <= limit`). To ask "may I add one more?", pass the
 * count *after* the addition (`existing + 1`). Throws RangeError for a negative or non-integer count.
 */
export function isWithinLimit(plan: Plan, metric: PlanLimitMetric, current: number): boolean {
  assertCount(current);
  const limit = planLimitsFor(plan)[metric];
  if (limit === UNLIMITED) return true;
  return current <= limit;
}

/** How many more of `metric` the plan allows given `current` usage (never negative), or UNLIMITED. */
export function remainingCapacity(
  plan: Plan,
  metric: PlanLimitMetric,
  current: number,
): LimitValue {
  assertCount(current);
  const limit = planLimitsFor(plan)[metric];
  if (limit === UNLIMITED) return UNLIMITED;
  return Math.max(0, limit - current);
}

/** `true` when `plan` is the same as or higher than `minimum` in `PLAN_ORDER`. */
export function isPlanAtLeast(plan: Plan, minimum: Plan): boolean {
  return PLAN_ORDER.indexOf(plan) >= PLAN_ORDER.indexOf(minimum);
}

/** Human label for a limit value: `25` → "25", `UNLIMITED` → "Unlimited". */
export function formatLimit(limit: LimitValue): string {
  return limit === UNLIMITED ? "Unlimited" : String(limit);
}
