import { describe, expect, expectTypeOf, it } from "vitest";
import { indexPoliciesById, resolvePolicy } from "./resolvePolicy";
import { resolvePolicyVersion } from "./resolvePolicyVersion";
import type {
  AssignmentLike,
  EmployeeContextLike,
  PolicyLike,
  PolicyResolutionWarningCode,
  ResolutionWarning,
} from "./types";
import { POLICY_RESOLUTION_WARNING_CODES } from "./types";
import { resolutionWarningKey } from "./warnings";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const hoursAgo = (h: number): Date => new Date(NOW.getTime() - h * 3_600_000);

const employee: EmployeeContextLike = {
  employeeId: "emp-1",
  organisationId: "org-1",
  teamIds: ["team-a", "team-b"],
  primaryLocationId: "loc-1",
};

const policy = (id: string, overrides: Partial<PolicyLike> = {}): PolicyLike => ({
  id,
  status: "ACTIVE",
  deletedAt: null,
  ...overrides,
});

const teamA: AssignmentLike = {
  id: "a-1",
  scopeType: "TEAM",
  scopeId: "team-a",
  policyId: "p-a",
  createdAt: hoursAgo(10),
};
const teamB: AssignmentLike = {
  id: "a-2",
  scopeType: "TEAM",
  scopeId: "team-b",
  policyId: "p-b",
  createdAt: hoursAgo(2),
};

function ambiguous(assignments: readonly AssignmentLike[], now = NOW): ResolutionWarning {
  const result = resolvePolicy({
    employee,
    assignments,
    policiesById: indexPoliciesById([policy("p-a"), policy("p-b"), policy("p-c")]),
    now,
  });
  const warning = result.warnings.find((w) => w.code === "AMBIGUOUS_TEAM_ASSIGNMENT");
  if (warning === undefined) throw new Error("expected an AMBIGUOUS_TEAM_ASSIGNMENT warning");
  return warning;
}

