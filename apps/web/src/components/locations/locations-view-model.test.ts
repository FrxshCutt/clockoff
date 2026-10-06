import type { BreakPolicy } from "@workmode/validation/breakPolicies";
import {
  createLocationSchema,
  updateLocationSchema,
  type Location,
  type ScopeAssignment,
  type Team,
} from "@workmode/validation/locationsTeams";
import type { Policy } from "@workmode/validation/policies";
import { describe, expect, it } from "vitest";
import { ApiClientError } from "@/lib/api-client";
import {
  LOCATIONS_TABS,
  LOCATIONS_TAB_META,
  assignableBreakPolicies,
  assignableWorkPolicies,
  departmentDeleteWarnings,
  describeLocationTimezone,
  describeStructureConflict,
  emptyLocationForm,
  locationDeleteWarnings,
  locationFormSchema,
  locationToFormValues,
  parseLocationsTab,
  summariseScopeAssignment,
  teamDeleteWarnings,
  teamFormSchema,
  teamToFormValues,
  toCreateLocationInput,
  toCreateTeamInput,
  toUpdateLocationInput,
  toUpdateTeamInput,
} from "./locations-view-model";

const LOCATION: Location = {
  id: "3c2a6a2e-5b2f-4f0a-9a3e-6d4f1c2b7a10",
  name: "Harbour Street",
  timezone: null,
  address: "1 Harbour St",
  employeeCount: 4,
  teamCount: 2,
  createdAt: "2026-10-01T09:00:00Z",
  updatedAt: "2026-10-01T09:00:00Z",
};

const TEAM: Team = {
  id: "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  name: "Front of house",
  location: { id: LOCATION.id, name: LOCATION.name },
  memberCount: 3,
  createdAt: "2026-10-01T09:00:00Z",
  updatedAt: "2026-10-01T09:00:00Z",
};

describe("tabs", () => {
  it("has the three tabs with copy, locations first", () => {
    expect(LOCATIONS_TABS).toEqual(["locations", "departments", "teams"]);
    for (const tab of LOCATIONS_TABS) {
      expect(LOCATIONS_TAB_META[tab].label, tab).toBeTruthy();
      expect(LOCATIONS_TAB_META[tab].description, tab).toMatch(/\.$/);
    }
  });

  it("parses ?tab= values, falling back to locations", () => {
    expect(parseLocationsTab("teams")).toBe("teams");
    expect(parseLocationsTab("departments")).toBe("departments");
    expect(parseLocationsTab("members")).toBe("locations");
    expect(parseLocationsTab(undefined)).toBe("locations");
    expect(parseLocationsTab("toString")).toBe("locations");
  });
});

describe("location form", () => {
  it("starts from the organisation zone and maps to a create body without optional fields", () => {
    const values = emptyLocationForm("Europe/London");
    expect(values).toEqual({
      name: "",
      useOrganisationTimezone: true,
      timezone: "Europe/London",
      address: "",
    });
    expect(toCreateLocationInput({ ...values, name: "Depot" })).toEqual({ name: "Depot" });
    expect(
      toCreateLocationInput({
        name: "Depot",
        useOrganisationTimezone: false,
        timezone: "Europe/Paris",
        address: "Rue 1",
      }),
    ).toEqual({
      name: "Depot",
      timezone: "Europe/Paris",
      address: "Rue 1",
    });
  });

  it("validates like the API: trimmed name, a real zone only when not inheriting", () => {
    expect(
      locationFormSchema.parse({
        name: "  Depot ",
        useOrganisationTimezone: true,
        timezone: "nope",
        address: "",
      }).name,
    ).toBe("Depot");
    expect(
      locationFormSchema.safeParse({
        name: "",
        useOrganisationTimezone: true,
        timezone: "UTC",
        address: "",
      }).success,
    ).toBe(false);
    const bad = locationFormSchema.safeParse({
      name: "Depot",
      useOrganisationTimezone: false,
      timezone: "Mars/Olympus",
      address: "",
    });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0]?.path).toEqual(["timezone"]);
    expect(
      locationFormSchema.safeParse({
        name: "Depot",
        useOrganisationTimezone: false,
        timezone: "Asia/Tokyo",
        address: "x".repeat(301),
      }).success,
    ).toBe(false);
  });

  it("round-trips a location and diffs only changed fields on update", () => {
    const values = locationToFormValues(LOCATION, "Europe/London");
    expect(values).toEqual({
      name: "Harbour Street",
      useOrganisationTimezone: true,
      timezone: "Europe/London",
      address: "1 Harbour St",
    });
    expect(toUpdateLocationInput(values, LOCATION)).toBeNull();
    expect(
      toUpdateLocationInput(
        { ...values, useOrganisationTimezone: false, timezone: "Europe/Paris" },
        LOCATION,
      ),
    ).toEqual({ timezone: "Europe/Paris" });
    expect(toUpdateLocationInput({ ...values, address: "" }, LOCATION)).toEqual({ address: null });
    const zoned: Location = { ...LOCATION, timezone: "Europe/Paris" };
    expect(
      toUpdateLocationInput(
        { ...locationToFormValues(zoned, "Europe/London"), useOrganisationTimezone: true },
        zoned,
      ),
    ).toEqual({ timezone: null });
    expect(toUpdateLocationInput({ ...values, name: "Harbour" }, LOCATION)).toEqual({
      name: "Harbour",
    });
  });

  it("describes inherited and explicit zones", () => {
    expect(describeLocationTimezone({ timezone: null }, "Europe/London")).toMatchObject({
      inherited: true,
    });
    expect(describeLocationTimezone({ timezone: null }, "Europe/London").label).toContain(
      "Europe / London",
    );
    expect(describeLocationTimezone({ timezone: null }, undefined)).toEqual({
      label: "Organisation default",
      inherited: true,
    });
    expect(
      describeLocationTimezone({ timezone: "America/New_York" }, "Europe/London"),
    ).toMatchObject({ inherited: false });
    expect(
      describeLocationTimezone({ timezone: "America/New_York" }, "Europe/London").label,
    ).toContain("America / New York");
  });

  it("warns about dependants before deleting", () => {
    expect(locationDeleteWarnings({ employeeCount: 0, teamCount: 0 })).toEqual([]);
    const warnings = locationDeleteWarnings(LOCATION);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("4 employees");
    expect(warnings[1]).toContain("2 teams");
    expect(locationDeleteWarnings({ employeeCount: 1, teamCount: 0 })[0]).toContain(
      "1 employee has",
    );
  });
});

