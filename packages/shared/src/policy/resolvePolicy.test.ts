import { describe, expect, it } from "vitest";
import type { BreakRestrictionBehaviour } from "../enums";
import {
  compareAssignmentsNewestFirst,
  fromBreakPolicyAssignment,
  indexPoliciesById,
  isAssignmentActive,
  isPolicyUsable,
  POLICY_SCOPE_PRECEDENCE,
  resolvePolicy,
} from "./resolvePolicy";
import type { AssignmentLike, EmployeeContextLike, PolicyLike, ResolutionWarning, ResolvedFrom } from "./types";

const ORG = "11111111-1111-4111-8111-111111111111";
const EMP = "22222222-2222-4222-8222-222222222222";
const TEAM_A = "33333333-3333-4333-8333-333333333333";
const TEAM_B = "44444444-4444-4444-8444-444444444444";
const LOC = "55555555-5555-4555-8555-555555555555";
const LOC_SECONDARY = "66666666-6666-4666-8666-666666666666";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const hoursAgo = (h: number): Date => new Date(NOW.getTime() - h * 3_600_000);
const hoursAhead = (h: number): Date => new Date(NOW.getTime() + h * 3_600_000);

interface TestPolicy extends PolicyLike {
  name: string;
}

function policy(id: string, overrides: Partial<TestPolicy> = {}): TestPolicy {
  return { id, name: `Policy ${id}`, status: "ACTIVE", deletedAt: null, ...overrides };
}

let seq = 0;
function assignment(partial: Partial<AssignmentLike> & Pick<AssignmentLike, "scopeType" | "scopeId" | "policyId">): AssignmentLike {
  seq += 1;
  return {
    id: partial.id ?? `asg-${String(seq).padStart(3, "0")}`,
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: hoursAgo(24),
    ...partial,
  };
}

const employee: EmployeeContextLike = {
  employeeId: EMP,
  organisationId: ORG,
  teamIds: [TEAM_A],
  primaryLocationId: LOC,
  locationIds: [LOC, LOC_SECONDARY],
};

const P_EMP = policy("p-emp");
const P_TEAM = policy("p-team");
const P_TEAM_B = policy("p-team-b");
const P_LOC = policy("p-loc");
const P_ORG = policy("p-org");
const P_DEFAULT = policy("p-default");

const ALL_POLICIES = indexPoliciesById([P_EMP, P_TEAM, P_TEAM_B, P_LOC, P_ORG, P_DEFAULT]);

const A_EMP = assignment({ id: "a-emp", scopeType: "EMPLOYEE", scopeId: EMP, policyId: P_EMP.id });
const A_TEAM = assignment({ id: "a-team", scopeType: "TEAM", scopeId: TEAM_A, policyId: P_TEAM.id });
const A_LOC = assignment({ id: "a-loc", scopeType: "LOCATION", scopeId: LOC, policyId: P_LOC.id });
const A_ORG = assignment({ id: "a-org", scopeType: "ORGANISATION", scopeId: ORG, policyId: P_ORG.id });

function codes(warnings: ResolutionWarning[]): string[] {
  return warnings.map((w) => w.code);
}

function assignmentIdOf(from: ResolvedFrom | null): string | null {
  return from?.via === "ASSIGNMENT" ? from.assignmentId : null;
}

describe("resolvePolicy — precedence", () => {
  it("consults levels in the documented order", () => {
    expect(POLICY_SCOPE_PRECEDENCE).toEqual(["EMPLOYEE", "TEAM", "LOCATION", "ORGANISATION"]);
  });

  it("EMPLOYEE beats TEAM, LOCATION, ORGANISATION and the default", () => {
    const result = resolvePolicy({
      employee,
      assignments: [A_ORG, A_LOC, A_TEAM, A_EMP],
      policiesById: ALL_POLICIES,
      organisationDefaultPolicyId: P_DEFAULT.id,
      now: NOW,
    });
    expect(result.policy).toBe(P_EMP);
    expect(result.policyId).toBe(P_EMP.id);
    expect(result.resolvedFrom).toEqual({ via: "ASSIGNMENT", scopeType: "EMPLOYEE", scopeId: EMP, assignmentId: "a-emp" });
    expect(result.warnings).toEqual([]);
  });

  it("TEAM beats LOCATION, ORGANISATION and the default", () => {
    const result = resolvePolicy({
      employee,
      assignments: [A_ORG, A_LOC, A_TEAM],
      policiesById: ALL_POLICIES,
      organisationDefaultPolicyId: P_DEFAULT.id,
      now: NOW,
    });
    expect(result.policy).toBe(P_TEAM);
    expect(result.resolvedFrom).toEqual({ via: "ASSIGNMENT", scopeType: "TEAM", scopeId: TEAM_A, assignmentId: "a-team" });
    expect(result.warnings).toEqual([]);
  });

  it("LOCATION (primary) beats ORGANISATION and the default", () => {
    const result = resolvePolicy({
      employee,
      assignments: [A_ORG, A_LOC],
      policiesById: ALL_POLICIES,
      organisationDefaultPolicyId: P_DEFAULT.id,
      now: NOW,
    });
    expect(result.policy).toBe(P_LOC);
    expect(result.resolvedFrom).toEqual({ via: "ASSIGNMENT", scopeType: "LOCATION", scopeId: LOC, assignmentId: "a-loc" });
  });

  it("an ORGANISATION-scope assignment beats the organisation default id", () => {
    const result = resolvePolicy({
      employee,
      assignments: [A_ORG],
      policiesById: ALL_POLICIES,
      organisationDefaultPolicyId: P_DEFAULT.id,
      now: NOW,
    });
    expect(result.policy).toBe(P_ORG);
    expect(result.resolvedFrom).toEqual({ via: "ASSIGNMENT", scopeType: "ORGANISATION", scopeId: ORG, assignmentId: "a-org" });
  });

  it("falls back to the organisation default when no assignment applies", () => {
    const result = resolvePolicy({
      employee,
      assignments: [],
      policiesById: ALL_POLICIES,
      organisationDefaultPolicyId: P_DEFAULT.id,
      now: NOW,
    });
    expect(result.policy).toBe(P_DEFAULT);
    expect(result.policyId).toBe(P_DEFAULT.id);
    expect(result.resolvedFrom).toEqual({ via: "DEFAULT", scopeType: "ORGANISATION", scopeId: ORG });
    expect(result.warnings).toEqual([]);
  });

  it("resolves to nothing when there are no assignments and no default", () => {
    for (const defaultId of [undefined, null]) {
      const result = resolvePolicy({
        employee,
        assignments: [],
        policiesById: ALL_POLICIES,
        organisationDefaultPolicyId: defaultId,
        now: NOW,
      });
      expect(result).toEqual({ policy: null, policyId: null, resolvedFrom: null, warnings: [] });
    }
  });

  it("ignores assignments for other employees, teams, locations and organisations", () => {
    const result = resolvePolicy({
      employee,
      assignments: [
        assignment({ scopeType: "EMPLOYEE", scopeId: "someone-else", policyId: P_EMP.id }),
        assignment({ scopeType: "TEAM", scopeId: TEAM_B, policyId: P_TEAM_B.id }),
        assignment({ scopeType: "LOCATION", scopeId: LOC_SECONDARY, policyId: P_LOC.id }),
        assignment({ scopeType: "ORGANISATION", scopeId: "other-org", policyId: P_ORG.id }),
      ],
      policiesById: ALL_POLICIES,
      organisationDefaultPolicyId: P_DEFAULT.id,
      now: NOW,
    });
    expect(result.policy).toBe(P_DEFAULT);
    expect(result.warnings).toEqual([]);
  });

  it("only the PRIMARY location participates; secondary locations never resolve", () => {
    const secondaryOnly = assignment({ scopeType: "LOCATION", scopeId: LOC_SECONDARY, policyId: P_LOC.id });
    const noPrimary = resolvePolicy({
      employee: { ...employee, primaryLocationId: null, locationIds: [LOC_SECONDARY] },
      assignments: [secondaryOnly, A_ORG],
      policiesById: ALL_POLICIES,
      now: NOW,
    });
    expect(noPrimary.policy).toBe(P_ORG);
    expect(noPrimary.resolvedFrom?.scopeType).toBe("ORGANISATION");
  });
});

