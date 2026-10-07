import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import {
  createDefaultRestrictionConfig,
  type RestrictionConfig,
} from "@clockoff/shared/policy/restrictionConfig";
import type { BreakPolicyLike } from "@clockoff/shared/breaks/breakTypes";
import {
  BREAK_POLICY_DEFAULTS,
  breakPolicyRulesSchema,
  createBreakPolicySchema,
  updateBreakPolicySchema,
} from "./breakPolicies";
import {
  breakBehaviourDefaultSchema,
  createAssignmentSchema,
  createPolicySchema,
  publishPolicySchema,
  restrictionConfigSchema,
  setDefaultPolicySchema,
  updatePolicySchema,
} from "./policies";

const validConfig = createDefaultRestrictionConfig();

describe("restrictionConfigSchema (§3 PolicyVersion.restriction_config)", () => {
  it("is structurally identical to the shared RestrictionConfig type", () => {
    expectTypeOf<z.infer<typeof restrictionConfigSchema>>().toEqualTypeOf<RestrictionConfig>();
  });

  it("accepts the shared default config", () => {
    expect(restrictionConfigSchema.parse(validConfig)).toEqual(validConfig);
  });

  it("enforces the documented limits", () => {
    expect(restrictionConfigSchema.safeParse({ ...validConfig, categories: [] }).success).toBe(
      false,
    );
    expect(
      restrictionConfigSchema.safeParse({ ...validConfig, categories: ["GAMES", "GAMES"] }).success,
    ).toBe(false);
    expect(
      restrictionConfigSchema.safeParse({ ...validConfig, categories: ["CASINO"] }).success,
    ).toBe(false);
    expect(
      restrictionConfigSchema.safeParse({ ...validConfig, shieldMessage: "x".repeat(121) }).success,
    ).toBe(false);
    expect(
      restrictionConfigSchema.safeParse({ ...validConfig, shieldMessage: "x".repeat(120) }).success,
    ).toBe(true);
    expect(
      restrictionConfigSchema.safeParse({ ...validConfig, preShiftWarningMinutes: 121 }).success,
    ).toBe(false);
    expect(
      restrictionConfigSchema.safeParse({ ...validConfig, preShiftWarningMinutes: -1 }).success,
    ).toBe(false);
    expect(
      restrictionConfigSchema.safeParse({ ...validConfig, preShiftWarningMinutes: 1.5 }).success,
    ).toBe(false);
    expect(
      restrictionConfigSchema.safeParse({ ...validConfig, activationMode: "MANUAL" }).success,
    ).toBe(false);
  });

  it("allows shieldMessage to be omitted and rejects unknown keys", () => {
    const { shieldMessage: _omit, ...withoutMessage } = validConfig;
    expect(restrictionConfigSchema.safeParse(withoutMessage).success).toBe(true);
    expect(
      restrictionConfigSchema.safeParse({ ...validConfig, blockedApps: ["com.example"] }).success,
    ).toBe(false);
  });
});

describe("breakBehaviourDefaultSchema", () => {
  it("requires categories for RELAX_CATEGORIES only", () => {
    expect(
      breakBehaviourDefaultSchema.safeParse({
        restrictionBehaviour: "RELAX_ALL",
        relaxedCategories: [],
      }).success,
    ).toBe(true);
    expect(
      breakBehaviourDefaultSchema.safeParse({
        restrictionBehaviour: "RELAX_CATEGORIES",
        relaxedCategories: [],
      }).success,
    ).toBe(false);
    expect(
      breakBehaviourDefaultSchema.safeParse({
        restrictionBehaviour: "RELAX_CATEGORIES",
        relaxedCategories: ["SOCIAL_MEDIA"],
      }).success,
    ).toBe(true);
  });
});

