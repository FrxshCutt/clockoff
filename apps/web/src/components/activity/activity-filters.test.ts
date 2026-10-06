import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACTIVITY_PAGE_STATE,
  DEFAULT_COMPLIANCE_PARAMS,
  DEFAULT_FEED_PARAMS,
  complianceListHref,
  employeeActivityHref,
  hasActiveComplianceFilters,
  hasActiveFeedFilters,
  isLocalDate,
  parseActivityPageState,
  parseTypeList,
  resolveDateRange,
  serializeActivityPageState,
  toActivityApiQuery,
  toComplianceApiQuery,
  type ActivityPageState,
} from "./activity-filters";

const EMPLOYEE_ID = "0b0e2e9e-7c0a-4a2b-9e3b-1b4c2a9d8f10";
const LOCATION_ID = "c7a1c8f2-4d7e-4d1b-9e55-2a4d8b6c3e21";
const NOW = Date.parse("2026-10-06T09:00:00.000Z");

const parse = (qs: string) => parseActivityPageState(new URLSearchParams(qs));

describe("parseActivityPageState", () => {
  it("yields the defaults for an empty URL and keeps a clean URL for the defaults", () => {
    expect(parse("")).toEqual(DEFAULT_ACTIVITY_PAGE_STATE);
    expect(serializeActivityPageState(DEFAULT_ACTIVITY_PAGE_STATE)).toBe("");
  });

  it("round-trips the timeline filters (the location filter is shared by both tabs)", () => {
    const state: ActivityPageState = {
      ...DEFAULT_ACTIVITY_PAGE_STATE,
      feed: {
        employeeId: EMPLOYEE_ID,
        types: ["BREAK_STARTED", "BREAK_ENDED"],
        range: "custom",
        from: "2026-06-01",
        to: "2026-06-02",
        locationId: LOCATION_ID,
      },
      compliance: { ...DEFAULT_COMPLIANCE_PARAMS, locationId: LOCATION_ID },
    };
    const qs = serializeActivityPageState(state);
    expect(qs).toContain(`employee=${EMPLOYEE_ID}`);
    expect(qs).toContain("type=BREAK_STARTED%2CBREAK_ENDED");
    expect(qs).toContain(`location=${LOCATION_ID}`);
    expect(parse(qs)).toEqual(state);
  });

  it("round-trips the compliance tab state (the location filter is shared by both tabs)", () => {
    const state: ActivityPageState = {
      ...DEFAULT_ACTIVITY_PAGE_STATE,
      tab: "compliance",
      feed: { ...DEFAULT_FEED_PARAMS, locationId: LOCATION_ID },
      compliance: {
        filter: "NEEDS_ATTENTION",
        search: "jane",
        page: 3,
        pageSize: 50,
        locationId: LOCATION_ID,
        teamId: EMPLOYEE_ID,
      },
    };
    const qs = serializeActivityPageState(state);
    expect(qs).toContain("tab=compliance");
    expect(qs).toContain("filter=NEEDS_ATTENTION");
    expect(parse(qs)).toEqual(state);
  });

  it("only serialises the active tab's filters", () => {
    const state: ActivityPageState = {
      tab: "compliance",
      feed: { ...DEFAULT_FEED_PARAMS, employeeId: EMPLOYEE_ID },
      compliance: { ...DEFAULT_COMPLIANCE_PARAMS, filter: "ON_BREAK" },
    };
    expect(serializeActivityPageState(state)).toBe("tab=compliance&filter=ON_BREAK");
  });

  it("falls back to defaults for anything invalid instead of erroring", () => {
    const state = parse(
      `tab=bogus&employee=not-a-uuid&type=BOGUS,BREAK_STARTED&range=yearly&location=12&page=0&pageSize=7&filter=NOPE`,
    );
    expect(state.tab).toBe("activity");
    expect(state.feed.employeeId).toBeNull();
    expect(state.feed.types).toEqual(["BREAK_STARTED"]);
    expect(state.feed.range).toBe(DEFAULT_FEED_PARAMS.range);
    expect(state.feed.locationId).toBeNull();
    expect(state.compliance.page).toBe(1);
    expect(state.compliance.pageSize).toBe(DEFAULT_COMPLIANCE_PARAMS.pageSize);
    expect(state.compliance.filter).toBe("ALL");
  });

  it("ignores custom bounds unless the range is custom, and drops malformed dates", () => {
    expect(parse("range=7d&from=2026-06-01&to=2026-06-02").feed).toMatchObject({
      range: "7d",
      from: null,
      to: null,
    });
    expect(parse("range=custom&from=2026-06-01&to=2026-13-40").feed).toMatchObject({
      range: "custom",
      from: "2026-06-01",
      to: null,
    });
    expect(parse("range=custom&from=June").feed.from).toBeNull();
  });

  it("accepts repeated and comma-separated type parameters, de-duplicated in order", () => {
    expect(parseTypeList(["BREAK_ENDED,BREAK_STARTED", "BREAK_ENDED", " SHIFT_CREATED "])).toEqual([
      "BREAK_ENDED",
      "BREAK_STARTED",
      "SHIFT_CREATED",
    ]);
    expect(parse("type=BREAK_ENDED&type=SHIFT_CREATED").feed.types).toEqual([
      "BREAK_ENDED",
      "SHIFT_CREATED",
    ]);
  });

  it("trims and caps the search text", () => {
    expect(parse(`tab=compliance&q=${encodeURIComponent("  jane  ")}`).compliance.search).toBe(
      "jane",
    );
    expect(parse(`tab=compliance&q=${"x".repeat(150)}`).compliance.search).toHaveLength(100);
  });

  it("validates local dates", () => {
    expect(isLocalDate("2026-02-28")).toBe(true);
    expect(isLocalDate("2026-02-30")).toBe(false);
    expect(isLocalDate("2026-2-8")).toBe(false);
    expect(isLocalDate(null)).toBe(false);
  });
});

