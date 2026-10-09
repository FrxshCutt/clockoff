import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashDecisionInputs, type RecordHasher } from "./hash";
import {
  decideDepartmentAction,
  decideGroupAction,
  decideMemberships,
  departmentDecisionInputs,
  departmentKeyOf,
  departmentKeysOf,
  groupDecisionInputs,
  mappedLocationIds,
  mappedTeamIds,
  markMissingCatalogEntries,
  mergeCatalogPage,
  needsNoDepartmentRow,
  NO_DEPARTMENT_ID,
  suggestDepartmentTarget,
  type CatalogEntry,
  type DepartmentDecisionInput,
  type GroupDecisionInput,
} from "./locationDecisions";

/** docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §6.3 and §6.4: every row of both tables. */

const INTEGRATION = "integration-1";
const NOW = new Date("2026-10-21T10:30:00Z");
const hmac: RecordHasher = (canonical) => createHmac("sha256", "k").update(canonical).digest("hex");
const BAR = { externalId: "101", name: "Bar" };

function department(partial: Partial<DepartmentDecisionInput> = {}) {
  return decideDepartmentAction({
    department: BAR,
    included: true,
    mapping: { target: "LOCATION", locationId: "loc-bar" },
    mapRow: {
      entityType: "LOCATION",
      internalId: "loc-bar",
      lastHash: "old",
      upstreamRemovedAt: null,
    },
    location: { id: "loc-bar", name: "Bar", managedByIntegrationId: INTEGRATION },
    integrationId: INTEGRATION,
    portalTimezone: "Europe/London",
    hash: "new",
    ...partial,
  });
}

function group(partial: Partial<GroupDecisionInput> = {}) {
  return decideGroupAction({
    group: { externalId: "201", name: "Bartenders" },
    mapping: { target: "TEAM", teamId: "team-1" },
    mapRow: { entityType: "TEAM", internalId: "team-1", lastHash: "old", upstreamRemovedAt: null },
    team: { id: "team-1", name: "Bartenders", managedByIntegrationId: INTEGRATION },
    integrationId: INTEGRATION,
    hash: "new",
    ...partial,
  });
}

describe("department keys and the 'none' row", () => {
  it("maps no department to 'none'", () => {
    expect(departmentKeyOf(null)).toBe(NO_DEPARTMENT_ID);
    expect(departmentKeyOf("101")).toBe("101");
    expect(departmentKeysOf([])).toEqual(["none"]);
    expect(departmentKeysOf(null)).toEqual(["none"]);
    expect(departmentKeysOf(["101", "101", "102"])).toEqual(["101", "102"]);
  });

  it("adds the 'Not in any department' row when people have none or the portal has no departments", () => {
    expect(needsNoDepartmentRow({ departmentCount: 0, unassignedEmployeeCount: 0 })).toBe(true);
    expect(needsNoDepartmentRow({ departmentCount: 3, unassignedEmployeeCount: 2 })).toBe(true);
    expect(needsNoDepartmentRow({ departmentCount: 3, unassignedEmployeeCount: 0 })).toBe(false);
    expect(needsNoDepartmentRow({ departmentCount: 3, unassignedEmployeeCount: null })).toBe(false);
  });
});

describe("wizard default (§6.3 row 1)", () => {
  it("suggests a new location named like the department, or an existing one with that name", () => {
    expect(suggestDepartmentTarget(BAR, [], { portalName: "Mock Bistro Group" })).toEqual({
      target: "NEW_LOCATION",
      name: "Bar",
    });
    expect(
      suggestDepartmentTarget(BAR, [{ id: "loc-x", name: "  BAR " }], {
        portalName: "Mock Bistro Group",
      }),
    ).toEqual({ target: "LOCATION", locationId: "loc-x" });
    expect(
      suggestDepartmentTarget({ externalId: "none", name: "Not in any department" }, [], {
        portalName: "Mock Bistro Group",
      }),
    ).toEqual({ target: "NEW_LOCATION", name: "Mock Bistro Group" });
  });
});