describe("policy bodies", () => {
  it("creates with a restriction config and rejects unknown keys", () => {
    expect(
      createPolicySchema.safeParse({ name: "Floor staff", restrictionConfig: validConfig }).success,
    ).toBe(true);
    expect(
      createPolicySchema.safeParse({ name: "  ", restrictionConfig: validConfig }).success,
    ).toBe(false);
    expect(
      createPolicySchema.safeParse({ name: "X", restrictionConfig: validConfig, status: "ACTIVE" })
        .success,
    ).toBe(false);
  });

  it("patches with null clearing the description", () => {
    expect(updatePolicySchema.parse({ description: "" })).toEqual({ description: null });
    expect(updatePolicySchema.parse({ description: null })).toEqual({ description: null });
    expect(updatePolicySchema.parse({})).toEqual({});
  });

  it("publish note is optional and capped", () => {
    expect(publishPolicySchema.safeParse({}).success).toBe(true);
    expect(publishPolicySchema.safeParse({ changeNote: "x".repeat(501) }).success).toBe(false);
  });

  it("validates assignment windows and scope types", () => {
    const scopeId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    expect(createAssignmentSchema.safeParse({ scopeType: "TEAM", scopeId }).success).toBe(true);
    expect(createAssignmentSchema.safeParse({ scopeType: "DEPARTMENT", scopeId }).success).toBe(
      false,
    );
    expect(
      createAssignmentSchema.safeParse({
        scopeType: "LOCATION",
        scopeId,
        effectiveFrom: "2026-10-10T00:00:00Z",
        effectiveTo: "2026-10-01T00:00:00Z",
      }).success,
    ).toBe(false);
  });

  it("default policy may be cleared with null", () => {
    expect(setDefaultPolicySchema.parse({ policyId: null })).toEqual({ policyId: null });
    expect(setDefaultPolicySchema.safeParse({}).success).toBe(false);
  });
});

describe("break policy schemas (§6.3)", () => {
  it("rules match the shared BreakPolicyLike shape", () => {
    expectTypeOf<z.infer<typeof breakPolicyRulesSchema>>().toExtend<BreakPolicyLike>();
    expect(breakPolicyRulesSchema.parse(BREAK_POLICY_DEFAULTS)).toEqual(BREAK_POLICY_DEFAULTS);
  });

  it("applies the Prisma defaults on create", () => {
    expect(createBreakPolicySchema.parse({ name: "Standard breaks" })).toMatchObject({
      ...BREAK_POLICY_DEFAULTS,
      name: "Standard breaks",
      description: null,
    });
  });

  it("rejects inconsistent rules", () => {
    expect(
      createBreakPolicySchema.safeParse({
        name: "X",
        maxBreakDurationMinutes: 45,
        maxTotalBreakMinutes: 30,
      }).success,
    ).toBe(false);
    expect(createBreakPolicySchema.safeParse({ name: "X", maxBreaksPerShift: 0 }).success).toBe(
      false,
    );
    expect(
      createBreakPolicySchema.safeParse({ name: "X", breaksEnabled: false, maxBreaksPerShift: 0 })
        .success,
    ).toBe(true);
    expect(
      createBreakPolicySchema.safeParse({ name: "X", restrictionBehaviour: "RELAX_CATEGORIES" })
        .success,
    ).toBe(false);
    // Enabled breaks with no break minutes at all is contradictory (the rules would always refuse).
    expect(createBreakPolicySchema.safeParse({ name: "X", maxTotalBreakMinutes: 0 }).success).toBe(
      false,
    );
    expect(
      createBreakPolicySchema.safeParse({
        name: "X",
        breaksEnabled: false,
        maxBreaksPerShift: 0,
        maxTotalBreakMinutes: 0,
      }).success,
    ).toBe(true);
    expect(
      breakPolicyRulesSchema.safeParse({ ...BREAK_POLICY_DEFAULTS, maxTotalBreakMinutes: 0 })
        .success,
    ).toBe(false);
  });

  it("patches any subset and stays strict", () => {
    expect(updateBreakPolicySchema.parse({ maxBreaksPerShift: 3 })).toEqual({
      maxBreaksPerShift: 3,
    });
    expect(updateBreakPolicySchema.safeParse({ maxBreaksPerShift: 3, foo: 1 }).success).toBe(false);
  });
});