describe("resolvePolicy — multiple teams", () => {
  const older = assignment({ id: "a-team-a", scopeType: "TEAM", scopeId: TEAM_A, policyId: P_TEAM.id, createdAt: hoursAgo(48) });
  const newer = assignment({ id: "a-team-b", scopeType: "TEAM", scopeId: TEAM_B, policyId: P_TEAM_B.id, createdAt: hoursAgo(1) });
  const twoTeams: EmployeeContextLike = { ...employee, teamIds: [TEAM_A, TEAM_B] };

  it("the most recently created active assignment wins and an AMBIGUOUS_TEAM_ASSIGNMENT warning is emitted", () => {
    const result = resolvePolicy({ employee: twoTeams, assignments: [older, newer], policiesById: ALL_POLICIES, now: NOW });
    expect(result.policy).toBe(P_TEAM_B);
    expect(result.resolvedFrom).toEqual({ via: "ASSIGNMENT", scopeType: "TEAM", scopeId: TEAM_B, assignmentId: "a-team-b" });
    expect(codes(result.warnings)).toEqual(["AMBIGUOUS_TEAM_ASSIGNMENT"]);
    const warning = result.warnings[0]!;
    if (warning.code !== "AMBIGUOUS_TEAM_ASSIGNMENT") throw new Error("wrong code");
    expect(warning.details.winnerAssignmentId).toBe("a-team-b");
    expect(warning.details.candidates.map((c) => c.assignmentId)).toEqual(["a-team-b", "a-team-a"]);
    expect(warning.details.candidates[0]!.createdAt).toBe(hoursAgo(1).toISOString());
    expect(warning.message).toContain("2 teams");
  });

  it("is independent of input order and of teamIds order", () => {
    const a = resolvePolicy({ employee: twoTeams, assignments: [older, newer], policiesById: ALL_POLICIES, now: NOW });
    const b = resolvePolicy({
      employee: { ...twoTeams, teamIds: [TEAM_B, TEAM_A] },
      assignments: [newer, older],
      policiesById: ALL_POLICIES,
      now: NOW,
    });
    expect(b).toEqual(a);
  });

  it("does not warn when every team resolves to the same policy", () => {
    const sameNewer = { ...newer, policyId: P_TEAM.id };
    const result = resolvePolicy({ employee: twoTeams, assignments: [older, sameNewer], policiesById: ALL_POLICIES, now: NOW });
    expect(result.policy).toBe(P_TEAM);
    expect(assignmentIdOf(result.resolvedFrom)).toBe("a-team-b");
    expect(result.warnings).toEqual([]);
  });

  it("an EMPLOYEE assignment still wins over an ambiguous team situation, without a warning", () => {
    const result = resolvePolicy({ employee: twoTeams, assignments: [older, newer, A_EMP], policiesById: ALL_POLICIES, now: NOW });
    expect(result.policy).toBe(P_EMP);
    expect(result.warnings).toEqual([]);
  });

  it("judges ambiguity on each team's own winner, so a stale duplicate row inside one team does not create it", () => {
    // TEAM_A: newest row -> P_TEAM, stale older row -> P_TEAM_B. TEAM_B -> P_TEAM. Every team's winner is P_TEAM.
    const aNew = assignment({ id: "ta-new", scopeType: "TEAM", scopeId: TEAM_A, policyId: P_TEAM.id, createdAt: hoursAgo(1) });
    const aStale = assignment({ id: "ta-stale", scopeType: "TEAM", scopeId: TEAM_A, policyId: P_TEAM_B.id, createdAt: hoursAgo(30) });
    const b = assignment({ id: "tb", scopeType: "TEAM", scopeId: TEAM_B, policyId: P_TEAM.id, createdAt: hoursAgo(5) });
    const result = resolvePolicy({ employee: twoTeams, assignments: [aStale, b, aNew], policiesById: ALL_POLICIES, now: NOW });
    expect(result.policy).toBe(P_TEAM);
    expect(assignmentIdOf(result.resolvedFrom)).toBe("ta-new");
    expect(codes(result.warnings)).toEqual(["DUPLICATE_SCOPE_ASSIGNMENT"]);
  });

  it("lists one candidate per team (each team's newest row) in the ambiguity warning", () => {
    const aNew = assignment({ id: "ta-new", scopeType: "TEAM", scopeId: TEAM_A, policyId: P_TEAM.id, createdAt: hoursAgo(10) });
    const aOld = assignment({ id: "ta-old", scopeType: "TEAM", scopeId: TEAM_A, policyId: P_TEAM.id, createdAt: hoursAgo(20) });
    const b = assignment({ id: "tb", scopeType: "TEAM", scopeId: TEAM_B, policyId: P_TEAM_B.id, createdAt: hoursAgo(2) });
    const result = resolvePolicy({ employee: twoTeams, assignments: [aOld, aNew, b], policiesById: ALL_POLICIES, now: NOW });
    expect(result.policy).toBe(P_TEAM_B);
    expect(codes(result.warnings)).toEqual(["DUPLICATE_SCOPE_ASSIGNMENT", "AMBIGUOUS_TEAM_ASSIGNMENT"]);
    const warning = result.warnings[1]!;
    if (warning.code !== "AMBIGUOUS_TEAM_ASSIGNMENT") throw new Error("wrong code");
    expect(warning.details.candidates.map((c) => c.assignmentId)).toEqual(["tb", "ta-new"]);
    expect(warning.details.winnerAssignmentId).toBe("tb");
  });

  it("breaks exact createdAt ties by descending id so the result is total and deterministic", () => {
    const sameInstant = hoursAgo(5);
    const x = assignment({ id: "a-x", scopeType: "TEAM", scopeId: TEAM_A, policyId: P_TEAM.id, createdAt: sameInstant });
    const y = assignment({ id: "a-y", scopeType: "TEAM", scopeId: TEAM_B, policyId: P_TEAM_B.id, createdAt: sameInstant });
    const r1 = resolvePolicy({ employee: twoTeams, assignments: [x, y], policiesById: ALL_POLICIES, now: NOW });
    const r2 = resolvePolicy({ employee: twoTeams, assignments: [y, x], policiesById: ALL_POLICIES, now: NOW });
    expect(assignmentIdOf(r1.resolvedFrom)).toBe("a-y");
    expect(r2).toEqual(r1);
    expect([x, y].sort(compareAssignmentsNewestFirst).map((a) => a.id)).toEqual(["a-y", "a-x"]);
  });
});