describe("team and department forms", () => {
  it("maps team values to create / update bodies with an explicit null to clear the location", () => {
    expect(teamToFormValues(TEAM)).toEqual({ name: "Front of house", locationId: LOCATION.id });
    expect(toCreateTeamInput({ name: "Bar", locationId: "" })).toEqual({ name: "Bar" });
    expect(toCreateTeamInput({ name: "Bar", locationId: LOCATION.id })).toEqual({
      name: "Bar",
      locationId: LOCATION.id,
    });
    expect(toUpdateTeamInput(teamToFormValues(TEAM), TEAM)).toBeNull();
    expect(toUpdateTeamInput({ name: "Front of house", locationId: "" }, TEAM)).toEqual({
      locationId: null,
    });
    expect(toUpdateTeamInput({ name: "FOH", locationId: LOCATION.id }, TEAM)).toEqual({
      name: "FOH",
    });
    expect(teamFormSchema.safeParse({ name: "   ", locationId: "" }).success).toBe(false);
  });

  it("warns about members and employees before deleting", () => {
    expect(teamDeleteWarnings({ memberCount: 0 })).toEqual([]);
    expect(teamDeleteWarnings(TEAM)[0]).toContain("3 members");
    expect(departmentDeleteWarnings({ employeeCount: 0 })).toEqual([]);
    expect(departmentDeleteWarnings({ employeeCount: 2 })[0]).toContain("2 employees are");
  });
});

describe("location bodies match the API contract", () => {
  it("produces bodies createLocationSchema / updateLocationSchema accept, with and without optional fields", () => {
    const minimal = toCreateLocationInput({ ...emptyLocationForm("Europe/London"), name: "Depot" });
    expect(createLocationSchema.safeParse(minimal).success).toBe(true);
    const full = toCreateLocationInput({
      name: "Depot",
      useOrganisationTimezone: false,
      timezone: "Europe/Paris",
      address: "Rue 1",
    });
    expect(createLocationSchema.parse(full)).toEqual({
      name: "Depot",
      timezone: "Europe/Paris",
      address: "Rue 1",
    });

    const values = locationToFormValues(LOCATION, "Europe/London");
    const cleared = toUpdateLocationInput(
      { ...values, address: "", useOrganisationTimezone: true },
      { ...LOCATION, timezone: "Europe/Paris" },
    );
    expect(cleared).toEqual({ timezone: null, address: null });
    expect(updateLocationSchema.parse(cleared)).toEqual({ timezone: null, address: null });
  });
});

