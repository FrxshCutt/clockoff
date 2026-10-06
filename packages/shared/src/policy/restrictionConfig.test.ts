import { describe, expect, it } from "vitest";
import { ACTIVATION_MODES, RESTRICTION_CATEGORIES } from "../enums";
import { DEFAULT_RESTRICTION_CONFIG, createDefaultRestrictionConfig, isRestrictionConfig } from "./restrictionConfig";
import type { RestrictionConfig } from "./restrictionConfig";

describe("DEFAULT_RESTRICTION_CONFIG", () => {
  it("is itself a valid RestrictionConfig", () => {
    expect(isRestrictionConfig(DEFAULT_RESTRICTION_CONFIG)).toBe(true);
    expect(ACTIVATION_MODES).toContain(DEFAULT_RESTRICTION_CONFIG.activationMode);
    for (const c of DEFAULT_RESTRICTION_CONFIG.categories) expect(RESTRICTION_CATEGORIES).toContain(c);
  });

  it("restricts every category except OTHER_SELECTED and requires the employee to pick apps", () => {
    expect(DEFAULT_RESTRICTION_CONFIG.categories).toEqual(RESTRICTION_CATEGORIES.filter((c) => c !== "OTHER_SELECTED"));
    expect(DEFAULT_RESTRICTION_CONFIG.requireEmployeeAppSelection).toBe(true);
    expect(DEFAULT_RESTRICTION_CONFIG.alwaysAllowedNote.length).toBeGreaterThan(0);
    expect(DEFAULT_RESTRICTION_CONFIG.preShiftWarningMinutes).toBeGreaterThan(0);
  });

  it("is deep-frozen", () => {
    expect(Object.isFrozen(DEFAULT_RESTRICTION_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_RESTRICTION_CONFIG.categories)).toBe(true);
    expect(Object.isFrozen(DEFAULT_RESTRICTION_CONFIG.alwaysAllowedNote)).toBe(true);
    expect(() => DEFAULT_RESTRICTION_CONFIG.categories.push("OTHER_SELECTED")).toThrow();
  });

  it("createDefaultRestrictionConfig returns an equal, independent, mutable copy", () => {
    const copy = createDefaultRestrictionConfig();
    expect(copy).toEqual(DEFAULT_RESTRICTION_CONFIG);
    expect(copy).not.toBe(DEFAULT_RESTRICTION_CONFIG);
    expect(copy.categories).not.toBe(DEFAULT_RESTRICTION_CONFIG.categories);
    copy.categories.push("OTHER_SELECTED");
    copy.alwaysAllowedNote.pop();
    expect(DEFAULT_RESTRICTION_CONFIG.categories).not.toContain("OTHER_SELECTED");
    expect(createDefaultRestrictionConfig()).toEqual(DEFAULT_RESTRICTION_CONFIG);
  });
});

describe("isRestrictionConfig", () => {
  const valid: RestrictionConfig = {
    categories: ["SOCIAL_MEDIA", "GAMES"],
    requireEmployeeAppSelection: true,
    alwaysAllowedNote: ["Phone"],
    shieldMessage: "Back to work",
    activationMode: "CLOCK_EVENT",
    preShiftWarningMinutes: 0,
  };

  it("accepts valid configs, with or without shieldMessage, and with empty arrays", () => {
    expect(isRestrictionConfig(valid)).toBe(true);
    const { shieldMessage: _omitted, ...noShield } = valid;
    expect(isRestrictionConfig(noShield)).toBe(true);
    expect(isRestrictionConfig({ ...valid, categories: [], alwaysAllowedNote: [] })).toBe(true);
    expect(isRestrictionConfig(JSON.parse(JSON.stringify(valid)))).toBe(true);
  });

  it("rejects non-objects", () => {
    for (const v of [null, undefined, 1, "x", true, [], [valid]]) expect(isRestrictionConfig(v)).toBe(false);
  });

  it("rejects missing or mistyped fields", () => {
    const { categories: _c, ...noCategories } = valid;
    expect(isRestrictionConfig(noCategories)).toBe(false);
    expect(isRestrictionConfig({ ...valid, categories: "SOCIAL_MEDIA" })).toBe(false);
    expect(isRestrictionConfig({ ...valid, categories: ["SOCIAL_MEDIA", "NOPE"] })).toBe(false);
    expect(isRestrictionConfig({ ...valid, categories: [1] })).toBe(false);
    expect(isRestrictionConfig({ ...valid, requireEmployeeAppSelection: "true" })).toBe(false);
    expect(isRestrictionConfig({ ...valid, alwaysAllowedNote: "Phone" })).toBe(false);
    expect(isRestrictionConfig({ ...valid, alwaysAllowedNote: [1] })).toBe(false);
    expect(isRestrictionConfig({ ...valid, shieldMessage: 5 })).toBe(false);
    expect(isRestrictionConfig({ ...valid, shieldMessage: null })).toBe(false);
    expect(isRestrictionConfig({ ...valid, activationMode: "MANUAL" })).toBe(false);
    expect(isRestrictionConfig({ ...valid, activationMode: undefined })).toBe(false);
  });

  it("requires preShiftWarningMinutes to be a non-negative integer", () => {
    expect(isRestrictionConfig({ ...valid, preShiftWarningMinutes: -1 })).toBe(false);
    expect(isRestrictionConfig({ ...valid, preShiftWarningMinutes: 1.5 })).toBe(false);
    expect(isRestrictionConfig({ ...valid, preShiftWarningMinutes: "10" })).toBe(false);
    expect(isRestrictionConfig({ ...valid, preShiftWarningMinutes: Number.NaN })).toBe(false);
    expect(isRestrictionConfig({ ...valid, preShiftWarningMinutes: 15 })).toBe(true);
  });
});
