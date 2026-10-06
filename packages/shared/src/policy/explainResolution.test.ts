import { describe, expect, it } from "vitest";
import { ASSIGNMENT_SCOPE_TYPES } from "../enums";
import { SCOPE_TYPE_LABELS, explainResolution } from "./explainResolution";
import type { ResolveResult, ResolvedFrom } from "./types";

const TEAM_ID = "team-foh";
const teamAssignment: ResolvedFrom = { via: "ASSIGNMENT", scopeType: "TEAM", scopeId: TEAM_ID, assignmentId: "a-1" };

describe("explainResolution", () => {
  it("has a label for every scope type", () => {
    for (const scope of ASSIGNMENT_SCOPE_TYPES) expect(SCOPE_TYPE_LABELS[scope]).toBeTruthy();
  });

  it("describes a nothing-resolved result", () => {
    expect(explainResolution({ resolvedFrom: null })).toBe("No policy resolved");
  });

  it("names the scope when a lookup map knows it", () => {
    expect(explainResolution({ resolvedFrom: teamAssignment }, { TEAM: { [TEAM_ID]: "Front of House" } })).toBe(
      "Resolved from Team: Front of House",
    );
  });

  it("accepts a lookup function", () => {
    const names = new Map([[TEAM_ID, "Front of House"]]);
    expect(explainResolution({ resolvedFrom: teamAssignment }, { TEAM: (id) => names.get(id) })).toBe(
      "Resolved from Team: Front of House",
    );
  });

  it("falls back to the bare scope label when the name is unknown, empty or lookups are absent", () => {
    expect(explainResolution({ resolvedFrom: teamAssignment })).toBe("Resolved from Team");
    expect(explainResolution({ resolvedFrom: teamAssignment }, {})).toBe("Resolved from Team");
    expect(explainResolution({ resolvedFrom: teamAssignment }, { TEAM: {} })).toBe("Resolved from Team");
    expect(explainResolution({ resolvedFrom: teamAssignment }, { TEAM: () => null })).toBe("Resolved from Team");
    expect(explainResolution({ resolvedFrom: teamAssignment }, { TEAM: { [TEAM_ID]: "   " } })).toBe("Resolved from Team");
    expect(explainResolution({ resolvedFrom: teamAssignment }, { LOCATION: { [TEAM_ID]: "Wrong scope" } })).toBe(
      "Resolved from Team",
    );
  });

  it("labels employee, location and organisation assignments", () => {
    expect(
      explainResolution(
        { resolvedFrom: { via: "ASSIGNMENT", scopeType: "EMPLOYEE", scopeId: "e1", assignmentId: "a" } },
        { EMPLOYEE: { e1: "Sam Taylor" } },
      ),
    ).toBe("Resolved from Employee: Sam Taylor");
    expect(
      explainResolution(
        { resolvedFrom: { via: "ASSIGNMENT", scopeType: "LOCATION", scopeId: "l1", assignmentId: "a" } },
        { LOCATION: { l1: "Shoreditch" } },
      ),
    ).toBe("Resolved from Location: Shoreditch");
    expect(
      explainResolution(
        { resolvedFrom: { via: "ASSIGNMENT", scopeType: "ORGANISATION", scopeId: "o1", assignmentId: "a" } },
        { ORGANISATION: { o1: "Acme Coffee" } },
      ),
    ).toBe("Resolved from Organisation: Acme Coffee");
  });

  it("distinguishes the organisation default from an organisation-scope assignment", () => {
    const viaDefault: ResolvedFrom = { via: "DEFAULT", scopeType: "ORGANISATION", scopeId: "o1" };
    expect(explainResolution({ resolvedFrom: viaDefault })).toBe("Resolved from Organisation default");
    expect(explainResolution({ resolvedFrom: viaDefault }, { ORGANISATION: { o1: "Acme Coffee" } })).toBe(
      "Resolved from Organisation default: Acme Coffee",
    );
  });

  it("accepts a full ResolveResult (only resolvedFrom is read)", () => {
    const full: ResolveResult<{ id: string; status: "ACTIVE" }> = {
      policy: null,
      policyId: "p",
      resolvedFrom: teamAssignment,
      warnings: [],
    };
    expect(explainResolution(full)).toBe("Resolved from Team");
  });
});
