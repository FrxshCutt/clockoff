import { DEFAULT_RESTRICTION_CONFIG } from "@workmode/shared/policy/restrictionConfig";
import {
  createPolicySchema,
  updatePolicySchema,
  type Policy,
  type PolicyAssignment,
  type PolicyVersion,
} from "@workmode/validation/policies";
import { describe, expect, it } from "vitest";
import {
  PRECEDENCE_LEVELS,
  PRECEDENCE_SUMMARY,
  activeAssignmentsByScopeId,
  archiveGuard,
  assignGuard,
  canPublish,
  comparePolicies,
  describeAssignmentScope,
  describeVersionHistory,
  formatAssignedSummary,
  formatCompactRelativeTime,
  formatVersionLabel,
  isAssignmentOpen,
  nextVersionNumber,
  openAssignments,
  policyFormSchema,
  publishImpactText,
  relaxableCategories,
  saveHintText,
  setDefaultGuard,
  summariseVersionDiff,
  toCreatePolicyInput,
  toPolicyFormValues,
  toUpdatePolicyInput,
  type PolicyFormValues,
} from "./policy-view-model";

const NOW = new Date("2026-10-06T12:00:00Z");
const POLICY_ID = "6f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a10";
const VERSION_ID = "8d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const USER = { id: "9d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d", name: "Ada Lovelace" };

function version(overrides: Partial<PolicyVersion> = {}): PolicyVersion {
  return {
    id: VERSION_ID,
    policyId: POLICY_ID,
    versionNumber: 1,
    restrictionConfig: {
      categories: ["SOCIAL_MEDIA", "GAMES"],
      requireEmployeeAppSelection: true,
      alwaysAllowedNote: ["Phone, Messages and FaceTime"],
      shieldMessage: "Heads down until the end of your shift.",
      activationMode: "SCHEDULED",
      preShiftWarningMinutes: 10,
    },
    breakBehaviourDefault: { restrictionBehaviour: "RELAX_ALL", relaxedCategories: [] },
    changeNote: null,
    publishedAt: "2026-10-04T12:00:00Z",
    createdBy: USER,
    createdAt: "2026-10-04T11:00:00Z",
    ...overrides,
  };
}

function policy(overrides: Partial<Policy> = {}): Policy {
  return {
    id: POLICY_ID,
    name: "Front of house",
    description: null,
    status: "ACTIVE",
    currentVersion: version(),
    draftVersion: null,
    isDefault: false,
    assignmentCount: 2,
    assignedEmployeeCount: 12,
    createdAt: "2026-10-01T09:00:00Z",
    updatedAt: "2026-10-04T12:00:00Z",
    ...overrides,
  };
}

function assignment(overrides: Partial<PolicyAssignment> = {}): PolicyAssignment {
  return {
    id: "1d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
    policy: { id: POLICY_ID, name: "Front of house" },
    scopeType: "TEAM",
    scopeId: "2d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
    scope: { id: "2d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d", name: "Bar" },
    effectiveFrom: null,
    effectiveTo: null,
    isActive: true,
    createdBy: USER,
    createdAt: "2026-10-02T09:00:00Z",
    ...overrides,
  };
}

