import { describe, expect, it } from "vitest";
import { PLANS } from "./enums";
import {
  PLAN_CONFIG,
  PLAN_LIMIT_LABELS,
  PLAN_LIMIT_METRICS,
  PLAN_ORDER,
  UNLIMITED,
  formatLimit,
  isPlanAtLeast,
  isWithinLimit,
  limitFeatureLines,
  planLimitsFor,
  remainingCapacity,
  type LimitValue,
} from "./plans";

const rank = (v: LimitValue) => (v === UNLIMITED ? Number.POSITIVE_INFINITY : v);

describe("PLAN_CONFIG", () => {
  it("defines every plan in the enum and nothing else", () => {
    expect(Object.keys(PLAN_CONFIG).sort()).toEqual([...PLANS].sort());
    expect(PLAN_ORDER).toEqual(PLANS);
    expect(Object.keys(PLAN_LIMIT_LABELS).sort()).toEqual([...PLAN_LIMIT_METRICS].sort());
  });

  it("every plan has a name, price label, sane limits and at least four unique features", () => {
    for (const plan of PLANS) {
      const def = PLAN_CONFIG[plan];
      expect(def.name.length).toBeGreaterThan(0);
      expect(def.priceLabel.length).toBeGreaterThan(0);
      expect(def.features.length).toBeGreaterThanOrEqual(4);
      expect(new Set(def.features).size).toBe(def.features.length);
      expect(def.limits.auditLogRetentionDays).toBeGreaterThan(0);
      expect(Number.isInteger(def.limits.auditLogRetentionDays)).toBe(true);
      for (const metric of PLAN_LIMIT_METRICS) {
        const limit = def.limits[metric];
        if (limit !== UNLIMITED) {
          expect(Number.isInteger(limit)).toBe(true);
          expect(limit).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("plan names are unique and match the enum ordering", () => {
    expect(PLANS.map((p) => PLAN_CONFIG[p].name)).toEqual([
      "Starter",
      "Business",
      "Pro",
      "Enterprise",
    ]);
  });

  it("limits never decrease as plans grow", () => {
    for (let i = 1; i < PLAN_ORDER.length; i++) {
      const lower = planLimitsFor(PLAN_ORDER[i - 1]!);
      const higher = planLimitsFor(PLAN_ORDER[i]!);
      for (const metric of PLAN_LIMIT_METRICS) {
        expect(
          rank(higher[metric]),
          `${metric}: ${PLAN_ORDER[i]} >= ${PLAN_ORDER[i - 1]}`,
        ).toBeGreaterThanOrEqual(rank(lower[metric]));
      }
      expect(higher.auditLogRetentionDays).toBeGreaterThanOrEqual(lower.auditLogRetentionDays);
      if (lower.analytics) expect(higher.analytics).toBe(true);
    }
  });

  it("Enterprise is unlimited on every numeric metric; analytics is on from Business up", () => {
    for (const metric of PLAN_LIMIT_METRICS)
      expect(planLimitsFor("ENTERPRISE")[metric]).toBe(UNLIMITED);
    expect(planLimitsFor("STARTER").analytics).toBe(false);
    expect(planLimitsFor("BUSINESS").analytics).toBe(true);
    expect(planLimitsFor("PRO").analytics).toBe(true);
    expect(planLimitsFor("ENTERPRISE").analytics).toBe(true);
  });

  it("feature copy is generated from the limits, so it cannot drift", () => {
    for (const plan of PLANS) {
      const def = PLAN_CONFIG[plan];
      expect(def.features.slice(0, limitFeatureLines(def.limits).length)).toEqual(
        limitFeatureLines(def.limits),
      );
    }
    expect(PLAN_CONFIG.STARTER.features).toContain("Up to 25 employees");
    expect(PLAN_CONFIG.STARTER.features).toContain("1 location");
    expect(PLAN_CONFIG.STARTER.features).toContain("30-day audit log");
    expect(PLAN_CONFIG.STARTER.features.some((f) => /integration/i.test(f))).toBe(false);
    expect(PLAN_CONFIG.STARTER.features).not.toContain("Compliance analytics");
    expect(PLAN_CONFIG.BUSINESS.features).toContain("1 workforce integration (coming soon)");
    expect(PLAN_CONFIG.PRO.features).toContain("1-year audit log");
    expect(PLAN_CONFIG.ENTERPRISE.features).toContain("Unlimited employees");
    expect(PLAN_CONFIG.ENTERPRISE.features).toContain("2-year audit log");
  });

  it("never advertises integrations without the coming-soon qualifier", () => {
    for (const plan of PLANS) {
      for (const f of PLAN_CONFIG[plan].features) {
        if (/integration/i.test(f)) expect(f).toMatch(/\(coming soon\)$/);
      }
    }
  });
});

describe("isWithinLimit", () => {
  it("is inclusive of the limit", () => {
    const limit = planLimitsFor("STARTER").employees as number;
    expect(isWithinLimit("STARTER", "employees", 0)).toBe(true);
    expect(isWithinLimit("STARTER", "employees", limit - 1)).toBe(true);
    expect(isWithinLimit("STARTER", "employees", limit)).toBe(true);
    expect(isWithinLimit("STARTER", "employees", limit + 1)).toBe(false);
  });

  it("supports the 'may I add one more?' idiom", () => {
    const atLimit = planLimitsFor("STARTER").locations as number;
    expect(isWithinLimit("STARTER", "locations", atLimit + 1)).toBe(false);
    expect(isWithinLimit("BUSINESS", "locations", atLimit + 1)).toBe(true);
  });

  it("zero-limit metrics allow zero and nothing more", () => {
    expect(planLimitsFor("STARTER").integrations).toBe(0);
    expect(isWithinLimit("STARTER", "integrations", 0)).toBe(true);
    expect(isWithinLimit("STARTER", "integrations", 1)).toBe(false);
  });

  it("unlimited always passes", () => {
    for (const metric of PLAN_LIMIT_METRICS) {
      expect(isWithinLimit("ENTERPRISE", metric, 0)).toBe(true);
      expect(isWithinLimit("ENTERPRISE", metric, 1_000_000)).toBe(true);
    }
  });

  it("checks every plan × metric at the boundary", () => {
    for (const plan of PLANS) {
      for (const metric of PLAN_LIMIT_METRICS) {
        const limit = planLimitsFor(plan)[metric];
        if (limit === UNLIMITED) continue;
        expect(isWithinLimit(plan, metric, limit), `${plan}/${metric}`).toBe(true);
        expect(isWithinLimit(plan, metric, limit + 1), `${plan}/${metric}`).toBe(false);
      }
    }
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid count %s", (count) => {
    expect(() => isWithinLimit("STARTER", "employees", count)).toThrow(RangeError);
    expect(() => remainingCapacity("STARTER", "employees", count)).toThrow(RangeError);
  });
});

describe("remainingCapacity", () => {
  it("counts down to zero and never goes negative", () => {
    expect(remainingCapacity("STARTER", "employees", 0)).toBe(25);
    expect(remainingCapacity("STARTER", "employees", 20)).toBe(5);
    expect(remainingCapacity("STARTER", "employees", 25)).toBe(0);
    expect(remainingCapacity("STARTER", "employees", 40)).toBe(0); // e.g. after a downgrade
    expect(remainingCapacity("ENTERPRISE", "employees", 10_000)).toBe(UNLIMITED);
  });
});

describe("isPlanAtLeast / formatLimit", () => {
  it("compares by PLAN_ORDER", () => {
    expect(isPlanAtLeast("STARTER", "STARTER")).toBe(true);
    expect(isPlanAtLeast("BUSINESS", "STARTER")).toBe(true);
    expect(isPlanAtLeast("STARTER", "BUSINESS")).toBe(false);
    expect(isPlanAtLeast("ENTERPRISE", "PRO")).toBe(true);
    expect(isPlanAtLeast("PRO", "ENTERPRISE")).toBe(false);
  });

  it("formats limits for display", () => {
    expect(formatLimit(25)).toBe("25");
    expect(formatLimit(0)).toBe("0");
    expect(formatLimit(UNLIMITED)).toBe("Unlimited");
  });
});