describe("resolvePolicy — effective windows", () => {
  it("ignores an assignment whose effectiveTo is in the past and falls through", () => {
    const expired = { ...A_EMP, effectiveTo: hoursAgo(1) };
    const result = resolvePolicy({ employee, assignments: [expired, A_TEAM], policiesById: ALL_POLICIES, now: NOW });
    expect(result.policy).toBe(P_TEAM);
    expect(result.warnings).toEqual([]);
  });

  it("ignores an assignment whose effectiveFrom is in the future and falls through", () => {
    const future = { ...A_EMP, effectiveFrom: hoursAhead(1) };
    const result = resolvePolicy({ employee, assignments: [future, A_TEAM], policiesById: ALL_POLICIES, now: NOW });
    expect(result.policy).toBe(P_TEAM);
  });

  it("effectiveFrom is inclusive and effectiveTo is exclusive", () => {
    const base = assignment({ scopeType: "EMPLOYEE", scopeId: EMP, policyId: P_EMP.id });
    expect(isAssignmentActive({ ...base, effectiveFrom: NOW }, NOW)).toBe(true);
    expect(isAssignmentActive({ ...base, effectiveTo: NOW }, NOW)).toBe(false);
    expect(isAssignmentActive({ ...base, effectiveFrom: hoursAgo(1), effectiveTo: hoursAhead(1) }, NOW)).toBe(true);
    expect(isAssignmentActive({ ...base, effectiveFrom: undefined, effectiveTo: undefined }, NOW)).toBe(true);
  });

  it("a currently active window counts even when a newer, not-yet-effective assignment exists", () => {
    const current = assignment({ id: "cur", scopeType: "EMPLOYEE", scopeId: EMP, policyId: P_EMP.id, createdAt: hoursAgo(72) });
    const scheduled = assignment({
      id: "sched",
      scopeType: "EMPLOYEE",
      scopeId: EMP,
      policyId: P_TEAM.id,
      createdAt: hoursAgo(1),
      effectiveFrom: hoursAhead(24),
    });
    const result = resolvePolicy({ employee, assignments: [current, scheduled], policiesById: ALL_POLICIES, now: NOW });
    expect(assignmentIdOf(result.resolvedFrom)).toBe("cur");
    expect(result.warnings).toEqual([]);
  });

  it("throws a RangeError for an Invalid Date `now` instead of treating every window as active", () => {
    const expired = { ...A_EMP, effectiveTo: hoursAgo(1) };
    expect(() =>
      resolvePolicy({ employee, assignments: [expired, A_TEAM], policiesById: ALL_POLICIES, now: new Date("not a date") }),
    ).toThrow(RangeError);
  });

  it("defaults `now` to the current time", () => {
    const stillActive = { ...A_EMP, effectiveTo: new Date(Date.now() + 60_000) };
    const result = resolvePolicy({ employee, assignments: [stillActive], policiesById: ALL_POLICIES });
    expect(result.policy).toBe(P_EMP);
  });
});