describe("decideDepartmentAction (§6.3)", () => {
  it("included, new location, no map row → create it with the portal zone", () => {
    expect(
      department({ mapping: { target: "NEW_LOCATION" }, mapRow: null, location: null }),
    ).toEqual({
      action: "CREATE_LOCATION",
      name: "Bar",
      timezone: "Europe/London",
      writeHash: true,
      clearMissing: false,
    });
    expect(
      department({
        mapping: { target: "NEW_LOCATION", name: "Main bar" },
        mapRow: null,
        location: null,
      }),
    ).toMatchObject({ action: "CREATE_LOCATION", name: "Main bar" });
  });

  it("new location saved again: the managed location is reused (renamed to a new chosen name)", () => {
    expect(department({ mapping: { target: "NEW_LOCATION" }, hash: "old" })).toMatchObject({
      action: "UNCHANGED",
    });
    expect(department({ mapping: { target: "NEW_LOCATION", name: "Main bar" } })).toMatchObject({
      action: "RENAME_LOCATION",
      locationId: "loc-bar",
      name: "Main bar",
    });
  });

  it("included, existing location → a map row; the location is not managed and never renamed", () => {
    const existing = { id: "loc-x", name: "Downstairs", managedByIntegrationId: null };
    expect(
      department({
        mapping: { target: "LOCATION", locationId: "loc-x" },
        mapRow: null,
        location: existing,
      }),
    ).toEqual({
      action: "LINK",
      entityType: "LOCATION",
      internalId: "loc-x",
      replacesMapRow: false,
      writeHash: true,
      clearMissing: false,
    });
    expect(
      department({
        mapping: { target: "LOCATION", locationId: "loc-x" },
        mapRow: {
          entityType: "LOCATION",
          internalId: "loc-x",
          lastHash: "old",
          upstreamRemovedAt: null,
        },
        location: existing,
      }),
    ).toMatchObject({ action: "REHASH_ONLY" });
  });

  it("included, ClockOff department → a DEPARTMENT map row (replacing a location row after a remap)", () => {
    expect(
      department({ mapping: { target: "DEPARTMENT", departmentId: "dept-1" }, location: null }),
    ).toMatchObject({
      action: "LINK",
      entityType: "DEPARTMENT",
      internalId: "dept-1",
      replacesMapRow: true,
    });
  });

  it("excluded → nothing", () => {
    expect(department({ included: false, mapping: null })).toMatchObject({
      action: "IGNORE",
      writeHash: false,
    });
    expect(department({ included: false, mapping: null, mapRow: null })).toMatchObject({
      action: "IGNORE",
    });
  });

  it("renamed in Planday: a managed location follows; an unmanaged one does not", () => {
    expect(department({ department: { externalId: "101", name: "Cocktail Bar" } })).toMatchObject({
      action: "RENAME_LOCATION",
      locationId: "loc-bar",
      name: "Cocktail Bar",
    });
    expect(
      department({
        department: { externalId: "101", name: "Cocktail Bar" },
        location: { id: "loc-bar", name: "Bar", managedByIntegrationId: null },
      }),
    ).toMatchObject({ action: "REHASH_ONLY" });
  });

  it("a managed location given a suffixed name because the name was taken settles (no rename every run)", () => {
    for (const suffixed of ["Bar (Planday)", "Bar (Planday 2)", "Bar (Planday 12)"]) {
      const location = { id: "loc-bar", name: suffixed, managedByIntegrationId: INTEGRATION };
      expect(department({ location, providerName: "Planday", hash: "old" })).toMatchObject({
        action: "UNCHANGED",
      });
      expect(
        department({
          location,
          providerName: "Planday",
          hash: "old",
          mapping: { target: "NEW_LOCATION" },
          mapRow: {
            entityType: "LOCATION",
            internalId: "loc-bar",
            lastHash: "old",
            upstreamRemovedAt: null,
          },
        }),
      ).toMatchObject({ action: "UNCHANGED" });
    }
    // Another name, another provider's suffix or no provider name: still a rename.
    for (const [name, providerName] of [
      ["Bar (Old)", "Planday"],
      ["Bar (Planday 1)", "Planday"],
      ["Bar (Planday x)", "Planday"],
      ["Bar (Deputy)", "Planday"],
      ["Bar (Planday)", undefined],
    ] as const) {
      expect(
        department({
          location: { id: "loc-bar", name, managedByIntegrationId: INTEGRATION },
          ...(providerName ? { providerName } : {}),
        }),
      ).toMatchObject({ action: "RENAME_LOCATION", name: "Bar" });
    }
    // Renamed in Planday: the suffixed location follows the new name.
    expect(
      department({
        department: { externalId: "101", name: "Cocktail Bar" },
        location: { id: "loc-bar", name: "Bar (Planday)", managedByIntegrationId: INTEGRATION },
        providerName: "Planday",
      }),
    ).toMatchObject({ action: "RENAME_LOCATION", name: "Cocktail Bar" });
  });

  it("missing from a complete list → upstreamRemovedAt + DEPARTMENT_MISSING, never deleted", () => {
    expect(department({ department: null })).toEqual({
      action: "MARK_MISSING",
      writeHash: false,
      clearMissing: false,
      warning: "DEPARTMENT_MISSING",
    });
    expect(
      department({
        department: null,
        mapRow: {
          entityType: "LOCATION",
          internalId: "loc-bar",
          lastHash: "old",
          upstreamRemovedAt: NOW,
        },
      }),
    ).toMatchObject({ action: "UNCHANGED", warning: "DEPARTMENT_MISSING" });
    expect(department({ department: null, mapRow: null })).toMatchObject({ action: "IGNORE" });
    // Back on the list: the mark is cleared.
    expect(
      department({
        mapRow: {
          entityType: "LOCATION",
          internalId: "loc-bar",
          lastHash: "new",
          upstreamRemovedAt: NOW,
        },
      }),
    ).toMatchObject({ action: "UNCHANGED", clearMissing: true });
  });

  it("included without a mapping, or mapped to a deleted location → a warning, nothing written", () => {
    expect(department({ mapping: null })).toMatchObject({
      action: "IGNORE",
      warning: "DEPARTMENT_UNMAPPED",
    });
    expect(
      department({
        location: { id: "loc-bar", name: "Bar", managedByIntegrationId: null, deleted: true },
      }),
    ).toMatchObject({ action: "IGNORE", warning: "DEPARTMENT_TARGET_MISSING" });
  });

  it("hashes the record and its mapping entry", () => {
    const hash = (...args: Parameters<typeof departmentDecisionInputs>) =>
      hashDecisionInputs(hmac, departmentDecisionInputs(...args));
    const base = hash(BAR, true, { target: "LOCATION", locationId: "loc-bar" });
    expect(hash({ ...BAR }, true, { target: "LOCATION", locationId: "loc-bar" })).toBe(base);
    expect(
      hash({ ...BAR, name: "Cocktail Bar" }, true, { target: "LOCATION", locationId: "loc-bar" }),
    ).not.toBe(base);
    expect(hash(BAR, true, { target: "LOCATION", locationId: "loc-x" })).not.toBe(base);
    expect(hash(BAR, false, null)).not.toBe(base);
  });
});