describe("links into the page", () => {
  it("builds the compliance tab link the metric cards use", () => {
    expect(complianceListHref()).toBe("/activity?tab=compliance");
    expect(complianceListHref("ALL")).toBe("/activity?tab=compliance");
    expect(complianceListHref("NEEDS_ATTENTION")).toBe(
      "/activity?tab=compliance&filter=NEEDS_ATTENTION",
    );
    expect(
      parse(complianceListHref("WORK_MODE_ACTIVE").split("?")[1] ?? "").compliance.filter,
    ).toBe("WORK_MODE_ACTIVE");
  });

  it("builds the employee feed link with the whole history", () => {
    const href = employeeActivityHref(EMPLOYEE_ID);
    expect(href).toBe(`/activity?employee=${EMPLOYEE_ID}&range=all`);
    expect(parse(href.split("?")[1] ?? "").feed).toMatchObject({
      employeeId: EMPLOYEE_ID,
      range: "all",
    });
  });
});

describe("resolveDateRange", () => {
  it("resolves presets to rolling windows ending now", () => {
    expect(resolveDateRange({ range: "all", from: null, to: null }, NOW, "Europe/London")).toEqual(
      {},
    );
    expect(resolveDateRange({ range: "24h", from: null, to: null }, NOW, "Europe/London")).toEqual({
      from: "2026-10-05T09:00:00.000Z",
    });
    expect(resolveDateRange({ range: "7d", from: null, to: null }, NOW, "Europe/London")).toEqual({
      from: "2026-09-29T09:00:00.000Z",
    });
    expect(resolveDateRange({ range: "30d", from: null, to: null }, NOW, "Europe/London")).toEqual({
      from: "2026-09-06T09:00:00.000Z",
    });
  });

  it("covers whole local days of the organisation's zone for a custom range", () => {
    // British Summer Time: midnight in London is 23:00 UTC the day before.
    expect(
      resolveDateRange(
        { range: "custom", from: "2026-06-01", to: "2026-06-02" },
        NOW,
        "Europe/London",
      ),
    ).toEqual({
      from: "2026-05-31T23:00:00.000Z",
      to: "2026-06-02T22:59:59.999Z",
    });
    expect(
      resolveDateRange({ range: "custom", from: "2026-01-10", to: null }, NOW, "America/New_York"),
    ).toEqual({ from: "2026-01-10T05:00:00.000Z" });
  });

  it("drops an end bound that is not after the start, and bad dates or zones", () => {
    expect(
      resolveDateRange(
        { range: "custom", from: "2026-06-05", to: "2026-06-01" },
        NOW,
        "Europe/London",
      ),
    ).toEqual({ from: "2026-06-04T23:00:00.000Z" });
    expect(
      resolveDateRange({ range: "custom", from: "nope", to: "2026-06-01" }, NOW, "Europe/London"),
    ).toEqual({ to: "2026-06-01T22:59:59.999Z" });
    expect(
      resolveDateRange({ range: "custom", from: "2026-06-01", to: null }, NOW, "Not/AZone"),
    ).toEqual({ from: "2026-06-01T00:00:00.000Z" });
  });
});

