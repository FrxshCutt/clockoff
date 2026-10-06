import { describe, expect, it } from "vitest";
import { resolveWorkPolicy } from "./resolvePolicy";
import { resolvePolicyVersion } from "./resolvePolicyVersion";
import type { PolicyVersionLike, VersionedPolicyLike } from "./resolvePolicyVersion";
import { DEFAULT_RESTRICTION_CONFIG, createDefaultRestrictionConfig } from "./restrictionConfig";
import type { EmployeeContextLike } from "./types";

const PUBLISHED_AT = new Date("2026-09-01T09:00:00.000Z");

function version(overrides: Partial<PolicyVersionLike> = {}): PolicyVersionLike {
  return {
    id: "ver-1",
    versionNumber: 3,
    restrictionConfig: createDefaultRestrictionConfig(),
    publishedAt: PUBLISHED_AT,
    ...overrides,
  };
}

function policy(overrides: Partial<VersionedPolicyLike> = {}): VersionedPolicyLike {
  const v = overrides.currentVersion === undefined ? version() : overrides.currentVersion;
  return {
    id: "pol-1",
    status: "ACTIVE",
    deletedAt: null,
    currentVersionId: v?.id ?? null,
    currentVersion: v,
    ...overrides,
  };
}

describe("resolvePolicyVersion", () => {
  it("returns an empty snapshot and no warnings for a null policy", () => {
    expect(resolvePolicyVersion(null)).toEqual({
      versionId: null,
      versionNumber: null,
      publishedAt: null,
      restrictionConfig: null,
      warnings: [],
    });
  });

  it("returns the published current version's restrictionConfig", () => {
    const result = resolvePolicyVersion(policy());
    expect(result.versionId).toBe("ver-1");
    expect(result.versionNumber).toBe(3);
    expect(result.publishedAt).toBe(PUBLISHED_AT);
    expect(result.restrictionConfig).toEqual(DEFAULT_RESTRICTION_CONFIG);
    expect(result.warnings).toEqual([]);
  });

  it("a policy with no current version resolves to null with POLICY_NOT_PUBLISHED", () => {
    const result = resolvePolicyVersion(policy({ currentVersion: null, currentVersionId: null }));
    expect(result.restrictionConfig).toBeNull();
    expect(result.versionId).toBeNull();
    expect(result.warnings).toEqual([
      {
        code: "POLICY_NOT_PUBLISHED",
        message: "Policy pol-1 has no current version",
        details: { policyId: "pol-1", currentVersionId: null },
      },
    ]);
  });

  it("treats an absent currentVersion property like null", () => {
    const result = resolvePolicyVersion({ id: "pol-2", status: "DRAFT" });
    expect(result.restrictionConfig).toBeNull();
    expect(result.warnings[0]).toMatchObject({ code: "POLICY_NOT_PUBLISHED", details: { policyId: "pol-2", currentVersionId: null } });
  });

  it("a current version that was never published is not applied", () => {
    const unpublished = version({ id: "ver-draft", versionNumber: 4, publishedAt: null });
    const result = resolvePolicyVersion(policy({ currentVersion: unpublished, currentVersionId: unpublished.id }));
    expect(result.restrictionConfig).toBeNull();
    expect(result.versionId).toBeNull();
    expect(result.warnings).toEqual([
      {
        code: "POLICY_NOT_PUBLISHED",
        message: expect.stringContaining("ver-draft"),
        details: { policyId: "pol-1", currentVersionId: "ver-draft" },
      },
    ]);
  });

  it("reports an INVALID_RESTRICTION_CONFIG when the stored JSON does not match the type, keeping the version ids", () => {
    const bad = version({ restrictionConfig: { categories: ["NOT_A_CATEGORY"], requireEmployeeAppSelection: "yes" } });
    const result = resolvePolicyVersion(policy({ currentVersion: bad }));
    expect(result.versionId).toBe("ver-1");
    expect(result.versionNumber).toBe(3);
    expect(result.publishedAt).toBe(PUBLISHED_AT);
    expect(result.restrictionConfig).toBeNull();
    expect(result.warnings).toEqual([
      {
        code: "INVALID_RESTRICTION_CONFIG",
        message: expect.stringContaining("ver-1"),
        details: { policyId: "pol-1", versionId: "ver-1" },
      },
    ]);
  });

  it("reports POLICY_VERSION_NOT_LOADED (not POLICY_NOT_PUBLISHED) when currentVersionId is set but the version was not included", () => {
    // Prisma without `include: { currentVersion: true }`: the relation property is simply absent.
    const result = resolvePolicyVersion({ id: "pol-3", status: "ACTIVE", deletedAt: null, currentVersionId: "ver-9" });
    expect(result).toEqual({
      versionId: null,
      versionNumber: null,
      publishedAt: null,
      restrictionConfig: null,
      warnings: [
        {
          code: "POLICY_VERSION_NOT_LOADED",
          message: expect.stringContaining("include currentVersion"),
          details: { policyId: "pol-3", currentVersionId: "ver-9", suppliedVersionId: null },
        },
      ],
    });
    const explicitNull = resolvePolicyVersion(policy({ currentVersion: null, currentVersionId: "ver-9" }));
    expect(explicitNull.warnings.map((w) => w.code)).toEqual(["POLICY_VERSION_NOT_LOADED"]);
  });

  it("refuses a supplied version that is not the policy's current version", () => {
    const stale = version({ id: "ver-old", versionNumber: 2 });
    const result = resolvePolicyVersion(policy({ currentVersion: stale, currentVersionId: "ver-new" }));
    expect(result.restrictionConfig).toBeNull();
    expect(result.versionId).toBeNull();
    expect(result.warnings).toEqual([
      {
        code: "POLICY_VERSION_NOT_LOADED",
        message: expect.stringContaining("ver-old"),
        details: { policyId: "pol-1", currentVersionId: "ver-new", suppliedVersionId: "ver-old" },
      },
    ]);
  });

  it("trusts currentVersion when the shape carries no currentVersionId", () => {
    const { currentVersionId: _omitted, ...withoutId } = policy();
    const result = resolvePolicyVersion(withoutId);
    expect(result.versionId).toBe("ver-1");
    expect(result.restrictionConfig).toEqual(DEFAULT_RESTRICTION_CONFIG);
    expect(result.warnings).toEqual([]);
  });

  it("accepts a config without the optional shieldMessage", () => {
    const { shieldMessage: _omitted, ...withoutShield } = createDefaultRestrictionConfig();
    const result = resolvePolicyVersion(policy({ currentVersion: version({ restrictionConfig: withoutShield }) }));
    expect(result.restrictionConfig).toEqual(withoutShield);
    expect(result.warnings).toEqual([]);
  });
});