describe("version labels", () => {
  it("formats compact relative times", () => {
    expect(formatCompactRelativeTime(new Date(NOW.getTime() - 30_000), NOW)).toBe("just now");
    expect(formatCompactRelativeTime(new Date(NOW.getTime() - 5 * 60_000), NOW)).toBe("5m ago");
    expect(formatCompactRelativeTime("2026-10-04T12:00:00Z", NOW)).toBe("2d ago");
    expect(formatCompactRelativeTime(new Date(NOW.getTime() + 2 * 3_600_000), NOW)).toBe("in 2h");
    expect(formatCompactRelativeTime(null, NOW)).toBe("—");
  });

  it("builds the card footer: 'v3 · published 2d ago', with draft and no-version variants", () => {
    expect(formatVersionLabel(policy({ currentVersion: version({ versionNumber: 3 }) }), NOW)).toBe(
      "v3 · published 2d ago",
    );
    expect(
      formatVersionLabel(
        policy({
          currentVersion: version({ versionNumber: 3 }),
          draftVersion: version({ versionNumber: 4, publishedAt: null }),
        }),
        NOW,
      ),
    ).toBe("v3 · published 2d ago · unpublished changes");
    expect(
      formatVersionLabel(
        policy({
          status: "DRAFT",
          currentVersion: null,
          draftVersion: version({ publishedAt: null }),
        }),
        NOW,
      ),
    ).toBe("v1 · draft");
    expect(formatVersionLabel(policy({ currentVersion: null, draftVersion: null }), NOW)).toBe(
      "No versions yet",
    );
  });

  it("knows the next version number and whether there is anything to publish", () => {
    expect(nextVersionNumber(policy({ currentVersion: version({ versionNumber: 3 }) }))).toBe(4);
    expect(nextVersionNumber(policy({ currentVersion: null, draftVersion: null }))).toBe(1);
    expect(
      nextVersionNumber(policy({ draftVersion: version({ versionNumber: 2, publishedAt: null }) })),
    ).toBe(2);
    expect(canPublish(policy())).toBe(false);
    expect(
      canPublish(policy({ draftVersion: version({ versionNumber: 2, publishedAt: null }) })),
    ).toBe(true);
    expect(
      canPublish(
        policy({
          status: "ARCHIVED",
          draftVersion: version({ versionNumber: 2, publishedAt: null }),
        }),
      ),
    ).toBe(false);
  });
});