describe("decideGroupAction (§6.4)", () => {
  it("mapped to a new team → create; existing team → map row, not managed", () => {
    expect(group({ mapping: { target: "NEW_TEAM" }, mapRow: null, team: null })).toEqual({
      action: "CREATE_TEAM",
      name: "Bartenders",
      writeHash: true,
      clearMissing: false,
    });
    expect(
      group({
        mapping: { target: "TEAM", teamId: "team-x" },
        mapRow: null,
        team: { id: "team-x", name: "Bar staff", managedByIntegrationId: null },
      }),
    ).toMatchObject({ action: "LINK", internalId: "team-x", replacesMapRow: false });
  });

  it("not mapped → ignored", () => {
    expect(group({ mapping: null })).toMatchObject({ action: "IGNORE" });
  });

  it("renamed and missing as for departments", () => {
    expect(group({ group: { externalId: "201", name: "Mixologists" } })).toMatchObject({
      action: "RENAME_TEAM",
      teamId: "team-1",
      name: "Mixologists",
    });
    expect(
      group({
        group: { externalId: "201", name: "Mixologists" },
        team: { id: "team-1", name: "Bartenders", managedByIntegrationId: null },
      }),
    ).toMatchObject({ action: "REHASH_ONLY" });
    expect(group({ group: null })).toMatchObject({
      action: "MARK_MISSING",
      warning: "GROUP_MISSING",
    });
    expect(group({ hash: "old" })).toMatchObject({ action: "UNCHANGED" });
    expect(groupDecisionInputs({ externalId: "201", name: " Bartenders " }, null)).toMatchObject({
      record: { name: "Bartenders" },
    });
  });
});

