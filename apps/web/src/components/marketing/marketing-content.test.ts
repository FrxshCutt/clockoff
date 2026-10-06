import { WORK_MODE_STATES } from "@workmode/shared/enums";
import { requestDemoSchema } from "@workmode/validation/organisation";
import { describe, expect, it } from "vitest";
import { isInternalPath } from "@/config/navigation";
import {
  FEATURES,
  FLOW,
  FOOTER_GROUPS,
  HERO,
  HOW_IT_WORKS_STRIP,
  MARKETING_CTA,
  MARKETING_NAV,
  MARKETING_ROUTES,
  PRICING_FAQ,
  PRIVACY_TECH_POINTS,
  PRODUCT_SECTIONS,
  USE_CASES,
} from "./marketing-content";
import {
  EMPTY_REQUEST_DEMO_FORM,
  isHoneypotTripped,
  normaliseDemoSource,
  requestDemoFormSchema,
  toRequestDemoPayload,
} from "./request-demo-schema";

describe("marketing navigation", () => {
  it("lists the five pages in the brief, in order, plus demo and login CTAs", () => {
    expect(MARKETING_NAV.map((item) => item.label)).toEqual(["Product", "How it works", "For businesses", "Pricing", "Privacy"]);
    expect(MARKETING_NAV.map((item) => item.href)).toEqual(["/product", "/how-it-works", "/for-businesses", "/pricing", "/privacy"]);
    expect(MARKETING_CTA.primary).toEqual({ label: "Request a demo", href: "/request-demo" });
    expect(MARKETING_CTA.login).toEqual({ label: "Log in", href: "/login" });
  });

  it("never collides with dashboard routes and only uses same-origin paths", () => {
    const dashboard = ["/overview", "/employees", "/schedule", "/policies", "/break-rules", "/integrations", "/activity", "/locations", "/settings", "/billing", "/help", "/devices", "/audit-logs"];
    for (const route of Object.values(MARKETING_ROUTES)) {
      expect(isInternalPath(route), route).toBe(true);
      expect(dashboard, route).not.toContain(route);
    }
    for (const group of FOOTER_GROUPS) {
      for (const link of group.links) {
        if (link.external) expect(link.href).toMatch(/^mailto:/);
        else expect(isInternalPath(link.href), link.href).toBe(true);
      }
    }
  });
});

describe("marketing copy", () => {
  it("uses the exact hero copy from the brief", () => {
    expect(HERO.headline).toBe("Automatically create distraction-free shifts.");
    expect(HERO.subheadline).toBe("Your rota manages when your team works. We make sure their phones know they're working too.");
    expect(HERO.privacyLine).toBe("Block distractions. Don't monitor employees.");
  });

  it("has a three-step strip, a feature grid and the full flow in the right order", () => {
    expect(HOW_IT_WORKS_STRIP).toHaveLength(3);
    expect(FEATURES.length).toBeGreaterThanOrEqual(6);
    expect(FLOW.map((step) => step.key)).toEqual(["policy", "connect", "schedule", "starting", "shields", "break", "restore", "end"]);
    for (const step of FLOW) {
      if (step.state !== null) expect(WORK_MODE_STATES, step.key).toContain(step.state);
      expect(step.body, step.key).toMatch(/\.$/);
    }
    expect(USE_CASES.map((useCase) => useCase.title)).toEqual(["Hospitality", "Retail", "Warehouse and logistics"]);
    for (const section of PRODUCT_SECTIONS) expect(section.points.length, section.id).toBeGreaterThan(0);
    for (const faq of PRICING_FAQ) expect(faq.question).toMatch(/\?$/);
  });

  it("states the Apple Screen Time facts and never claims a usage report", () => {
    const text = PRIVACY_TECH_POINTS.map((point) => `${point.title} ${point.body}`).join(" ");
    expect(text).toContain("FamilyControls");
    expect(text).toContain("ManagedSettings");
    expect(text).toContain("DeviceActivity");
    expect(text).toContain("opaque tokens");
    expect(text).not.toMatch(/which apps (were|are) used by/);
  });
});