describe("scope assignment summary", () => {
  const assignment: ScopeAssignment = {
    id: "a1",
    policy: { id: "p1", name: "Kitchen policy" },
    effectiveFrom: null,
    effectiveTo: null,
  };

  it("reads 'Inherited' when the row carries no assignment (null or field absent)", () => {
    expect(summariseScopeAssignment(null)).toEqual({
      label: "Inherited",
      assigned: false,
      assignmentId: null,
      policyId: null,
    });
    expect(summariseScopeAssignment(undefined)).toMatchObject({ assigned: false });
    const bare: Team = { ...TEAM };
    expect(summariseScopeAssignment(bare.policyAssignment)).toMatchObject({ label: "Inherited" });
  });

  it("names the assigned policy and exposes the ids the popover needs", () => {
    expect(summariseScopeAssignment(assignment)).toEqual({
      label: "Kitchen policy",
      assigned: true,
      assignmentId: "a1",
      policyId: "p1",
    });
    const located: Location = {
      ...LOCATION,
      policyAssignment: assignment,
      breakPolicyAssignment: null,
    };
    expect(summariseScopeAssignment(located.policyAssignment).policyId).toBe("p1");
    expect(summariseScopeAssignment(located.breakPolicyAssignment).assigned).toBe(false);
  });

  it("offers published policies first, drafts disabled with a reason, archived hidden", () => {
    const base = {
      description: null,
      draftVersion: null,
      assignmentCount: 0,
      assignedEmployeeCount: 0,
      createdAt: "2026-10-01T09:00:00Z",
      updatedAt: "2026-10-01T09:00:00Z",
    };
    const version = { id: "v1", version: 1 } as unknown as NonNullable<Policy["currentVersion"]>;
    const policies: Policy[] = [
      {
        ...base,
        id: "p3",
        name: "Zeta",
        status: "ACTIVE",
        currentVersion: version,
        isDefault: false,
      },
      {
        ...base,
        id: "p1",
        name: "Alpha draft",
        status: "DRAFT",
        currentVersion: null,
        isDefault: false,
      },
      {
        ...base,
        id: "p2",
        name: "Beta",
        status: "ACTIVE",
        currentVersion: version,
        isDefault: true,
      },
      {
        ...base,
        id: "p4",
        name: "Old",
        status: "ARCHIVED",
        currentVersion: version,
        isDefault: false,
      },
    ];
    const options = assignableWorkPolicies(policies);
    expect(options.map((o) => o.name)).toEqual(["Beta", "Zeta", "Alpha draft"]);
    expect(options[0]).toMatchObject({ hint: "Organisation default", disabled: false });
    expect(options[2]).toMatchObject({ disabled: true, hint: "Draft — publish it first" });

    const breakPolicies = [
      { id: "b1", name: "Standard", status: "ACTIVE", isDefault: true },
      { id: "b2", name: "Draft rules", status: "DRAFT", isDefault: false },
      { id: "b3", name: "Gone", status: "ARCHIVED", isDefault: false },
    ] as unknown as BreakPolicy[];
    expect(assignableBreakPolicies(breakPolicies).map((o) => [o.name, o.disabled])).toEqual([
      ["Standard", false],
      ["Draft rules", true],
    ]);
  });
});

describe("API conflicts", () => {
  const conflict = (details: unknown) =>
    new ApiClientError({ code: "CONFLICT", status: 409, message: "conflict", details });

  it("puts a duplicate name on the name field", () => {
    expect(describeStructureConflict(conflict({ field: "name" }), "location")).toEqual({
      field: "name",
      message: "A location with this name already exists.",
    });
    expect(describeStructureConflict(conflict({ field: "name" }), "department")?.message).toContain(
      "A department",
    );
  });

  it("explains the plan limit with the plan's display name and allowance", () => {
    const result = describeStructureConflict(
      conflict({
        reason: "PLAN_LIMIT_REACHED",
        metric: "locations",
        limit: 1,
        current: 1,
        plan: "STARTER",
      }),
      "location",
    );
    expect(result).toEqual({
      field: null,
      message: "Your Starter plan allows up to 1 location. Contact sales from Billing to add more.",
    });
    expect(
      describeStructureConflict(
        conflict({ reason: "PLAN_LIMIT_REACHED", limit: 5, plan: "BUSINESS" }),
        "location",
      )?.message,
    ).toContain("Business plan allows up to 5 locations");
    expect(
      describeStructureConflict(conflict({ reason: "PLAN_LIMIT_REACHED" }), "location")?.message,
    ).toBe("Your plan allows up to locations. Contact sales from Billing to add more.");
  });

  it("names the scheduled shifts blocking a location delete", () => {
    expect(
      describeStructureConflict(
        conflict({ reason: "UPCOMING_SHIFTS", upcomingShiftCount: 3 }),
        "location",
      ),
    ).toEqual({
      field: null,
      message: "This location still has 3 scheduled shifts. Move or cancel them first.",
    });
    expect(
      describeStructureConflict(
        conflict({ reason: "UPCOMING_SHIFTS", upcomingShiftCount: 1 }),
        "location",
      )?.message,
    ).toContain("1 scheduled shift.");
  });

  it("returns null for anything that is not a recognised conflict", () => {
    expect(describeStructureConflict(conflict({}), "team")).toBeNull();
    expect(describeStructureConflict(conflict(null), "team")).toBeNull();
    expect(
      describeStructureConflict(
        new ApiClientError({ code: "NOT_FOUND", status: 404, message: "x" }),
        "location",
      ),
    ).toBeNull();
    expect(describeStructureConflict(new Error("boom"), "location")).toBeNull();
    expect(describeStructureConflict(undefined, "location")).toBeNull();
  });
});