describe("API queries", () => {
  it("maps the feed state to GET /api/activity parameters", () => {
    expect(toActivityApiQuery(DEFAULT_FEED_PARAMS, NOW, "UTC")).toEqual({
      limit: 25,
      from: "2026-09-29T09:00:00.000Z",
    });
    expect(
      toActivityApiQuery(
        {
          employeeId: EMPLOYEE_ID,
          types: ["BREAK_STARTED"],
          range: "all",
          from: null,
          to: null,
          locationId: LOCATION_ID,
        },
        NOW,
        "UTC",
        50,
      ),
    ).toEqual({
      limit: 50,
      employeeId: EMPLOYEE_ID,
      type: ["BREAK_STARTED"],
      locationId: LOCATION_ID,
    });
  });

  it("maps the compliance state to GET /api/compliance/employees parameters", () => {
    expect(toComplianceApiQuery(DEFAULT_COMPLIANCE_PARAMS)).toEqual({
      filter: "ALL",
      page: 1,
      pageSize: 25,
    });
    expect(
      toComplianceApiQuery({
        ...DEFAULT_COMPLIANCE_PARAMS,
        search: "  jane ",
        locationId: LOCATION_ID,
        teamId: EMPLOYEE_ID,
        filter: "ON_BREAK",
      }),
    ).toEqual({
      filter: "ON_BREAK",
      page: 1,
      pageSize: 25,
      search: "jane",
      locationId: LOCATION_ID,
      teamId: EMPLOYEE_ID,
    });
  });

  it("knows when filters narrow the view (so a Reset button appears)", () => {
    expect(hasActiveFeedFilters(DEFAULT_FEED_PARAMS)).toBe(false);
    expect(hasActiveFeedFilters({ ...DEFAULT_FEED_PARAMS, range: "all" })).toBe(true);
    expect(hasActiveFeedFilters({ ...DEFAULT_FEED_PARAMS, types: ["BREAK_ENDED"] })).toBe(true);
    expect(hasActiveComplianceFilters(DEFAULT_COMPLIANCE_PARAMS)).toBe(false);
    expect(hasActiveComplianceFilters({ ...DEFAULT_COMPLIANCE_PARAMS, page: 4 })).toBe(false);
    expect(hasActiveComplianceFilters({ ...DEFAULT_COMPLIANCE_PARAMS, search: "a" })).toBe(true);
    expect(hasActiveComplianceFilters({ ...DEFAULT_COMPLIANCE_PARAMS, filter: "CONNECTED" })).toBe(
      true,
    );
  });
});
