import {
  BREAK_POLICY_DEFAULTS,
  breakPolicyRulesSchema,
  createBreakPolicySchema,
  updateBreakPolicySchema,
  type BreakPolicy,
} from "@workmode/validation/breakPolicies";
import { describe, expect, it } from "vitest";
import {
  BREAK_BEHAVIOUR_OPTIONS,
  BREAK_POLICY_PRESETS,
  RELAX_CATEGORIES_DEVICE_NOTE,
  breakPolicyAssignGuard,
  breakPolicyDeleteGuard,
  breakPolicyFormSchema,
  breakPolicySetDefaultGuard,
  describeBreakBehaviour,
  describeBreakBehaviourLabel,
  describeBreakStarters,
  describeBreakTriggers,
  formatBreakCount,
  matchesBreakPolicySearch,
  previewBreakSummary,
  summariseBreakPolicy,
  toBreakPolicyFormValues,
  toCreateBreakPolicyInput,
  toUpdateBreakPolicyInput,
} from "./break-policy-view-model";

const STANDARD = BREAK_POLICY_PRESETS[0]!;
const LUNCH = BREAK_POLICY_PRESETS[1]!;
const NO_UNLOCK = BREAK_POLICY_PRESETS[2]!;

function breakPolicy(overrides: Partial<BreakPolicy> = {}): BreakPolicy {
  return {
    id: "6f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a10",
    name: "Standard Break",
    description: "Two short breaks",
    ...STANDARD.rules,
    status: "ACTIVE",
    isDefault: false,
    assignmentCount: 0,
    assignedEmployeeCount: 0,
    createdAt: "2026-10-01T09:00:00Z",
    updatedAt: "2026-10-04T12:00:00Z",
    ...overrides,
  };
}

describe("summary line", () => {
  it("renders the spec example for each preset", () => {
    expect(summariseBreakPolicy(STANDARD.rules)).toBe("2 breaks · 15 min each · relax all");
    expect(summariseBreakPolicy(LUNCH.rules)).toBe("1 break · 30 min each · relax all");
    expect(summariseBreakPolicy(NO_UNLOCK.rules)).toBe("2 breaks · 15 min each · keep restrictions");
  });

  it("adds the total only when it caps the breaks, and handles disabled rules and partial relaxing", () => {
    expect(summariseBreakPolicy({ ...STANDARD.rules, maxBreaksPerShift: 3, maxBreakDurationMinutes: 20, maxTotalBreakMinutes: 30 })).toBe(
      "3 breaks · 20 min each · 30 min total · relax all",
    );
    expect(summariseBreakPolicy({ ...STANDARD.rules, breaksEnabled: false })).toBe("Breaks off");
    expect(
      summariseBreakPolicy({ ...STANDARD.rules, restrictionBehaviour: "RELAX_CATEGORIES", relaxedCategories: ["GAMES"] }),
    ).toBe("2 breaks · 15 min each · relax games");
    expect(describeBreakBehaviour("RELAX_CATEGORIES", ["GAMES", "VIDEO"])).toBe("relax 2 categories");
    expect(describeBreakBehaviour("RELAX_CATEGORIES", [])).toBe("relax some");
    expect(formatBreakCount(1)).toBe("1 break");
    expect(formatBreakCount(0)).toBe("0 breaks");
  });

  it("describes triggers and timing gates in one sentence", () => {
    expect(describeBreakTriggers(STANDARD.rules)).toBe(
      "Employees can start breaks from the app and scheduled breaks start automatically; not in the first 1 h, at least 1 h apart.",
    );
    expect(describeBreakTriggers({ ...LUNCH.rules, scheduledBreaksAllowed: false })).toBe(
      "Employees can start breaks from the app; not in the first 2 h.",
    );
    expect(
      describeBreakTriggers({
        ...STANDARD.rules,
        employeeTriggeredAllowed: false,
        scheduledBreaksAllowed: false,
        minGapBetweenBreaksMinutes: 0,
        minMinutesAfterShiftStart: 0,
      }),
    ).toBe("Only managers can start breaks.");
    expect(describeBreakTriggers({ ...STANDARD.rules, breaksEnabled: false })).toBe("Employees cannot take breaks under these rules.");
  });

  it("labels behaviour and starters for detail views", () => {
    expect(describeBreakBehaviourLabel("RELAX_ALL", [])).toBe("Relax everything");
    expect(describeBreakBehaviourLabel("RELAX_CATEGORIES", ["GAMES", "VIDEO"])).toBe("Relax some categories (Games, Video)");
    expect(describeBreakBehaviourLabel("KEEP_RESTRICTIONS", ["GAMES"])).toBe("Keep restrictions");
    expect(describeBreakStarters(STANDARD.rules)).toBe("Employees from the app, and scheduled breaks");
    expect(describeBreakStarters({ ...STANDARD.rules, scheduledBreaksAllowed: false })).toBe("Employees from the app");
    expect(describeBreakStarters({ ...STANDARD.rules, employeeTriggeredAllowed: false })).toBe("Scheduled breaks only");
    expect(describeBreakStarters({ ...STANDARD.rules, employeeTriggeredAllowed: false, scheduledBreaksAllowed: false })).toBe("Managers only");
    expect(describeBreakStarters({ ...STANDARD.rules, breaksEnabled: false })).toBe("Nobody — breaks are off");
  });
});