describe("memberships (§6.4)", () => {
  it("adds missing rows and removes rows of mapped targets only", () => {
    expect(
      decideMemberships({
        desired: ["team-a", "team-b"],
        current: ["team-b", "team-c", "team-clockoff"],
        managed: ["team-a", "team-b", "team-c"],
      }),
    ).toEqual({ add: ["team-a"], remove: ["team-c"] });
  });

  it("lists the managed targets from the mappings", () => {
    expect(
      mappedLocationIds(
        {
          "101": { target: "LOCATION", locationId: "loc-bar" },
          "102": { target: "DEPARTMENT", departmentId: "dept-1" },
          "103": { target: "LOCATION", locationId: "loc-office" },
        },
        ["101", "102"],
      ),
    ).toEqual(["loc-bar"]);
    expect(
      mappedTeamIds({
        "201": { target: "TEAM", teamId: "t1" },
        "202": { target: "TEAM", teamId: "t1" },
      }),
    ).toEqual(["t1"]);
  });
});

describe("catalogue", () => {
  interface Entry extends CatalogEntry {
    readonly employeeCount: number | null;
  }
  const create = (r: {
    externalId: string;
    name: string;
    number: string | null;
    firstSeenAt: string;
  }): Entry => ({
    ...r,
    missing: false,
    employeeCount: null,
  });

  it("adds new entries, refreshes names and keeps other fields", () => {
    const entries: Entry[] = [
      {
        externalId: "101",
        name: "Bar",
        number: "1",
        firstSeenAt: "2026-10-01T00:00:00.000Z",
        missing: true,
        employeeCount: 5,
      },
    ];
    const merged = mergeCatalogPage(
      entries,
      [
        { externalId: "101", name: "Cocktail Bar", number: "1" },
        { externalId: "104", name: "Terrace", number: null },
      ],
      NOW,
      create,
    );
    expect(merged.added).toEqual(["104"]);
    expect(merged.entries).toEqual([
      {
        externalId: "101",
        name: "Cocktail Bar",
        number: "1",
        firstSeenAt: "2026-10-01T00:00:00.000Z",
        missing: false,
        employeeCount: 5,
      },
      {
        externalId: "104",
        name: "Terrace",
        number: null,
        firstSeenAt: NOW.toISOString(),
        missing: false,
        employeeCount: null,
      },
    ]);
  });

  it("marks entries a complete read did not return as missing (never the 'none' row)", () => {
    const entries: Entry[] = [
      { externalId: "101", name: "Bar", firstSeenAt: "x", missing: false, employeeCount: null },
      {
        externalId: "103",
        name: "Head Office",
        firstSeenAt: "x",
        missing: false,
        employeeCount: null,
      },
      { externalId: "105", name: "Old", firstSeenAt: "x", missing: true, employeeCount: null },
      {
        externalId: "none",
        name: "Not in any department",
        firstSeenAt: "x",
        missing: false,
        employeeCount: 1,
      },
    ];
    const marked = markMissingCatalogEntries(entries, ["101"]);
    expect(marked.missing).toEqual(["103"]);
    expect(marked.entries.map((e) => [e.externalId, e.missing])).toEqual([
      ["101", false],
      ["103", true],
      ["105", true],
      ["none", false],
    ]);
  });
});