describe("resolutionWarningKey", () => {
  it("is stable across `now` and input order for an unchanged condition", () => {
    const k1 = resolutionWarningKey(ambiguous([teamA, teamB]));
    const k2 = resolutionWarningKey(ambiguous([teamB, teamA], new Date(NOW.getTime() + 3_600_000)));
    expect(k2).toBe(k1);
    expect(k1.startsWith("AMBIGUOUS_TEAM_ASSIGNMENT:a-2:")).toBe(true);
  });

  it("changes when the condition changes (a team's policy is repointed, or the winner changes)", () => {
    const base = resolutionWarningKey(ambiguous([teamA, teamB]));
    const repointed = resolutionWarningKey(ambiguous([{ ...teamA, policyId: "p-c" }, teamB]));
    const newWinner = resolutionWarningKey(
      ambiguous([{ ...teamA, createdAt: hoursAgo(1) }, teamB]),
    );
    expect(new Set([base, repointed, newWinner]).size).toBe(3);
  });

  it("ignores message wording", () => {
    const warning = ambiguous([teamA, teamB]);
    expect(resolutionWarningKey({ ...warning, message: "reworded" })).toBe(
      resolutionWarningKey(warning),
    );
  });

  it("distinguishes skipping a policy because it was archived from because it was deleted", () => {
    const asg: AssignmentLike = {
      id: "a-e",
      scopeType: "EMPLOYEE",
      scopeId: "emp-1",
      policyId: "p-x",
      createdAt: hoursAgo(1),
    };
    const key = (p: PolicyLike): string => {
      const w = resolvePolicy({
        employee,
        assignments: [asg],
        policiesById: { [p.id]: p },
        now: NOW,
      }).warnings[0];
      if (w === undefined) throw new Error("expected a warning");
      return resolutionWarningKey(w);
    };
    const archived = key(policy("p-x", { status: "ARCHIVED" }));
    const deleted = key(policy("p-x", { deletedAt: hoursAgo(3) }));
    const deletedLater = key(policy("p-x", { deletedAt: hoursAgo(2) }));
    expect(archived).toBe("INACTIVE_POLICY_SKIPPED:ASSIGNMENT:EMPLOYEE:emp-1:a-e:p-x:ARCHIVED:-");
    expect(deleted).not.toBe(archived);
    expect(deletedLater).toBe(deleted);
  });

  it("keys version warnings by policy and version", () => {
    const unpublished = resolvePolicyVersion({
      ...policy("p-1"),
      currentVersionId: "v-1",
      currentVersion: { id: "v-1", versionNumber: 1, restrictionConfig: {}, publishedAt: null },
    }).warnings[0];
    const invalid = resolvePolicyVersion({
      ...policy("p-1"),
      currentVersion: {
        id: "v-2",
        versionNumber: 2,
        restrictionConfig: { nope: true },
        publishedAt: NOW,
      },
    }).warnings[0];
    const noVersion = resolvePolicyVersion(policy("p-1")).warnings[0];
    if (unpublished === undefined || invalid === undefined || noVersion === undefined)
      throw new Error("expected warnings");
    expect(resolutionWarningKey(unpublished)).toBe("POLICY_NOT_PUBLISHED:p-1:v-1");
    expect(resolutionWarningKey(noVersion)).toBe("POLICY_NOT_PUBLISHED:p-1:-");
    expect(resolutionWarningKey(invalid)).toBe("INVALID_RESTRICTION_CONFIG:p-1:v-2");
  });

  it("produces a key for every warning code, prefixed with that code", () => {
    const samples: Record<ResolutionWarning["code"], ResolutionWarning> = {
      AMBIGUOUS_TEAM_ASSIGNMENT: ambiguous([teamA, teamB]),
      DUPLICATE_SCOPE_ASSIGNMENT: {
        code: "DUPLICATE_SCOPE_ASSIGNMENT",
        message: "m",
        details: {
          scopeType: "EMPLOYEE",
          scopeId: "emp-1",
          assignmentIds: ["d-2", "d-1"],
          winnerAssignmentId: "d-2",
        },
      },
      INACTIVE_POLICY_SKIPPED: {
        code: "INACTIVE_POLICY_SKIPPED",
        message: "m",
        details: {
          policyId: "p",
          status: "ARCHIVED",
          deletedAt: null,
          via: "DEFAULT",
          scopeType: "ORGANISATION",
          scopeId: "org-1",
          assignmentId: null,
        },
      },
      POLICY_ORGANISATION_MISMATCH: {
        code: "POLICY_ORGANISATION_MISMATCH",
        message: "m",
        details: {
          policyId: "p",
          policyOrganisationId: "org-2",
          organisationId: "org-1",
          via: "ASSIGNMENT",
          scopeType: "EMPLOYEE",
          scopeId: "emp-1",
          assignmentId: "a-9",
        },
      },
      POLICY_NOT_LOADED: {
        code: "POLICY_NOT_LOADED",
        message: "m",
        details: {
          policyId: "p",
          via: "ASSIGNMENT",
          scopeType: "TEAM",
          scopeId: "team-a",
          assignmentId: "a-1",
        },
      },
      POLICY_NOT_PUBLISHED: {
        code: "POLICY_NOT_PUBLISHED",
        message: "m",
        details: { policyId: "p", currentVersionId: null },
      },
      POLICY_VERSION_NOT_LOADED: {
        code: "POLICY_VERSION_NOT_LOADED",
        message: "m",
        details: { policyId: "p", currentVersionId: "v-3", suppliedVersionId: null },
      },
      INVALID_RESTRICTION_CONFIG: {
        code: "INVALID_RESTRICTION_CONFIG",
        message: "m",
        details: { policyId: "p", versionId: "v" },
      },
    };
    for (const code of POLICY_RESOLUTION_WARNING_CODES) {
      expect(resolutionWarningKey(samples[code]).startsWith(`${code}:`)).toBe(true);
    }
    expect(resolutionWarningKey(samples.DUPLICATE_SCOPE_ASSIGNMENT)).toBe(
      "DUPLICATE_SCOPE_ASSIGNMENT:EMPLOYEE:emp-1:d-2:d-1:d-2",
    );
    expect(resolutionWarningKey(samples.INACTIVE_POLICY_SKIPPED)).toBe(
      "INACTIVE_POLICY_SKIPPED:DEFAULT:ORGANISATION:org-1:-:p:ARCHIVED:-",
    );
    expect(resolutionWarningKey(samples.POLICY_ORGANISATION_MISMATCH)).toBe(
      "POLICY_ORGANISATION_MISMATCH:ASSIGNMENT:EMPLOYEE:emp-1:a-9:p:org-2",
    );
    expect(resolutionWarningKey(samples.POLICY_VERSION_NOT_LOADED)).toBe(
      "POLICY_VERSION_NOT_LOADED:p:v-3:-",
    );
    expect(
      resolutionWarningKey({
        code: "POLICY_VERSION_NOT_LOADED",
        message: "m",
        details: { policyId: "p", currentVersionId: "v-3", suppliedVersionId: "v-2" },
      }),
    ).toBe("POLICY_VERSION_NOT_LOADED:p:v-3:v-2");
  });

  it("gives distinct keys to distinct conditions across every code", () => {
    const keys = [
      resolutionWarningKey(ambiguous([teamA, teamB])),
      resolutionWarningKey(ambiguous([{ ...teamA, policyId: "p-c" }, teamB])),
      resolutionWarningKey({
        code: "POLICY_NOT_LOADED",
        message: "m",
        details: {
          policyId: "p",
          via: "DEFAULT",
          scopeType: "ORGANISATION",
          scopeId: "org-1",
          assignmentId: null,
        },
      }),
      resolutionWarningKey({
        code: "POLICY_NOT_LOADED",
        message: "m",
        details: {
          policyId: "p",
          via: "ASSIGNMENT",
          scopeType: "ORGANISATION",
          scopeId: "org-1",
          assignmentId: "a-1",
        },
      }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps POLICY_RESOLUTION_WARNING_CODES and the ResolutionWarning union in sync (type level)", () => {
    expectTypeOf<ResolutionWarning["code"]>().toEqualTypeOf<PolicyResolutionWarningCode>();
    expect(new Set(POLICY_RESOLUTION_WARNING_CODES).size).toBe(
      POLICY_RESOLUTION_WARNING_CODES.length,
    );
  });
});