describe("resolvePolicy — archived / deleted policies", () => {
  const archived = policy("p-archived", { status: "ARCHIVED" });
  const deleted = policy("p-deleted", { deletedAt: hoursAgo(2) });
  const policies = { ...ALL_POLICIES, ...indexPoliciesById([archived, deleted]) };

  it("isPolicyUsable: DRAFT and ACTIVE are usable, ARCHIVED and soft-deleted are not", () => {
    expect(isPolicyUsable(policy("d", { status: "DRAFT" }))).toBe(true);
    expect(isPolicyUsable(policy("a", { status: "ACTIVE" }))).toBe(true);
    expect(isPolicyUsable(archived)).toBe(false);
    expect(isPolicyUsable(deleted)).toBe(false);
    expect(isPolicyUsable({ id: "x", status: "ACTIVE" })).toBe(true);
  });

  it("skips an EMPLOYEE assignment to an archived policy with a warning and falls through to TEAM", () => {
    const toArchived = { ...A_EMP, policyId: archived.id };
    const result = resolvePolicy({ employee, assignments: [toArchived, A_TEAM], policiesById: policies, now: NOW });
    expect(result.policy).toBe(P_TEAM);
    expect(result.resolvedFrom?.scopeType).toBe("TEAM");
    expect(codes(result.warnings)).toEqual(["INACTIVE_POLICY_SKIPPED"]);
    expect(result.warnings[0]!.details).toEqual({
      policyId: archived.id,
      status: "ARCHIVED",
      deletedAt: null,
      via: "ASSIGNMENT",
      scopeType: "EMPLOYEE",
      scopeId: EMP,
      assignmentId: "a-emp",
    });
  });

  it("skips a soft-deleted policy the same way and records deletedAt", () => {
    const toDeleted = { ...A_EMP, policyId: deleted.id };
    const result = resolvePolicy({ employee, assignments: [toDeleted], policiesById: policies, organisationDefaultPolicyId: P_DEFAULT.id, now: NOW });
    expect(result.policy).toBe(P_DEFAULT);
    const w = result.warnings[0]!;
    expect(w.code).toBe("INACTIVE_POLICY_SKIPPED");
    expect(w.details).toMatchObject({ policyId: deleted.id, deletedAt: hoursAgo(2).toISOString() });
    expect(w.message).toContain("soft-deleted");
  });

  it("falls all the way through several archived levels, collecting one warning per skip", () => {
    const result = resolvePolicy({
      employee,
      assignments: [{ ...A_EMP, policyId: archived.id }, { ...A_TEAM, policyId: archived.id }, { ...A_LOC, policyId: deleted.id }],
      policiesById: policies,
      organisationDefaultPolicyId: P_DEFAULT.id,
      now: NOW,
    });
    expect(result.policy).toBe(P_DEFAULT);
    expect(result.resolvedFrom).toEqual({ via: "DEFAULT", scopeType: "ORGANISATION", scopeId: ORG });
    expect(codes(result.warnings)).toEqual(["INACTIVE_POLICY_SKIPPED", "INACTIVE_POLICY_SKIPPED", "INACTIVE_POLICY_SKIPPED"]);
    expect(result.warnings.map((w) => (w.code === "INACTIVE_POLICY_SKIPPED" ? w.details.scopeType : null))).toEqual([
      "EMPLOYEE",
      "TEAM",
      "LOCATION",
    ]);
  });

  it("within a level, a newer assignment to an archived policy loses to an older usable one, with no ambiguity warning", () => {
    const twoTeams: EmployeeContextLike = { ...employee, teamIds: [TEAM_A, TEAM_B] };
    const olderUsable = assignment({ id: "old", scopeType: "TEAM", scopeId: TEAM_A, policyId: P_TEAM.id, createdAt: hoursAgo(48) });
    const newerArchived = assignment({ id: "new", scopeType: "TEAM", scopeId: TEAM_B, policyId: archived.id, createdAt: hoursAgo(1) });
    const result = resolvePolicy({ employee: twoTeams, assignments: [olderUsable, newerArchived], policiesById: policies, now: NOW });
    expect(result.policy).toBe(P_TEAM);
    expect(codes(result.warnings)).toEqual(["INACTIVE_POLICY_SKIPPED"]);
  });

  it("an archived organisation default resolves to nothing, with a DEFAULT-flavoured warning", () => {
    const result = resolvePolicy({ employee, assignments: [], policiesById: policies, organisationDefaultPolicyId: archived.id, now: NOW });
    expect(result.policy).toBeNull();
    expect(result.policyId).toBeNull();
    expect(result.resolvedFrom).toBeNull();
    expect(result.warnings[0]).toMatchObject({
      code: "INACTIVE_POLICY_SKIPPED",
      details: { via: "DEFAULT", scopeType: "ORGANISATION", scopeId: ORG, assignmentId: null, policyId: archived.id },
    });
    expect(result.warnings[0]!.message).toContain("organisation default");
  });

  it("a DRAFT policy is still resolvable (its missing version is reported by resolvePolicyVersion, not here)", () => {
    const draft = policy("p-draft", { status: "DRAFT" });
    const result = resolvePolicy({
      employee,
      assignments: [{ ...A_EMP, policyId: draft.id }],
      policiesById: { ...policies, [draft.id]: draft },
      now: NOW,
    });
    expect(result.policy).toBe(draft);
    expect(result.warnings).toEqual([]);
  });
});

describe("resolvePolicy — policies missing from policiesById", () => {
  it("keeps the winning assignment but returns policy null with a POLICY_NOT_LOADED warning", () => {
    const result = resolvePolicy({
      employee,
      assignments: [A_EMP, A_TEAM],
      policiesById: indexPoliciesById([P_TEAM]),
      organisationDefaultPolicyId: P_DEFAULT.id,
      now: NOW,
    });
    expect(result.policy).toBeNull();
    expect(result.policyId).toBe(P_EMP.id);
    expect(result.resolvedFrom).toEqual({ via: "ASSIGNMENT", scopeType: "EMPLOYEE", scopeId: EMP, assignmentId: "a-emp" });
    expect(result.warnings).toEqual([
      {
        code: "POLICY_NOT_LOADED",
        message: expect.stringContaining(P_EMP.id),
        details: { policyId: P_EMP.id, via: "ASSIGNMENT", scopeType: "EMPLOYEE", scopeId: EMP, assignmentId: "a-emp" },
      },
    ]);
  });

  it("does the same for an unloaded organisation default", () => {
    const result = resolvePolicy({ employee, assignments: [], policiesById: {}, organisationDefaultPolicyId: P_DEFAULT.id, now: NOW });
    expect(result.policy).toBeNull();
    expect(result.policyId).toBe(P_DEFAULT.id);
    expect(result.resolvedFrom).toEqual({ via: "DEFAULT", scopeType: "ORGANISATION", scopeId: ORG });
    expect(codes(result.warnings)).toEqual(["POLICY_NOT_LOADED"]);
  });
});

describe("resolvePolicy — duplicate assignments for one scope", () => {
  it("picks the most recently created and emits DUPLICATE_SCOPE_ASSIGNMENT", () => {
    const first = assignment({ id: "dup-1", scopeType: "EMPLOYEE", scopeId: EMP, policyId: P_EMP.id, createdAt: hoursAgo(10) });
    const second = assignment({ id: "dup-2", scopeType: "EMPLOYEE", scopeId: EMP, policyId: P_TEAM.id, createdAt: hoursAgo(2) });
    const result = resolvePolicy({ employee, assignments: [first, second], policiesById: ALL_POLICIES, now: NOW });
    expect(result.policy).toBe(P_TEAM);
    expect(assignmentIdOf(result.resolvedFrom)).toBe("dup-2");
    expect(result.warnings).toEqual([
      {
        code: "DUPLICATE_SCOPE_ASSIGNMENT",
        message: expect.stringContaining("dup-2"),
        details: { scopeType: "EMPLOYEE", scopeId: EMP, assignmentIds: ["dup-2", "dup-1"], winnerAssignmentId: "dup-2" },
      },
    ]);
  });
});