describe("request demo form", () => {
  it("requires name, work email and company; team size and message are optional", () => {
    expect(requestDemoFormSchema.safeParse(EMPTY_REQUEST_DEMO_FORM).success).toBe(false);
    const ok = requestDemoFormSchema.safeParse({ ...EMPTY_REQUEST_DEMO_FORM, name: " Ada ", email: "Ada@Example.com", company: "Harbour Café" });
    expect(ok.success).toBe(true);
    expect(requestDemoFormSchema.safeParse({ ...EMPTY_REQUEST_DEMO_FORM, name: "Ada", email: "not-an-email", company: "X" }).success).toBe(false);
    expect(requestDemoFormSchema.safeParse({ ...EMPTY_REQUEST_DEMO_FORM, name: "Ada", email: "a@b.co", company: "X", teamSize: "lots" }).success).toBe(false);
    expect(requestDemoFormSchema.safeParse({ ...EMPTY_REQUEST_DEMO_FORM, name: "Ada", email: "a@b.co", company: "X", teamSize: "11-50" }).success).toBe(true);
  });

  it("builds a payload without empty optional fields and a normalised email", () => {
    const payload = toRequestDemoPayload({ ...EMPTY_REQUEST_DEMO_FORM, name: " Ada ", email: " Ada@Example.com ", company: " Harbour ", message: "  " });
    expect(payload).toEqual({ name: "Ada", email: "ada@example.com", company: "Harbour" });
    expect(toRequestDemoPayload({ ...EMPTY_REQUEST_DEMO_FORM, name: "A", email: "a@b.co", company: "C", teamSize: "1-10", message: " hi " })).toEqual({
      name: "A",
      email: "a@b.co",
      company: "C",
      teamSize: "1-10",
      message: "hi",
    });
    expect("website" in payload).toBe(false);
  });

  it("detects a filled honeypot", () => {
    expect(isHoneypotTripped({ website: "" })).toBe(false);
    expect(isHoneypotTripped({ website: "   " })).toBe(false);
    expect(isHoneypotTripped({ website: "http://spam.example" })).toBe(true);
  });

  it("only keeps a safe `source` and records it on the payload", () => {
    expect(normaliseDemoSource("pricing")).toBe("pricing");
    expect(normaliseDemoSource(" Pricing-BUSINESS ")).toBe("pricing-business");
    expect(normaliseDemoSource("<script>")).toBeUndefined();
    expect(normaliseDemoSource("")).toBeUndefined();
    expect(normaliseDemoSource("x".repeat(101))).toBeUndefined();
    expect(normaliseDemoSource(undefined)).toBeUndefined();
    const values = { ...EMPTY_REQUEST_DEMO_FORM, name: "A", email: "a@b.co", company: "C" };
    expect(toRequestDemoPayload(values, "pricing").source).toBe("pricing");
    expect("source" in toRequestDemoPayload(values, "javascript:alert(1)")).toBe(false);
  });

  it("produces bodies the API contract (requestDemoSchema) accepts, with the same limits", () => {
    const minimal = toRequestDemoPayload({ ...EMPTY_REQUEST_DEMO_FORM, name: "Ada", email: "ada@example.com", company: "Harbour" });
    expect(requestDemoSchema.safeParse(minimal).success).toBe(true);
    const full = toRequestDemoPayload(
      { ...EMPTY_REQUEST_DEMO_FORM, name: "Ada", email: "ada@example.com", company: "Harbour", teamSize: "51-200", message: "Two sites." },
      "pricing",
    );
    expect(requestDemoSchema.parse(full)).toEqual({ name: "Ada", email: "ada@example.com", company: "Harbour", teamSize: "51-200", message: "Two sites.", source: "pricing" });
    // Anything the form lets through must be within the contract's limits.
    const longest = { ...EMPTY_REQUEST_DEMO_FORM, name: "n".repeat(120), email: "a@b.co", company: "c".repeat(160), message: "m".repeat(2000) };
    expect(requestDemoFormSchema.safeParse(longest).success).toBe(true);
    expect(requestDemoSchema.safeParse(toRequestDemoPayload(longest)).success).toBe(true);
    expect(requestDemoFormSchema.safeParse({ ...longest, company: "c".repeat(161) }).success).toBe(false);
  });
});