describe("publish impact", () => {
  it("names the version that will ship and how many employees it reaches (employees, not phones)", () => {
    expect(
      publishImpactText(policy({ draftVersion: version({ versionNumber: 2, publishedAt: null }) })),
    ).toBe("v2 will reach 12 employees");
    expect(
      publishImpactText(
        policy({
          assignedEmployeeCount: 1,
          draftVersion: version({ versionNumber: 2, publishedAt: null }),
        }),
      ),
    ).toBe("v2 will reach 1 employee");
    expect(
      publishImpactText(
        policy({
          status: "DRAFT",
          currentVersion: null,
          draftVersion: version({ publishedAt: null }),
        }),
      ),
    ).toBe("v1 will reach 12 employees");
  });

  it("summarises who a policy applies to", () => {
    expect(formatAssignedSummary(policy())).toBe("12 employees · 2 assignments");
    expect(formatAssignedSummary(policy({ assignedEmployeeCount: 1, assignmentCount: 1 }))).toBe(
      "1 employee · 1 assignment",
    );
  });

  it("explains what saving does for new, draft and published policies", () => {
    expect(saveHintText(null)).toMatch(/created as a draft/);
    expect(
      saveHintText(
        policy({
          status: "DRAFT",
          currentVersion: null,
          draftVersion: version({ publishedAt: null }),
        }),
      ),
    ).toBe("Changes stay in draft v1 until you publish.");
    expect(saveHintText(policy())).toBe(
      "Saving configuration changes creates draft v2; devices stay on v1 until you publish.",
    );
    expect(
      saveHintText(policy({ draftVersion: version({ versionNumber: 2, publishedAt: null }) })),
    ).toBe("Changes are saved to draft v2; devices stay on v1 until you publish.");
    expect(saveHintText(policy({ status: "ARCHIVED" }))).toMatch(/can't be changed/);
  });
});

describe("precedence explainer", () => {
  it("lists Employee > Team > Location > Organisation with ranks", () => {
    expect(PRECEDENCE_LEVELS.map((level) => level.label)).toEqual([
      "Employee",
      "Team",
      "Location",
      "Organisation",
    ]);
    expect(PRECEDENCE_LEVELS.map((level) => level.rank)).toEqual([1, 2, 3, 4]);
    expect(PRECEDENCE_LEVELS.every((level) => level.description.length > 0)).toBe(true);
    expect(PRECEDENCE_SUMMARY).toBe("Employee > Team > Location > Organisation");
  });
});

describe("form default mapping", () => {
  it("starts a new policy from the shared default restriction config", () => {
    const values = toPolicyFormValues(null);
    expect(values.name).toBe("");
    expect(values.categories).toEqual([...DEFAULT_RESTRICTION_CONFIG.categories]);
    expect(values.categories).not.toContain("OTHER_SELECTED");
    expect(values.requireEmployeeAppSelection).toBe(true);
    expect(values.shieldMessage).toBe(DEFAULT_RESTRICTION_CONFIG.shieldMessage);
    expect(values.activationMode).toBe("SCHEDULED");
    expect(values.preShiftWarningMinutes).toBe(10);
    expect(values.restrictionBehaviour).toBe("RELAX_ALL");
    expect(values.relaxedCategories).toEqual([]);
    expect(policyFormSchema.safeParse({ ...values, name: "Default" }).success).toBe(true);
  });

  it("edits the draft version when there is one, otherwise the published version", () => {
    const draft = version({
      versionNumber: 2,
      publishedAt: null,
      restrictionConfig: {
        ...version().restrictionConfig,
        categories: ["VIDEO"],
        shieldMessage: undefined,
      },
    });
    const values = toPolicyFormValues(policy({ description: "Bar staff", draftVersion: draft }));
    expect(values.name).toBe("Front of house");
    expect(values.description).toBe("Bar staff");
    expect(values.categories).toEqual(["VIDEO"]);
    expect(values.shieldMessage).toBe("");
    expect(toPolicyFormValues(policy()).categories).toEqual(["SOCIAL_MEDIA", "GAMES"]);
  });

  it("maps form values to a valid create body, forcing app selection with OTHER_SELECTED", () => {
    const values: PolicyFormValues = {
      ...toPolicyFormValues(null),
      name: "  Kitchen  ",
      description: "   ",
      categories: ["OTHER_SELECTED", "GAMES"],
      requireEmployeeAppSelection: false,
      alwaysAllowedNote: [" Phone ", ""],
      shieldMessage: "   ",
      restrictionBehaviour: "RELAX_CATEGORIES",
      relaxedCategories: ["VIDEO", "GAMES"],
    };
    const input = toCreatePolicyInput(values);
    expect(input.name).toBe("Kitchen");
    expect(input.description).toBeNull();
    expect(input.restrictionConfig.categories).toEqual(["GAMES", "OTHER_SELECTED"]);
    expect(input.restrictionConfig.requireEmployeeAppSelection).toBe(true);
    expect(input.restrictionConfig.alwaysAllowedNote).toEqual(["Phone"]);
    expect("shieldMessage" in input.restrictionConfig).toBe(false);
    // Only categories the policy restricts can be relaxed.
    expect(input.breakBehaviourDefault).toEqual({
      restrictionBehaviour: "RELAX_CATEGORIES",
      relaxedCategories: ["GAMES"],
    });
    expect(createPolicySchema.safeParse(input).success).toBe(true);
  });

  it("drops relaxed categories unless the behaviour is RELAX_CATEGORIES", () => {
    const values: PolicyFormValues = {
      ...toPolicyFormValues(null),
      name: "x",
      relaxedCategories: ["GAMES"],
    };
    expect(toCreatePolicyInput(values).breakBehaviourDefault?.relaxedCategories).toEqual([]);
    expect(
      relaxableCategories({ categories: ["GAMES"], relaxedCategories: ["VIDEO", "GAMES"] }),
    ).toEqual(["GAMES"]);
  });

  it("rejects RELAX_CATEGORIES when nothing relaxable is picked, empty categories and blank numbers", () => {
    const base = { ...toPolicyFormValues(null), name: "x" };
    const noOverlap = policyFormSchema.safeParse({
      ...base,
      categories: ["GAMES"],
      restrictionBehaviour: "RELAX_CATEGORIES",
      relaxedCategories: ["VIDEO"],
    });
    expect(noOverlap.success).toBe(false);
    expect(noOverlap.success ? [] : noOverlap.error.issues.map((i) => i.path.join("."))).toContain(
      "relaxedCategories",
    );
    expect(policyFormSchema.safeParse({ ...base, categories: [] }).success).toBe(false);
    const nan = policyFormSchema.safeParse({ ...base, preShiftWarningMinutes: Number.NaN });
    expect(nan.success).toBe(false);
    expect(nan.success ? "" : nan.error.issues[0]?.message).toBe("Enter a whole number of minutes");
    expect(policyFormSchema.safeParse({ ...base, preShiftWarningMinutes: 121 }).success).toBe(
      false,
    );
  });

  it("PATCHes only what changed and returns null when nothing did", () => {
    const current = policy();
    expect(toUpdatePolicyInput(toPolicyFormValues(current), current)).toBeNull();

    const renamed = toUpdatePolicyInput({ ...toPolicyFormValues(current), name: "Bar" }, current);
    expect(renamed).toEqual({ name: "Bar" });

    const reconfigured = toUpdatePolicyInput(
      { ...toPolicyFormValues(current), preShiftWarningMinutes: 15 },
      current,
    );
    expect(reconfigured).not.toBeNull();
    expect(Object.keys(reconfigured ?? {})).toEqual(["restrictionConfig"]);
    expect(reconfigured?.restrictionConfig?.preShiftWarningMinutes).toBe(15);
    expect(updatePolicySchema.safeParse(reconfigured).success).toBe(true);

    const breaks = toUpdatePolicyInput(
      { ...toPolicyFormValues(current), restrictionBehaviour: "KEEP_RESTRICTIONS" },
      current,
    );
    expect(Object.keys(breaks ?? {})).toEqual(["breakBehaviourDefault"]);

    // Reordering categories is not a change.
    const reordered = toUpdatePolicyInput(
      { ...toPolicyFormValues(current), categories: ["GAMES", "SOCIAL_MEDIA"] },
      current,
    );
    expect(reordered).toBeNull();
  });
});

describe("version history", () => {
  it("summarises the diff between consecutive versions", () => {
    const v1 = version();
    const v2 = version({
      versionNumber: 2,
      restrictionConfig: {
        ...v1.restrictionConfig,
        categories: ["SOCIAL_MEDIA", "ENTERTAINMENT"],
        shieldMessage: "New message",
        preShiftWarningMinutes: 5,
      },
      breakBehaviourDefault: { restrictionBehaviour: "KEEP_RESTRICTIONS", relaxedCategories: [] },
    });
    expect(summariseVersionDiff(null, v1)).toEqual(["Initial version"]);
    expect(summariseVersionDiff(v1, v2)).toEqual([
      "Now restricts Entertainment",
      "No longer restricts Games",
      "Shield message updated",
      "Pre-shift warning: 10 → 5 min",
      "Break behaviour: Relax everything → Keep restrictions",
    ]);
    expect(summariseVersionDiff(v1, version())).toEqual(["No configuration changes"]);

    const history = describeVersionHistory([v1, v2]);
    expect(history.map((entry) => entry.version.versionNumber)).toEqual([2, 1]);
    expect(history[1]?.changes).toEqual(["Initial version"]);
  });
});

describe("guards", () => {
  it("only lets a published, non-archived, non-default policy become the default", () => {
    expect(setDefaultGuard(policy())).toEqual({ ok: true });
    expect(setDefaultGuard(policy({ isDefault: true })).ok).toBe(false);
    expect(setDefaultGuard(policy({ status: "ARCHIVED" })).ok).toBe(false);
    const draft = setDefaultGuard(
      policy({
        status: "DRAFT",
        currentVersion: null,
        draftVersion: version({ publishedAt: null }),
      }),
    );
    expect(draft).toEqual({
      ok: false,
      reason: "Publish this policy before making it the default.",
    });
  });

  it("assignments need a published policy", () => {
    expect(assignGuard(policy())).toEqual({ ok: true });
    expect(assignGuard(policy({ status: "DRAFT", currentVersion: null })).ok).toBe(false);
    expect(assignGuard(policy({ status: "ARCHIVED" })).ok).toBe(false);
  });

  it("blocks archiving while the policy is the default or assigned, listing every reason", () => {
    expect(archiveGuard(policy({ assignmentCount: 0 }))).toEqual({ blocked: false });
    const blocked = archiveGuard(policy({ isDefault: true, assignmentCount: 1 }));
    expect(blocked.blocked).toBe(true);
    expect(blocked.blocked ? blocked.reasons : []).toHaveLength(2);
    expect(blocked.blocked ? blocked.reasons[1] : "").toContain("assigned to 1 scope.");
  });
});

describe("list helpers", () => {
  it("sorts default first, then active, draft, archived, then by name", () => {
    const rows = [
      policy({ id: "a", name: "Zulu", status: "ARCHIVED" }),
      policy({ id: "b", name: "Bravo", status: "DRAFT", currentVersion: null }),
      policy({ id: "c", name: "Charlie" }),
      policy({ id: "d", name: "Alpha" }),
      policy({ id: "e", name: "Default", isDefault: true }),
    ];
    expect([...rows].sort(comparePolicies).map((row) => row.name)).toEqual([
      "Default",
      "Alpha",
      "Charlie",
      "Bravo",
      "Zulu",
    ]);
  });

  it("describes assignment targets honestly, including deleted ones", () => {
    expect(describeAssignmentScope(assignment())).toBe("Bar");
    expect(describeAssignmentScope(assignment({ scopeType: "ORGANISATION", scope: null }))).toBe(
      "Whole organisation",
    );
    expect(describeAssignmentScope(assignment({ scope: null }))).toBe("Deleted team");
  });

  it("treats an assignment as open until its effectiveTo has passed (the server's assignmentCount rule)", () => {
    expect(isAssignmentOpen(assignment(), NOW)).toBe(true);
    expect(isAssignmentOpen(assignment({ effectiveTo: "2026-10-07T00:00:00Z" }), NOW)).toBe(true);
    expect(isAssignmentOpen(assignment({ effectiveTo: "2026-10-06T12:00:00Z" }), NOW)).toBe(false);
    expect(isAssignmentOpen(assignment({ effectiveTo: "2026-10-01T00:00:00Z" }), NOW)).toBe(false);
    // Scheduled for later: open (it counts) but not active yet.
    const scheduled = assignment({
      id: "s",
      effectiveFrom: "2026-10-10T00:00:00Z",
      isActive: false,
    });
    expect(isAssignmentOpen(scheduled, NOW)).toBe(true);
    const ended = assignment({ id: "e", effectiveTo: "2026-10-05T00:00:00Z", isActive: false });
    expect(openAssignments([assignment(), scheduled, ended], NOW).map((a) => a.id)).toEqual([
      assignment().id,
      "s",
    ]);
  });

  it("indexes only the active assignments of one scope type", () => {
    const rows = [
      assignment(),
      assignment({ id: "x", scopeId: "inactive", isActive: false }),
      assignment({ id: "y", scopeType: "LOCATION", scopeId: "loc" }),
    ];
    const teams = activeAssignmentsByScopeId(rows, "TEAM");
    expect([...teams.keys()]).toEqual([assignment().scopeId]);
    expect([...activeAssignmentsByScopeId(rows, "LOCATION").keys()]).toEqual(["loc"]);
  });
});