describe("resolvePolicy — break policies via the same function", () => {
  interface TestBreakPolicy extends PolicyLike {
    maxBreaksPerShift: number;
    restrictionBehaviour: BreakRestrictionBehaviour;
  }
  const bpTeam: TestBreakPolicy = { id: "bp-team", status: "ACTIVE", deletedAt: null, maxBreaksPerShift: 3, restrictionBehaviour: "RELAX_ALL" };
  const bpDefault: TestBreakPolicy = { id: "bp-default", status: "ACTIVE", deletedAt: null, maxBreaksPerShift: 2, restrictionBehaviour: "KEEP_RESTRICTIONS" };

  it("adapts BreakPolicyAssignment rows and preserves the concrete policy type", () => {
    const row = {
      id: "bpa-1",
      scopeType: "TEAM" as const,
      scopeId: TEAM_A,
      breakPolicyId: bpTeam.id,
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: hoursAgo(3),
    };
    const adapted = fromBreakPolicyAssignment(row);
    expect(adapted).toEqual({ ...row, policyId: bpTeam.id, breakPolicyId: undefined });
    expect("breakPolicyId" in adapted).toBe(false);

    const result = resolvePolicy({
      employee,
      assignments: [adapted],
      policiesById: indexPoliciesById([bpTeam, bpDefault]),
      organisationDefaultPolicyId: bpDefault.id,
      now: NOW,
    });
    expect(result.policy?.maxBreaksPerShift).toBe(3);
    expect(result.policy?.restrictionBehaviour).toBe("RELAX_ALL");
    expect(result.resolvedFrom).toEqual({ via: "ASSIGNMENT", scopeType: "TEAM", scopeId: TEAM_A, assignmentId: "bpa-1" });
  });

  it("falls back to the organisation's default break policy", () => {
    const result = resolvePolicy({
      employee,
      assignments: [],
      policiesById: indexPoliciesById([bpTeam, bpDefault]),
      organisationDefaultPolicyId: bpDefault.id,
      now: NOW,
    });
    expect(result.policy).toBe(bpDefault);
    expect(result.resolvedFrom?.via).toBe("DEFAULT");
  });

  it("fromBreakPolicyAssignment normalises missing windows to null", () => {
    const adapted = fromBreakPolicyAssignment({ id: "x", scopeType: "EMPLOYEE", scopeId: EMP, breakPolicyId: "b", createdAt: NOW });
    expect(adapted.effectiveFrom).toBeNull();
    expect(adapted.effectiveTo).toBeNull();
  });
});

describe("resolvePolicy — misc", () => {
  it("indexPoliciesById keys by id and the last duplicate wins", () => {
    const a = policy("same", { name: "first" });
    const b = policy("same", { name: "second" });
    expect(indexPoliciesById([a, b])).toEqual({ same: b });
    expect(indexPoliciesById([])).toEqual({});
  });

  it("warning details survive a JSON round-trip unchanged (safe for activity logs)", () => {
    const archived = policy("p-archived", { status: "ARCHIVED" });
    const twoTeams: EmployeeContextLike = { ...employee, teamIds: [TEAM_A, TEAM_B] };
    const result = resolvePolicy({
      employee: twoTeams,
      assignments: [
        { ...A_EMP, policyId: archived.id },
        assignment({ id: "t-a", scopeType: "TEAM", scopeId: TEAM_A, policyId: P_TEAM.id, createdAt: hoursAgo(9) }),
        assignment({ id: "t-b", scopeType: "TEAM", scopeId: TEAM_B, policyId: P_TEAM_B.id, createdAt: hoursAgo(8) }),
        assignment({ id: "t-b2", scopeType: "TEAM", scopeId: TEAM_B, policyId: P_TEAM_B.id, createdAt: hoursAgo(7) }),
      ],
      policiesById: { ...ALL_POLICIES, [archived.id]: archived },
      now: NOW,
    });
    expect(codes(result.warnings)).toEqual(["INACTIVE_POLICY_SKIPPED", "DUPLICATE_SCOPE_ASSIGNMENT", "AMBIGUOUS_TEAM_ASSIGNMENT"]);
    expect(JSON.parse(JSON.stringify(result.warnings))).toEqual(result.warnings);
  });

  it("accepts the spec's generic AssignmentLike<T> signature (phantom parameter, same shape)", () => {
    const typed: readonly AssignmentLike<TestPolicy>[] = [A_TEAM];
    const untyped: readonly AssignmentLike[] = typed;
    const result = resolvePolicy<TestPolicy>({ employee, assignments: untyped, policiesById: ALL_POLICIES, now: NOW });
    expect(result.policy?.name).toBe("Policy p-team");
  });

  it("does not mutate its inputs", () => {
    const assignments = [A_ORG, A_LOC, A_TEAM, A_EMP];
    const snapshot = structuredClone(assignments);
    resolvePolicy({ employee, assignments, policiesById: ALL_POLICIES, now: NOW });
    expect(assignments).toEqual(snapshot);
  });
});

