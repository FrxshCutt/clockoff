import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMPLOYEE_LIST_PARAMS,
  EMPLOYEE_QUICK_FILTERS,
  QUICK_FILTER_META,
  columnSortingToSortKey,
  hasActiveEmployeeFilters,
  parseEmployeeListParams,
  serializeEmployeeListParams,
  sortKeyToColumnSorting,
  toEmployeeApiQuery,
  type EmployeeListParams,
} from "./employee-filters";

const LOCATION_ID = "6f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a10";

describe("quick filters → API query", () => {
  it("maps every quick filter to at least one API filter", () => {
    for (const filter of EMPLOYEE_QUICK_FILTERS) {
      const meta = QUICK_FILTER_META[filter];
      expect(
        (meta.inviteStatus?.length ?? 0) + (meta.deviceStatus?.length ?? 0),
        filter,
      ).toBeGreaterThan(0);
    }
  });

  it("sends needsAttention as the non-OK device badges (the Overview link lands on the same rows)", () => {
    const query = toEmployeeApiQuery({ ...DEFAULT_EMPLOYEE_LIST_PARAMS, filter: "needsAttention" });
    expect(query.deviceStatus).toEqual([
      "NEEDS_ATTENTION",
      "PERMISSIONS_MISSING",
      "SYNC_DELAYED",
      "OFFLINE",
    ]);
    expect(query.inviteStatus).toBeUndefined();
  });

  it("maps lifecycle chips to inviteStatus and work chips to deviceStatus", () => {
    expect(
      toEmployeeApiQuery({ ...DEFAULT_EMPLOYEE_LIST_PARAMS, filter: "connected" }).inviteStatus,
    ).toEqual(["CONNECTED"]);
    expect(
      toEmployeeApiQuery({ ...DEFAULT_EMPLOYEE_LIST_PARAMS, filter: "awaitingSetup" }).inviteStatus,
    ).toEqual(["INVITED", "JOINED", "SETUP_INCOMPLETE"]);
    expect(
      toEmployeeApiQuery({ ...DEFAULT_EMPLOYEE_LIST_PARAMS, filter: "working" }).deviceStatus,
    ).toEqual(["WORKING", "WORK_MODE_ACTIVE"]);
    expect(
      toEmployeeApiQuery({ ...DEFAULT_EMPLOYEE_LIST_PARAMS, filter: "onBreak" }).deviceStatus,
    ).toEqual(["ON_BREAK"]);
  });

  it("includes paging, trimmed search, selects and sort; omits empty values", () => {
    const query = toEmployeeApiQuery({
      ...DEFAULT_EMPLOYEE_LIST_PARAMS,
      page: 3,
      pageSize: 50,
      search: "  ada ",
      locationId: LOCATION_ID,
      sort: "-lastSyncAt",
    });
    expect(query).toEqual({
      page: 3,
      pageSize: 50,
      search: "ada",
      locationId: LOCATION_ID,
      sort: "-lastSyncAt",
    });
    expect("departmentId" in query).toBe(false);
  });
});

describe("URL ⇄ params", () => {
  it("parses /employees?filter=needsAttention", () => {
    const params = parseEmployeeListParams(new URLSearchParams("filter=needsAttention"));
    expect(params.filter).toBe("needsAttention");
    expect(params.page).toBe(1);
    expect(hasActiveEmployeeFilters(params)).toBe(true);
  });

  it("ignores unknown or malformed values", () => {
    const params = parseEmployeeListParams(
      new URLSearchParams(
        "filter=bogus&page=-2&pageSize=7&locationId=not-a-uuid&sort=email&q=" + "x".repeat(150),
      ),
    );
    expect(params.filter).toBeNull();
    expect(params.page).toBe(1);
    expect(params.pageSize).toBe(25);
    expect(params.locationId).toBeNull();
    expect(params.sort).toBe("lastName");
    expect(params.search).toHaveLength(100);
  });

  it("accepts Next.js searchParams records (first value wins for arrays)", () => {
    const params = parseEmployeeListParams({
      filter: ["working", "onBreak"],
      page: "2",
      teamId: LOCATION_ID,
    });
    expect(params.filter).toBe("working");
    expect(params.page).toBe(2);
    expect(params.teamId).toBe(LOCATION_ID);
  });

  it("round-trips through serialize and omits defaults", () => {
    expect(serializeEmployeeListParams(DEFAULT_EMPLOYEE_LIST_PARAMS)).toBe("");
    const params: EmployeeListParams = {
      filter: "permissionsMissing",
      search: "grace",
      page: 2,
      pageSize: 50,
      locationId: LOCATION_ID,
      departmentId: null,
      teamId: null,
      policyId: LOCATION_ID,
      sort: "-inviteStatus",
    };
    const qs = serializeEmployeeListParams(params);
    expect(qs).toContain("filter=permissionsMissing");
    expect(qs).toContain("q=grace");
    expect(qs).not.toContain("departmentId");
    expect(parseEmployeeListParams(new URLSearchParams(qs))).toEqual(params);
  });
});

describe("sorting", () => {
  it("maps API sort keys to table sorting and back", () => {
    expect(sortKeyToColumnSorting("-lastSyncAt")).toEqual([{ id: "lastSyncAt", desc: true }]);
    expect(sortKeyToColumnSorting("lastName")).toEqual([{ id: "name", desc: false }]);
    expect(sortKeyToColumnSorting("createdAt")).toEqual([]);
    expect(columnSortingToSortKey([{ id: "inviteStatus", desc: true }])).toBe("-inviteStatus");
    expect(columnSortingToSortKey([{ id: "name", desc: false }])).toBe("lastName");
    expect(columnSortingToSortKey([])).toBe("lastName");
    expect(columnSortingToSortKey([{ id: "policy", desc: true }])).toBe("lastName");
  });
});