describe("presets", () => {
  it("offers the three seeded starting points, each a valid rule set", () => {
    expect(BREAK_POLICY_PRESETS.map((preset) => preset.name)).toEqual(["Standard Break", "Lunch Shift", "No Phone Break Unlock"]);
    for (const preset of BREAK_POLICY_PRESETS) {
      expect(breakPolicyRulesSchema.safeParse(preset.rules).success, preset.name).toBe(true);
    }
    expect(STANDARD.rules).toEqual(BREAK_POLICY_DEFAULTS);
  });

  it("explains the three behaviours and the on-device note is honest about two selections", () => {
    expect(BREAK_BEHAVIOUR_OPTIONS.map((option) => option.value)).toEqual(["RELAX_ALL", "RELAX_CATEGORIES", "KEEP_RESTRICTIONS"]);
    expect(BREAK_BEHAVIOUR_OPTIONS.every((option) => option.description.length > 20)).toBe(true);
    expect(RELAX_CATEGORIES_DEVICE_NOTE).toMatch(/two Screen Time selections/);
    expect(RELAX_CATEGORIES_DEVICE_NOTE).toMatch(/employer never sees/);
  });
});

describe("form default mapping", () => {
  it("starts from a preset, the API defaults, or an existing policy", () => {
    const fromPreset = toBreakPolicyFormValues(null, LUNCH);
    expect(fromPreset.name).toBe("Lunch Shift");
    expect(fromPreset.maxBreakDurationMinutes).toBe(30);
    expect(fromPreset.minMinutesAfterShiftStart).toBe(120);

    const fromDefaults = toBreakPolicyFormValues(null);
    expect(fromDefaults.name).toBe("");
    expect(fromDefaults.description).toBe("");
    expect(fromDefaults.maxBreaksPerShift).toBe(BREAK_POLICY_DEFAULTS.maxBreaksPerShift);

    const existing = breakPolicy({ description: null, restrictionBehaviour: "RELAX_CATEGORIES", relaxedCategories: ["GAMES"] });
    const fromPolicy = toBreakPolicyFormValues(existing);
    expect(fromPolicy.name).toBe("Standard Break");
    expect(fromPolicy.description).toBe("");
    expect(fromPolicy.relaxedCategories).toEqual(["GAMES"]);
    expect(breakPolicyFormSchema.safeParse(fromPolicy).success).toBe(true);
  });

  it("maps to valid create and update bodies, stripping stale relaxed categories", () => {
    const values = { ...toBreakPolicyFormValues(null, STANDARD), name: "  Standard  ", description: "  ", relaxedCategories: ["GAMES" as const] };
    const created = toCreateBreakPolicyInput(values);
    expect(created.name).toBe("Standard");
    expect(created.description).toBeNull();
    expect(created.relaxedCategories).toEqual([]);
    expect(createBreakPolicySchema.safeParse(created).success).toBe(true);

    const updated = toUpdateBreakPolicyInput({ ...values, restrictionBehaviour: "RELAX_CATEGORIES" });
    expect(updated.relaxedCategories).toEqual(["GAMES"]);
    expect(updateBreakPolicySchema.safeParse(updated).success).toBe(true);
    const { name: _name, description: _description, ...rules } = updated;
    expect(breakPolicyRulesSchema.safeParse(rules).success).toBe(true);
  });

  it("applies the API's cross-field rules on the client", () => {
    const base = toBreakPolicyFormValues(null, STANDARD);
    expect(breakPolicyFormSchema.safeParse({ ...base, name: "" }).success).toBe(false);
    const tooLong = breakPolicyFormSchema.safeParse({ ...base, maxBreakDurationMinutes: 45, maxTotalBreakMinutes: 30 });
    expect(tooLong.success).toBe(false);
    expect(tooLong.success ? [] : tooLong.error.issues.map((i) => i.path.join("."))).toContain("maxBreakDurationMinutes");
    expect(breakPolicyFormSchema.safeParse({ ...base, restrictionBehaviour: "RELAX_CATEGORIES", relaxedCategories: [] }).success).toBe(false);
    expect(breakPolicyFormSchema.safeParse({ ...base, maxBreaksPerShift: 0 }).success).toBe(false);
    expect(breakPolicyFormSchema.safeParse({ ...base, breaksEnabled: false, maxBreaksPerShift: 0 }).success).toBe(true);
  });

  it("previews the summary only once the rules are complete", () => {
    expect(previewBreakSummary(STANDARD.rules)).toBe("2 breaks · 15 min each · relax all");
    expect(previewBreakSummary({ maxBreaksPerShift: Number.NaN })).toBeNull();
    expect(previewBreakSummary({ maxBreaksPerShift: 1, maxBreakDurationMinutes: 30, maxTotalBreakMinutes: 30 })).toBe(
      "1 break · 30 min each · relax all",
    );
    expect(previewBreakSummary({ maxBreaksPerShift: undefined })).toBe("2 breaks · 15 min each · relax all");
  });
});