describe("resolveWorkPolicy", () => {
  const ORG = "org-1";
  const EMP = "emp-1";
  const employee: EmployeeContextLike = { employeeId: EMP, organisationId: ORG, teamIds: [], primaryLocationId: null };
  const NOW = new Date("2026-10-05T12:00:00.000Z");

  it("composes resolution and version lookup, merging warnings", () => {
    const published = policy({ id: "pol-pub" });
    const archived = policy({ id: "pol-arch", status: "ARCHIVED" });
    const result = resolveWorkPolicy({
      employee,
      assignments: [
        { id: "a-1", scopeType: "EMPLOYEE", scopeId: EMP, policyId: archived.id, createdAt: NOW },
        { id: "a-2", scopeType: "ORGANISATION", scopeId: ORG, policyId: published.id, createdAt: NOW },
      ],
      policiesById: { [published.id]: published, [archived.id]: archived },
      now: NOW,
    });
    expect(result.policy).toBe(published);
    expect(result.resolvedFrom).toEqual({ via: "ASSIGNMENT", scopeType: "ORGANISATION", scopeId: ORG, assignmentId: "a-2" });
    expect(result.version).toEqual({
      versionId: "ver-1",
      versionNumber: 3,
      publishedAt: PUBLISHED_AT,
      restrictionConfig: DEFAULT_RESTRICTION_CONFIG,
    });
    expect(result.warnings.map((w) => w.code)).toEqual(["INACTIVE_POLICY_SKIPPED"]);
  });

  it("surfaces POLICY_NOT_PUBLISHED alongside resolution warnings", () => {
    const draft = policy({ id: "pol-draft", status: "DRAFT", currentVersion: null, currentVersionId: null });
    const result = resolveWorkPolicy({
      employee,
      assignments: [],
      policiesById: { [draft.id]: draft },
      organisationDefaultPolicyId: draft.id,
      now: NOW,
    });
    expect(result.policy).toBe(draft);
    expect(result.resolvedFrom?.via).toBe("DEFAULT");
    expect(result.version.restrictionConfig).toBeNull();
    expect(result.warnings.map((w) => w.code)).toEqual(["POLICY_NOT_PUBLISHED"]);
  });

  it("surfaces POLICY_VERSION_NOT_LOADED for a resolved policy loaded without its version", () => {
    const { currentVersion: _omitted, ...notIncluded } = policy({ id: "pol-ni" });
    const result = resolveWorkPolicy({
      employee,
      assignments: [{ id: "a-1", scopeType: "EMPLOYEE", scopeId: EMP, policyId: notIncluded.id, createdAt: NOW }],
      policiesById: { [notIncluded.id]: notIncluded },
      now: NOW,
    });
    expect(result.policy).toBe(notIncluded);
    expect(result.version.restrictionConfig).toBeNull();
    expect(result.warnings.map((w) => w.code)).toEqual(["POLICY_VERSION_NOT_LOADED"]);
  });

  it("returns an all-null version when nothing resolves", () => {
    const result = resolveWorkPolicy({ employee, assignments: [], policiesById: {}, now: NOW });
    expect(result.policy).toBeNull();
    expect(result.resolvedFrom).toBeNull();
    expect(result.version).toEqual({ versionId: null, versionNumber: null, publishedAt: null, restrictionConfig: null });
    expect(result.warnings).toEqual([]);
  });
});