describe("resolvePolicy — exhaustive precedence and fall-through matrix", () => {
  const LEVELS = [
    { scopeType: "EMPLOYEE", assignment: A_EMP, policy: P_EMP },
    { scopeType: "TEAM", assignment: A_TEAM, policy: P_TEAM },
    { scopeType: "LOCATION", assignment: A_LOC, policy: P_LOC },
    { scopeType: "ORGANISATION", assignment: A_ORG, policy: P_ORG },
  ] as const;
  const ARCHIVED = policy("p-archived-matrix", { status: "ARCHIVED" });
  const policies = { ...ALL_POLICIES, [ARCHIVED.id]: ARCHIVED };

  it("for every combination of levels (with and without a default) the highest present level wins", () => {
    for (let mask = 0; mask < 1 << LEVELS.length; mask += 1) {
      for (const withDefault of [false, true]) {
        const present = LEVELS.filter((_, i) => (mask & (1 << i)) !== 0);
        const result = resolvePolicy({
          employee,
          // Reverse so input order never matches precedence order.
          assignments: present.map((l) => l.assignment).reverse(),
          policiesById: ALL_POLICIES,
          organisationDefaultPolicyId: withDefault ? P_DEFAULT.id : null,
          now: NOW,
        });
        const top = present[0];
        const label = `mask=${mask.toString(2)} default=${withDefault}`;
        expect(result.warnings, label).toEqual([]);
        if (top !== undefined) {
          expect(result.policy, label).toBe(top.policy);
          expect(result.resolvedFrom, label).toEqual({
            via: "ASSIGNMENT",
            scopeType: top.scopeType,
            scopeId: top.assignment.scopeId,
            assignmentId: top.assignment.id,
          });
        } else if (withDefault) {
          expect(result.policy, label).toBe(P_DEFAULT);
          expect(result.resolvedFrom, label).toEqual({ via: "DEFAULT", scopeType: "ORGANISATION", scopeId: ORG });
        } else {
          expect(result, label).toEqual({ policy: null, policyId: null, resolvedFrom: null, warnings: [] });
        }
      }
    }
  });

  it("for every combination of archived levels, archived ones are skipped (one warning each) and the next usable level wins", () => {
    for (let archivedMask = 0; archivedMask < 1 << LEVELS.length; archivedMask += 1) {
      const isArchived = (i: number): boolean => (archivedMask & (1 << i)) !== 0;
      const result = resolvePolicy({
        employee,
        assignments: LEVELS.map((l, i) => (isArchived(i) ? { ...l.assignment, policyId: ARCHIVED.id } : l.assignment)),
        policiesById: policies,
        organisationDefaultPolicyId: P_DEFAULT.id,
        now: NOW,
      });
      const firstUsable = LEVELS.findIndex((_, i) => !isArchived(i));
      const skipped = LEVELS.filter((_, i) => isArchived(i) && (firstUsable === -1 || i < firstUsable));
      const label = `archived=${archivedMask.toString(2)}`;
      expect(result.policy, label).toBe(firstUsable === -1 ? P_DEFAULT : LEVELS[firstUsable]!.policy);
      expect(
        result.warnings.map((w) => (w.code === "INACTIVE_POLICY_SKIPPED" ? w.details.scopeType : w.code)),
        label,
      ).toEqual(skipped.map((l) => l.scopeType));
    }
  });

  it("a window boundary moves the outcome between levels (effectiveFrom inclusive, effectiveTo exclusive)", () => {
    const endsNow = { ...A_EMP, effectiveTo: NOW };
    const startsNow = { ...A_EMP, effectiveFrom: NOW };
    expect(resolvePolicy({ employee, assignments: [endsNow, A_TEAM], policiesById: ALL_POLICIES, now: NOW }).policy).toBe(P_TEAM);
    expect(resolvePolicy({ employee, assignments: [startsNow, A_TEAM], policiesById: ALL_POLICIES, now: NOW }).policy).toBe(P_EMP);
    const justBefore = new Date(NOW.getTime() - 1);
    expect(resolvePolicy({ employee, assignments: [endsNow, A_TEAM], policiesById: ALL_POLICIES, now: justBefore }).policy).toBe(P_EMP);
    expect(resolvePolicy({ employee, assignments: [startsNow, A_TEAM], policiesById: ALL_POLICIES, now: justBefore }).policy).toBe(P_TEAM);
  });

  it("an empty or inverted window is never active and raises no warning", () => {
    const empty = { ...A_EMP, effectiveFrom: hoursAgo(1), effectiveTo: hoursAgo(1) };
    const inverted = { ...A_EMP, id: "a-emp-inv", effectiveFrom: hoursAhead(1), effectiveTo: hoursAgo(1) };
    for (const a of [empty, inverted]) {
      expect(isAssignmentActive(a, NOW)).toBe(false);
      const result = resolvePolicy({ employee, assignments: [a, A_TEAM], policiesById: ALL_POLICIES, now: NOW });
      expect(result.policy).toBe(P_TEAM);
      expect(result.warnings).toEqual([]);
    }
  });
});

describe("resolvePolicy — deterministic ordering", () => {
  const twoTeams: EmployeeContextLike = { ...employee, teamIds: [TEAM_A, TEAM_B] };
  const SAME = hoursAgo(6);

  it("breaks createdAt ties inside ONE scope by descending id as well (duplicate rows)", () => {
    const lo = assignment({ id: "dup-a", scopeType: "EMPLOYEE", scopeId: EMP, policyId: P_EMP.id, createdAt: SAME });
    const hi = assignment({ id: "dup-b", scopeType: "EMPLOYEE", scopeId: EMP, policyId: P_TEAM.id, createdAt: SAME });
    for (const order of [
      [lo, hi],
      [hi, lo],
    ]) {
      const result = resolvePolicy({ employee, assignments: order, policiesById: ALL_POLICIES, now: NOW });
      expect(assignmentIdOf(result.resolvedFrom)).toBe("dup-b");
      expect(result.warnings[0]).toMatchObject({
        code: "DUPLICATE_SCOPE_ASSIGNMENT",
        details: { assignmentIds: ["dup-b", "dup-a"], winnerAssignmentId: "dup-b" },
      });
    }
  });

  it("on a createdAt tie, an archived higher-id row yields to the lower-id usable row", () => {
    const archived = policy("p-arch-tie", { status: "ARCHIVED" });
    const hi = assignment({ id: "t-2", scopeType: "TEAM", scopeId: TEAM_B, policyId: archived.id, createdAt: SAME });
    const lo = assignment({ id: "t-1", scopeType: "TEAM", scopeId: TEAM_A, policyId: P_TEAM.id, createdAt: SAME });
    const result = resolvePolicy({
      employee: twoTeams,
      assignments: [hi, lo],
      policiesById: { ...ALL_POLICIES, [archived.id]: archived },
      now: NOW,
    });
    expect(assignmentIdOf(result.resolvedFrom)).toBe("t-1");
    expect(codes(result.warnings)).toEqual(["INACTIVE_POLICY_SKIPPED"]);
  });

  it("produces an identical result (winner AND warning order) for every permutation of a messy input", () => {
    const archived = policy("p-arch-perm", { status: "ARCHIVED" });
    const foreign = policy("p-foreign-perm", { organisationId: "other-org" });
    const policies = { ...ALL_POLICIES, [archived.id]: archived, [foreign.id]: foreign };
    const rows: AssignmentLike[] = [
      assignment({ id: "e-arch", scopeType: "EMPLOYEE", scopeId: EMP, policyId: archived.id, createdAt: hoursAgo(1) }),
      assignment({ id: "e-expired", scopeType: "EMPLOYEE", scopeId: EMP, policyId: P_EMP.id, effectiveTo: hoursAgo(2) }),
      assignment({ id: "ta-1", scopeType: "TEAM", scopeId: TEAM_A, policyId: P_TEAM.id, createdAt: SAME }),
      assignment({ id: "ta-2", scopeType: "TEAM", scopeId: TEAM_A, policyId: P_TEAM.id, createdAt: SAME }),
      assignment({ id: "tb-1", scopeType: "TEAM", scopeId: TEAM_B, policyId: P_TEAM_B.id, createdAt: SAME }),
      assignment({ id: "tb-foreign", scopeType: "TEAM", scopeId: TEAM_B, policyId: foreign.id, createdAt: hoursAgo(1) }),
      A_LOC,
      A_ORG,
    ];
    const expected = resolvePolicy({ employee: twoTeams, assignments: rows, policiesById: policies, now: NOW });
    expect(assignmentIdOf(expected.resolvedFrom)).toBe("tb-1");
    expect(codes(expected.warnings)).toEqual([
      "INACTIVE_POLICY_SKIPPED",
      "POLICY_ORGANISATION_MISMATCH",
      "DUPLICATE_SCOPE_ASSIGNMENT",
      "AMBIGUOUS_TEAM_ASSIGNMENT",
    ]);

    // Seeded Fisher–Yates so the test is reproducible.
    let seed = 0x2f6b_1c3d;
    const random = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let run = 0; run < 200; run += 1) {
      const shuffled = [...rows];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      const teamIds = random() < 0.5 ? [TEAM_A, TEAM_B] : [TEAM_B, TEAM_A];
      const result = resolvePolicy({ employee: { ...twoTeams, teamIds }, assignments: shuffled, policiesById: policies, now: NOW });
      expect(result).toEqual(expected);
    }
  });

  it("counts a row passed twice (same id) once, so it is not reported as a duplicate", () => {
    const once = resolvePolicy({ employee, assignments: [A_EMP, A_TEAM], policiesById: ALL_POLICIES, now: NOW });
    const twice = resolvePolicy({ employee, assignments: [A_EMP, A_TEAM, A_EMP, A_EMP], policiesById: ALL_POLICIES, now: NOW });
    expect(twice).toEqual(once);
    expect(twice.warnings).toEqual([]);
  });

  it("exposes the precedence list frozen", () => {
    expect(Object.isFrozen(POLICY_SCOPE_PRECEDENCE)).toBe(true);
  });
});