describe("guards and search", () => {
  it("explains why deleting is blocked", () => {
    expect(breakPolicyDeleteGuard(breakPolicy())).toEqual({ blocked: false });
    const blocked = breakPolicyDeleteGuard(breakPolicy({ isDefault: true, assignmentCount: 3 }));
    expect(blocked.blocked).toBe(true);
    expect(blocked.blocked ? blocked.reasons : []).toHaveLength(2);
    expect(blocked.blocked ? blocked.reasons[1] : "").toContain("assigned to 3 scopes");
  });

  it("only archived rules can't be assigned or made the default", () => {
    expect(breakPolicyAssignGuard(breakPolicy())).toEqual({ ok: true });
    expect(breakPolicyAssignGuard(breakPolicy({ status: "ARCHIVED" })).ok).toBe(false);
    expect(breakPolicySetDefaultGuard(breakPolicy())).toEqual({ ok: true });
    expect(breakPolicySetDefaultGuard(breakPolicy({ isDefault: true })).ok).toBe(false);
    expect(breakPolicySetDefaultGuard(breakPolicy({ status: "ARCHIVED" })).ok).toBe(false);
  });

  it("matches name or description, case-insensitively", () => {
    expect(matchesBreakPolicySearch(breakPolicy(), "standard")).toBe(true);
    expect(matchesBreakPolicySearch(breakPolicy(), "SHORT")).toBe(true);
    expect(matchesBreakPolicySearch(breakPolicy(), "lunch")).toBe(false);
    expect(matchesBreakPolicySearch(breakPolicy({ description: null }), "  ")).toBe(true);
  });
});
