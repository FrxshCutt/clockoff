import { describe, expect, expectTypeOf, it } from "vitest";
import * as barrel from "../index";
import * as policyEntry from "./resolvePolicy";
import type {
  AssignmentLike,
  BreakPolicyAssignmentLike,
  EmployeeContextLike,
  PolicyLike,
  PolicyVersionSnapshot,
  ResolutionWarning,
  ResolvedFrom,
  ResolvedWorkPolicy,
  ResolveInput,
  ResolveResult,
  RestrictionConfig,
  VersionedPolicyLike,
} from "./resolvePolicy";

/** Runtime API of the policy module; both documented import paths must expose all of it. */
const RUNTIME_EXPORTS = [
  "POLICY_SCOPE_PRECEDENCE",
  "POLICY_RESOLUTION_WARNING_CODES",
  "resolvePolicy",
  "resolveWorkPolicy",
  "resolvePolicyVersion",
  "isAssignmentActive",
  "isPolicyUsable",
  "compareAssignmentsNewestFirst",
  "indexPoliciesById",
  "fromBreakPolicyAssignment",
  "explainResolution",
  "SCOPE_TYPE_LABELS",
  "resolutionWarningKey",
  "DEFAULT_RESTRICTION_CONFIG",
  "createDefaultRestrictionConfig",
  "isRestrictionConfig",
] as const;

// Structural copies of the generated Prisma rows (shared must not depend on @workmode/db).
interface PrismaPolicyVersionRow {
  id: string;
  policyId: string;
  versionNumber: number;
  restrictionConfig: unknown;
  breakBehaviourDefault: unknown;
  createdById: string | null;
  changeNote: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
interface PrismaPolicyRow {
  id: string;
  organisationId: string;
  name: string;
  description: string | null;
  status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  currentVersionId: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
type PrismaPolicyWithVersion = PrismaPolicyRow & { currentVersion: PrismaPolicyVersionRow | null };
interface PrismaAssignmentRow {
  id: string;
  organisationId: string;
  policyId: string;
  scopeType: "ORGANISATION" | "LOCATION" | "TEAM" | "EMPLOYEE";
  scopeId: string;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}
interface PrismaBreakPolicyRow {
  id: string;
  organisationId: string;
  name: string;
  maxBreaksPerShift: number;
  status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  deletedAt: Date | null;
}
type PrismaBreakAssignmentRow = Omit<PrismaAssignmentRow, "policyId"> & { breakPolicyId: string };

describe("policy module exports", () => {
  it("exposes the full runtime API from '@workmode/shared/policy/resolvePolicy' and the '@workmode/shared' barrel", () => {
    for (const name of RUNTIME_EXPORTS) {
      expect(policyEntry[name], name).toBeDefined();
      expect(barrel[name], name).toBe(policyEntry[name]);
    }
  });

  it("accepts Prisma-shaped rows as-is and keeps the concrete policy type in the result", () => {
    expectTypeOf<PrismaPolicyWithVersion>().toExtend<VersionedPolicyLike>();
    expectTypeOf<PrismaPolicyRow>().toExtend<PolicyLike>();
    expectTypeOf<PrismaAssignmentRow>().toExtend<AssignmentLike>();
    expectTypeOf<PrismaAssignmentRow>().toExtend<AssignmentLike<PrismaPolicyRow>>();
    expectTypeOf<PrismaBreakAssignmentRow>().toExtend<BreakPolicyAssignmentLike>();
    expectTypeOf<PrismaBreakPolicyRow>().toExtend<PolicyLike>();

    expectTypeOf(policyEntry.resolveWorkPolicy<PrismaPolicyWithVersion>).returns.toEqualTypeOf<
      ResolvedWorkPolicy<PrismaPolicyWithVersion>
    >();
    expectTypeOf<
      ResolvedWorkPolicy<PrismaPolicyWithVersion>["policy"]
    >().toEqualTypeOf<PrismaPolicyWithVersion | null>();
    expectTypeOf<
      ResolvedWorkPolicy<PrismaPolicyWithVersion>["version"]
    >().toEqualTypeOf<PolicyVersionSnapshot>();
    expectTypeOf<
      PolicyVersionSnapshot["restrictionConfig"]
    >().toEqualTypeOf<RestrictionConfig | null>();
    expectTypeOf<
      ResolveResult<PrismaBreakPolicyRow>["policy"]
    >().toEqualTypeOf<PrismaBreakPolicyRow | null>();
    expectTypeOf<
      ResolveInput<PrismaBreakPolicyRow>["employee"]
    >().toEqualTypeOf<EmployeeContextLike>();
  });

  it("infers T from policiesById (not from the assignments) so the result is not widened", () => {
    const now = new Date("2026-10-05T12:00:00.000Z");
    const bp: PrismaBreakPolicyRow = {
      id: "bp-1",
      organisationId: "org-1",
      name: "Strict",
      maxBreaksPerShift: 1,
      status: "ACTIVE",
      deletedAt: null,
    };
    const row: PrismaBreakAssignmentRow = {
      id: "bpa-1",
      organisationId: "org-1",
      breakPolicyId: bp.id,
      scopeType: "EMPLOYEE",
      scopeId: "emp-1",
      effectiveFrom: null,
      effectiveTo: null,
      createdById: null,
      createdAt: now,
      updatedAt: now,
    };
    const result = policyEntry.resolvePolicy({
      employee: { employeeId: "emp-1", organisationId: "org-1", teamIds: [] },
      assignments: [row].map(policyEntry.fromBreakPolicyAssignment),
      policiesById: policyEntry.indexPoliciesById([bp]),
      now,
    });
    expectTypeOf(result.policy).toEqualTypeOf<PrismaBreakPolicyRow | null>();
    expect(result.policy?.maxBreaksPerShift).toBe(1);
  });

  it("discriminates ResolvedFrom on `via` and ResolutionWarning on `code`", () => {
    expectTypeOf<ResolvedFrom["via"]>().toEqualTypeOf<"ASSIGNMENT" | "DEFAULT">();
    expectTypeOf<Extract<ResolvedFrom, { via: "DEFAULT" }>>().not.toHaveProperty("assignmentId");
    expectTypeOf<
      Extract<ResolutionWarning, { code: "POLICY_ORGANISATION_MISMATCH" }>["details"]
    >().toHaveProperty("policyOrganisationId");
  });
});
