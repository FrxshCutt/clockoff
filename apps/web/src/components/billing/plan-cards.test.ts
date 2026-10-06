import { PLANS } from "@workmode/shared/enums";
import { PLAN_CONFIG } from "@workmode/shared/plans";
import { describe, expect, it } from "vitest";
import {
  PLAN_CTA_LABELS,
  PLAN_LIMIT_KEYS,
  formatPlanLimitValue,
  planCardCta,
  planHighlights,
  planLimitLines,
  salesMailto,
} from "./plan-cards";

describe("planCardCta", () => {
  it("marks the current plan, upgrades above it, downgrades below it and sales for Enterprise", () => {
    expect(planCardCta("BUSINESS", "BUSINESS")).toBe("current");
    expect(planCardCta("PRO", "BUSINESS")).toBe("upgrade");
    expect(planCardCta("STARTER", "BUSINESS")).toBe("downgrade");
    expect(planCardCta("ENTERPRISE", "BUSINESS")).toBe("contact-sales");
    expect(planCardCta("ENTERPRISE", "ENTERPRISE")).toBe("current");
    expect(planCardCta("PRO", "ENTERPRISE")).toBe("downgrade");
  });

  it("has a label for every CTA", () => {
    for (const cta of ["current", "upgrade", "downgrade", "contact-sales"] as const) {
      expect(PLAN_CTA_LABELS[cta]).toBeTruthy();
    }
  });
});

describe("plan limit formatting", () => {
  it("formats counts, singles, unlimited and none", () => {
    expect(formatPlanLimitValue("employees", 25)).toBe("Up to 25");
    expect(formatPlanLimitValue("locations", 1)).toBe("1");
    expect(formatPlanLimitValue("employees", "UNLIMITED")).toBe("Unlimited");
    expect(formatPlanLimitValue("integrations", 0)).toBe("Not included");
    expect(formatPlanLimitValue("integrations", 1)).toBe("1 (coming soon)");
    expect(formatPlanLimitValue("integrations", "UNLIMITED")).toBe("Unlimited (coming soon)");
  });

  it("produces the same four rows for every plan, in order", () => {
    for (const plan of PLANS) {
      const lines = planLimitLines(plan);
      expect(
        lines.map((line) => line.key),
        plan,
      ).toEqual([...PLAN_LIMIT_KEYS]);
      for (const line of lines)
        expect(line.label && line.value, `${plan}.${line.key}`).toBeTruthy();
    }
    const starter = planLimitLines("STARTER");
    expect(starter.find((l) => l.key === "integrations")).toMatchObject({
      value: "Not included",
      included: false,
    });
    expect(starter.find((l) => l.key === "analytics")).toMatchObject({
      value: "Not included",
      included: false,
    });
    const enterprise = planLimitLines("ENTERPRISE");
    expect(enterprise.find((l) => l.key === "employees")).toMatchObject({
      value: "Unlimited",
      included: true,
    });
    expect(enterprise.find((l) => l.key === "analytics")).toMatchObject({
      value: "Included",
      included: true,
    });
  });

  it("keeps only the hand-written feature bullets as highlights", () => {
    expect(planHighlights("STARTER")).toEqual([
      "Work Policies and Break Rules",
      "Shift scheduling and CSV import",
      "Company join code and employee invites",
      "Live device status",
    ]);
    expect(planHighlights("PRO")).toEqual(["Everything in Business", "Priority support"]);
    for (const plan of PLANS) {
      for (const line of planHighlights(plan)) {
        expect(line, plan).not.toMatch(/^(Up to|Unlimited|\d+ )/);
        expect(PLAN_CONFIG[plan].features).toContain(line);
      }
    }
  });
});

describe("salesMailto", () => {
  it("encodes the subject and body for a mailto link", () => {
    expect(salesMailto("Upgrade to Pro")).toBe(
      "mailto:support@workmode.app?subject=Upgrade%20to%20Pro",
    );
    expect(salesMailto("Plan", "Hi there & thanks")).toBe(
      "mailto:support@workmode.app?subject=Plan&body=Hi%20there%20%26%20thanks",
    );
  });
});