describe("resolvePolicy — organisation guard", () => {
  const foreign = policy("p-foreign", { organisationId: "other-org" });
  const own = policy("p-own", { organisationId: ORG });
  const policies = { ...ALL_POLICIES, [foreign.id]: foreign, [own.id]: own };

  it("never applies another organisation's policy: skips it with POLICY_ORGANISATION_MISMATCH and falls through", () => {
    const result = resolvePolicy({
      employee,
      assignments: [{ ...A_EMP, policyId: foreign.id }, A_TEAM],
      policiesById: policies,
      now: NOW,
    });
    expect(result.policy).toBe(P_TEAM);
    expect(result.warnings).toEqual([
      {
        code: "POLICY_ORGANISATION_MISMATCH",
        message: expect.stringContaining("other-org"),
        details: {
          policyId: foreign.id,
          policyOrganisationId: "other-org",
          organisationId: ORG,
          via: "ASSIGNMENT",
          scopeType: "EMPLOYEE",
          scopeId: EMP,
          assignmentId: "a-emp",
        },
      },
    ]);
  });

  it("applies a policy whose organisationId matches, and does not check policies that omit organisationId", () => {
    expect(resolvePolicy({ employee, assignments: [{ ...A_EMP, policyId: own.id }], policiesById: policies, now: NOW }).policy).toBe(own);
    expect(resolvePolicy({ employee, assignments: [A_EMP], policiesById: policies, now: NOW }).policy).toBe(P_EMP);
  });

  it("rejects a foreign organisation default (resolves to nothing, DEFAULT-flavoured warning)", () => {
    const result = resolvePolicy({ employee, assignments: [], policiesById: policies, organisationDefaultPolicyId: foreign.id, now: NOW });
    expect(result).toMatchObject({ policy: null, policyId: null, resolvedFrom: null });
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "POLICY_ORGANISATION_MISMATCH",
        details: expect.objectContaining({ via: "DEFAULT", assignmentId: null, policyId: foreign.id }),
      }),
    ]);
  });

  it("reports a foreign AND archived policy once, as the organisation mismatch", () => {
    const foreignArchived = policy("p-fa", { organisationId: "other-org", status: "ARCHIVED" });
    const result = resolvePolicy({
      employee,
      assignments: [{ ...A_EMP, policyId: foreignArchived.id }],
      policiesById: { [foreignArchived.id]: foreignArchived },
      now: NOW,
    });
    expect(codes(result.warnings)).toEqual(["POLICY_ORGANISATION_MISMATCH"]);
  });

  it("a foreign team policy cannot create team ambiguity", () => {
    const twoTeams: EmployeeContextLike = { ...employee, teamIds: [TEAM_A, TEAM_B] };
    const result = resolvePolicy({
      employee: twoTeams,
      assignments: [
        assignment({ id: "ta", scopeType: "TEAM", scopeId: TEAM_A, policyId: P_TEAM.id, createdAt: hoursAgo(9) }),
        assignment({ id: "tb", scopeType: "TEAM", scopeId: TEAM_B, policyId: foreign.id, createdAt: hoursAgo(1) }),
      ],
      policiesById: policies,
      now: NOW,
    });
    expect(result.policy).toBe(P_TEAM);
    expect(codes(result.warnings)).toEqual(["POLICY_ORGANISATION_MISMATCH"]);
  });
});

describe("resolvePolicy — malformed input", () => {
  it("never consults Object.prototype: ids like toString / constructor / __proto__ are just 'not loaded'", () => {
    for (const id of ["toString", "constructor", "hasOwnProperty", "__proto__", "valueOf"]) {
      const viaAssignment = resolvePolicy({
        employee,
        assignments: [{ ...A_EMP, policyId: id }],
        policiesById: indexPoliciesById([P_TEAM]),
        now: NOW,
      });
      expect(viaAssignment.policy, id).toBeNull();
      expect(viaAssignment.policyId, id).toBe(id);
      expect(codes(viaAssignment.warnings), id).toEqual(["POLICY_NOT_LOADED"]);

      const viaDefault = resolvePolicy({ employee, assignments: [], policiesById: {}, organisationDefaultPolicyId: id, now: NOW });
      expect(codes(viaDefault.warnings), id).toEqual(["POLICY_NOT_LOADED"]);
    }
  });

  it("indexPoliciesById stores an id of __proto__ as an own key of a plain object", () => {
    const odd = policy("__proto__");
    const map = indexPoliciesById([odd, P_TEAM]);
    expect(Object.getPrototypeOf(map)).toBe(Object.prototype);
    expect(Object.hasOwn(map, "__proto__")).toBe(true);
    expect(Object.keys(map)).toEqual(["__proto__", P_TEAM.id]);
    const result = resolvePolicy({ employee, assignments: [{ ...A_EMP, policyId: "__proto__" }], policiesById: map, now: NOW });
    expect(result.policy).toBe(odd);
  });

  it("treats a runtime status outside PolicyStatus as unusable (warning + fall-through) instead of throwing", () => {
    const weird = { id: "p-weird", status: "SUSPENDED", deletedAt: null } as unknown as TestPolicy;
    expect(isPolicyUsable(weird)).toBe(false);
    const result = resolvePolicy({
      employee,
      assignments: [{ ...A_EMP, policyId: weird.id }, A_TEAM],
      policiesById: { ...ALL_POLICIES, [weird.id]: weird },
      now: NOW,
    });
    expect(result.policy).toBe(P_TEAM);
    expect(result.warnings[0]).toMatchObject({ code: "INACTIVE_POLICY_SKIPPED", details: { status: "SUSPENDED" } });
  });

  it("throws RangeError naming the assignment for an Invalid Date in createdAt / effectiveFrom / effectiveTo", () => {
    const bad = new Date("garbage");
    for (const field of ["createdAt", "effectiveFrom", "effectiveTo"] as const) {
      // Even on a row for ANOTHER employee: the contract must not depend on which levels are reached.
      const row = { ...assignment({ id: `bad-${field}`, scopeType: "EMPLOYEE", scopeId: "someone-else", policyId: P_EMP.id }), [field]: bad };
      expect(() => resolvePolicy({ employee, assignments: [A_EMP, row], policiesById: ALL_POLICIES, now: NOW }), field).toThrow(
        new RangeError(`${field} of assignment bad-${field} is an Invalid Date`),
      );
    }
  });

  it("throws RangeError for an Invalid Date deletedAt on ANY supplied policy, even one no assignment reaches", () => {
    const broken = policy("p-broken", { deletedAt: new Date("garbage") });
    expect(() =>
      resolvePolicy({ employee, assignments: [A_EMP], policiesById: { ...ALL_POLICIES, [broken.id]: broken }, now: NOW }),
    ).toThrow(new RangeError("deletedAt of policy p-broken is an Invalid Date"));
  });

  it("isAssignmentActive and compareAssignmentsNewestFirst reject Invalid Dates too", () => {
    const bad = new Date(Number.NaN);
    expect(() => isAssignmentActive(A_EMP, bad)).toThrow(RangeError);
    expect(() => isAssignmentActive({ ...A_EMP, effectiveFrom: bad }, NOW)).toThrow(RangeError);
    expect(() => compareAssignmentsNewestFirst({ ...A_EMP, createdAt: bad }, A_TEAM)).toThrow(RangeError);
  });
});

describe("resolvePolicy — break policies through the full hierarchy", () => {
  interface TestBreakPolicy extends PolicyLike {
    maxBreaksPerShift: number;
  }
  const bp = (id: string, overrides: Partial<TestBreakPolicy> = {}): TestBreakPolicy => ({
    id,
    status: "ACTIVE",
    deletedAt: null,
    organisationId: ORG,
    maxBreaksPerShift: 2,
    ...overrides,
  });
  const BP_EMP = bp("bp-emp", { maxBreaksPerShift: 5 });
  const BP_TEAM = bp("bp-team", { maxBreaksPerShift: 4 });
  const BP_LOC = bp("bp-loc", { maxBreaksPerShift: 3, status: "ARCHIVED" });
  const BP_ORG = bp("bp-org", { maxBreaksPerShift: 1 });
  const BP_DEFAULT = bp("bp-default", { maxBreaksPerShift: 0 });
  const breakPolicies = indexPoliciesById([BP_EMP, BP_TEAM, BP_LOC, BP_ORG, BP_DEFAULT]);
  const row = (id: string, scopeType: AssignmentLike["scopeType"], scopeId: string, breakPolicyId: string, extra: Partial<AssignmentLike> = {}) =>
    fromBreakPolicyAssignment({ id, scopeType, scopeId, breakPolicyId, createdAt: hoursAgo(24), ...extra });

  it("applies the same precedence, windows and archived fall-through as work policies", () => {
    const emp = row("b-emp", "EMPLOYEE", EMP, BP_EMP.id, { effectiveTo: hoursAgo(1) }); // expired
    const team = row("b-team", "TEAM", TEAM_A, BP_TEAM.id, { effectiveFrom: hoursAhead(1) }); // not yet
    const loc = row("b-loc", "LOCATION", LOC, BP_LOC.id); // archived
    const org = row("b-org", "ORGANISATION", ORG, BP_ORG.id);
    const result = resolvePolicy({
      employee,
      assignments: [emp, team, loc, org],
      policiesById: breakPolicies,
      organisationDefaultPolicyId: BP_DEFAULT.id,
      now: NOW,
    });
    expect(result.policy).toBe(BP_ORG);
    expect(result.policy?.maxBreaksPerShift).toBe(1);
    expect(result.resolvedFrom).toEqual({ via: "ASSIGNMENT", scopeType: "ORGANISATION", scopeId: ORG, assignmentId: "b-org" });
    expect(codes(result.warnings)).toEqual(["INACTIVE_POLICY_SKIPPED"]);

    const later = resolvePolicy({
      employee,
      assignments: [emp, team, loc, org],
      policiesById: breakPolicies,
      organisationDefaultPolicyId: BP_DEFAULT.id,
      now: hoursAhead(2),
    });
    expect(later.policy).toBe(BP_TEAM);
  });

  it("raises AMBIGUOUS_TEAM_ASSIGNMENT for break policies too", () => {
    const result = resolvePolicy({
      employee: { ...employee, teamIds: [TEAM_A, TEAM_B] },
      assignments: [
        row("b-ta", "TEAM", TEAM_A, BP_TEAM.id, { createdAt: hoursAgo(5) }),
        row("b-tb", "TEAM", TEAM_B, BP_EMP.id, { createdAt: hoursAgo(4) }),
      ],
      policiesById: breakPolicies,
      now: NOW,
    });
    expect(result.policy).toBe(BP_EMP);
    expect(codes(result.warnings)).toEqual(["AMBIGUOUS_TEAM_ASSIGNMENT"]);
  });
});
