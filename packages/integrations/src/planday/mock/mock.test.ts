import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPlandayFixture,
  createMockPlanday,
  FROZEN_NOW,
  localToMs,
  MOCK_CUSTOMER_APP_ID,
  MOCK_DEPARTMENT_IDS,
  MOCK_EMPLOYEE_IDS,
  MOCK_NO_DEPARTMENTS_PORTAL_ID,
  MOCK_PORTAL_ID,
  MOCK_READ_SCOPES,
  MOCK_REFRESH_TOKEN,
  MOCK_SECOND_PORTAL_ID,
  MOCK_TEST_CREDENTIALS,
  MockPlandayForbiddenError,
  mockPlandayRefusal,
  assertMockPlandayAllowed,
  SENTINEL_BIRTH_DATE,
  SENTINEL_PII_PREFIX,
  fixtureCsvCollision,
  fixtureCsvEmployees,
  fixtureNamesake,
  type MockPortalFixture,
  type MockShiftFixture,
  type PlandayFixture,
} from "./index";

/**
 * Mock Planday's fixture (spec §11, plan §12.3) and its production guard (plan §12.5). The counts and specials
 * below are the contract the provider, sync and e2e suites build on.
 */

const ZONE = "Europe/London";
const fixture = buildPlandayFixture({ anchor: FROZEN_NOW });
const portalOf = (f: PlandayFixture, id: number): MockPortalFixture =>
  f.portals.find((p) => p.info.id === id)!;
const main = portalOf(fixture, MOCK_PORTAL_ID);
const shift = (id: number): MockShiftFixture => main.shifts.find((s) => s.id === id)!;
const hours = (s: MockShiftFixture) =>
  (localToMs(s.end, s.timeZone) - localToMs(s.start, s.timeZone)) / 3_600_000;
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sunday

describe("buildPlandayFixture at FROZEN_NOW", () => {
  it("is anchored at Wednesday 21 October 2026, 11:30 BST, over the weeks of 19 Oct to 9 Nov", () => {
    expect(FROZEN_NOW.toISOString()).toBe("2026-10-21T10:30:00.000Z");
    expect(fixture.anchor).toBe(FROZEN_NOW.toISOString());
    expect(fixture.timeZone).toBe(ZONE);
    expect(fixture.weekStarts).toEqual(["2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09"]);
  });

  it("is deterministic", () => {
    expect(buildPlandayFixture({ anchor: FROZEN_NOW })).toEqual(fixture);
    expect(buildPlandayFixture()).toEqual(fixture);
  });

  it("has the main portal, one Europe/London portal without child portals", () => {
    expect(main.info).toEqual({
      id: 4100001,
      name: "Mock Bistro Group",
      companyName: "Mock Bistro Group Ltd",
      country: "GB",
      timeZone: ZONE,
      maxDepartments: null,
      aliases: ["mockbistro"],
      portals: [],
    });
  });

  it("has 3 departments and 4 employee groups", () => {
    expect(main.departments.map((d) => [d.id, d.name])).toEqual([
      [101, "Bar"],
      [102, "Kitchen"],
      [103, "Head Office"],
    ]);
    expect(main.employeeGroups.map((g) => [g.id, g.name])).toEqual([
      [201, "Bartenders"],
      [202, "Chefs"],
      [203, "Floor Staff"],
      [204, "Supervisors"],
    ]);
  });

  it("has the 12 employees of the plan's table", () => {
    const rows = main.employees.map((e) => [
      e.raw.id,
      `${e.raw.firstName} ${e.raw.lastName}`,
      e.raw.departments,
      e.raw.primaryDepartmentId,
      e.raw.employeeGroups,
      e.status,
    ]);
    expect(rows).toEqual([
      [1001, "Aisha Khan", [101], 101, [201], "ACTIVE"],
      [1002, "Ben Carter", [101], 101, [201, 204], "ACTIVE"],
      [1003, "Chloe Davies", [102], 102, [202], "ACTIVE"],
      [1004, "Daniel Evans", [102], 102, [202], "ACTIVE"],
      [1005, "Alex Morgan", [101], 101, [203], "ACTIVE"],
      [1006, "Alex Morgan", [102], 102, [203], "ACTIVE"],
      [1007, "Priya Patel", [101, 102], 101, [204], "ACTIVE"],
      [1008, "Tom Harris", [102], 102, [202], "ACTIVE"],
      [1009, "Grace Lee", [101], 101, [203], "ACTIVE"],
      [1010, "Omar Said", [103], 103, [204], "ACTIVE"],
      [1011, "Hannah Wright", [101], 101, [203], "DEACTIVATED"],
      [1012, "Leo Turner", [102], 102, [203], "ACTIVE"],
    ]);
  });

  it("covers the employee specials: no email, shared name, CSV match, deactivated", () => {
    const byId = new Map(main.employees.map((e) => [e.raw.id, e]));
    expect(byId.get(MOCK_EMPLOYEE_IDS.DANIEL_EVANS)!.raw.email).toBeNull();
    const [a, b] = [byId.get(1005)!.raw, byId.get(1006)!.raw];
    expect([a.firstName, a.lastName]).toEqual([b.firstName, b.lastName]);
    expect(a.email).not.toBe(b.email);
    const emails = main.employees.map((e) => e.raw.email).filter((e): e is string => Boolean(e));
    expect(new Set(emails.map((e) => e.toLowerCase())).size).toBe(emails.length);

    expect(fixtureCsvEmployees).toEqual([
      expect.objectContaining({
        firstName: "Priya",
        lastName: "Patel",
        externalEmployeeId: "1007",
        email: byId.get(1007)!.raw.email,
      }),
    ]);
    expect(fixtureCsvCollision.externalEmployeeId).toBe("1008");
    expect(`${fixtureCsvCollision.firstName} ${fixtureCsvCollision.lastName}`).not.toBe(
      "Tom Harris",
    );
    expect(fixtureCsvCollision.email).not.toBe(byId.get(1008)!.raw.email);
    expect(fixtureNamesake).toEqual({
      firstName: "Alex",
      lastName: "Morgan",
      email: null,
      externalEmployeeId: null,
    });

    const hannah = byId.get(MOCK_EMPLOYEE_IDS.HANNAH_WRIGHT)!;
    expect(hannah.raw.deactivationDate).toBe("2026-10-12");
    expect(hannah.raw.dateTimeDeleted).toBe("2026-10-12T08:00:00Z");
    expect(hannah.raw.deactivationReason).toBe("SENTINEL-PII-REASON-1011");
    expect(hannah.stayOnActiveList).toBe(false);
  });

  it("fills every strip-set field with a sentinel", () => {
    for (const e of [...main.employees, ...fixture.portals.flatMap((p) => p.employees)]) {
      const id = e.raw.id;
      expect(e.raw).toMatchObject({
        userName: `sentinel-${id}@pii.invalid`,
        cellPhone: `+4470090${id}`,
        phone: `+4470090${id}`,
        street1: `SENTINEL-PII-street1-${id}`,
        street2: `SENTINEL-PII-street2-${id}`,
        zip: `SENTINEL-PII-zip-${id}`,
        city: `SENTINEL-PII-city-${id}`,
        salaryIdentifier: `SENTINEL-PII-salaryIdentifier-${id}`,
        ssn: `SENTINEL-PII-ssn-${id}`,
        bankAccount: {
          registrationNumber: `SENTINEL-PII-registrationNumber-${id}`,
          accountNumber: `SENTINEL-PII-accountNumber-${id}`,
        },
        birthDate: SENTINEL_BIRTH_DATE,
      });
      expect(e.details.customFields.custom_1).toEqual({
        name: "Shoe size",
        type: "Text",
        value: `SENTINEL-PII-CUSTOM-${id}`,
        url: null,
      });
      expect(e.details.jobTitle).toBe(`SENTINEL-PII-jobTitle-${id}`);
    }
    expect(SENTINEL_BIRTH_DATE).toBe("1901-02-03T00:00:00Z");
  });

  it("has 60 shifts over the four weeks, each with a sentinel comment", () => {
    expect(main.shifts).toHaveLength(60);
    expect(new Set(main.shifts.map((s) => s.id)).size).toBe(60);
    for (const s of main.shifts) {
      expect(s.comment).toBe(`${SENTINEL_PII_PREFIX}-COMMENT-${s.id}`);
      expect(s.timeZone).toBe(ZONE);
      expect(s.start.slice(0, 10) >= "2026-10-19" && s.start.slice(0, 10) <= "2026-11-15").toBe(
        true,
      );
      expect(hours(s)).toBeGreaterThan(0);
    }
    expect(main.deletedShifts).toEqual([]);
  });

  it("has the weekly pattern for 1001–1009 and 1012 (Bar 10:00–18:00, Kitchen 08:00–16:00)", () => {
    const sp = fixture.specials;
    const specialIds = new Set([
      sp.inProgressShiftId,
      ...sp.overnightShiftIds,
      sp.openShiftId,
      sp.draftShiftId,
      sp.dstShiftId!,
      sp.excludedDepartmentShiftId,
    ]);
    const pattern = main.shifts.filter((s) => !specialIds.has(s.id));
    expect(pattern).toHaveLength(51);
    const workers = new Set(pattern.map((s) => s.employeeId));
    expect([...workers].sort()).toEqual([
      1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1012,
    ]);
    for (const s of pattern) {
      const times = `${s.start.slice(11, 16)}-${s.end.slice(11, 16)}`;
      expect(times).toBe(
        s.departmentId === MOCK_DEPARTMENT_IDS.BAR ? "10:00-18:00" : "08:00-16:00",
      );
      expect(s.start.slice(0, 10)).toBe(s.end.slice(0, 10));
    }
    // Staggered: no day has every pattern employee.
    const perDay = new Map<string, number>();
    for (const s of pattern)
      perDay.set(s.start.slice(0, 10), (perDay.get(s.start.slice(0, 10)) ?? 0) + 1);
    expect(Math.max(...perDay.values())).toBeLessThan(10);
  });

  it("has every special of the plan's table exactly once", () => {
    const sp = fixture.specials;

    expect(sp.overnightShiftIds).toHaveLength(4);
    for (const id of sp.overnightShiftIds) {
      const s = shift(id);
      expect([s.employeeId, s.departmentId, s.status]).toEqual([1002, 101, "Assigned"]);
      expect(weekday(s.start.slice(0, 10))).toBe(5); // Friday
      expect([s.start.slice(11), s.end.slice(11)]).toEqual(["20:00:00", "02:00:00"]);
      expect(weekday(s.end.slice(0, 10))).toBe(6); // Saturday
    }

    const open = shift(sp.openShiftId);
    expect(open).toMatchObject({ employeeId: null, status: "Open", departmentId: 101 });
    expect(open.start.slice(0, 10)).toBe("2026-10-24"); // Saturday of week 1

    const draft = shift(sp.draftShiftId);
    expect(draft).toMatchObject({ employeeId: 1003, status: "Draft", departmentId: 102 });
    expect(draft.start.slice(0, 10)).toBe("2026-10-28"); // Wednesday of week 2

    const dst = shift(sp.dstShiftId!);
    expect(dst).toMatchObject({
      employeeId: 1002,
      start: "2026-10-24T22:00:00",
      end: "2026-10-25T06:00:00",
    });
    expect(hours(dst)).toBe(9);

    const inProgress = shift(sp.inProgressShiftId);
    expect(inProgress).toMatchObject({
      employeeId: 1001,
      start: "2026-10-21T09:00:00",
      end: "2026-10-21T17:00:00",
      status: "PunchclockStarted",
      punchClockShiftId: sp.inProgressPunchClockShiftId,
    });
    const now = FROZEN_NOW.getTime();
    expect(localToMs(inProgress.start, ZONE) < now && now < localToMs(inProgress.end, ZONE)).toBe(
      true,
    );
    // Its pattern shift that day was replaced, not doubled.
    expect(
      main.shifts.filter((s) => s.employeeId === 1001 && s.start.startsWith("2026-10-21")),
    ).toHaveLength(1);

    const excluded = shift(sp.excludedDepartmentShiftId);
    expect(excluded).toMatchObject({
      employeeId: 1010,
      departmentId: MOCK_DEPARTMENT_IDS.HEAD_OFFICE,
    });
    expect(excluded.start.slice(0, 10)).toBe("2026-10-27"); // Tuesday of week 2
    expect(main.shifts.filter((s) => s.departmentId === 103)).toHaveLength(1);

    expect(sp.hiddenDay).toMatchObject({ departmentId: 102, date: "2026-11-05" }); // Thursday of week 3
    expect(sp.hiddenDay.shiftIds.length).toBeGreaterThan(0);
    for (const id of sp.hiddenDay.shiftIds) {
      expect(shift(id)).toMatchObject({ departmentId: 102 });
      expect(shift(id).start.slice(0, 10)).toBe("2026-11-05");
    }
    expect(main.hiddenDays).toEqual([{ departmentId: 102, date: "2026-11-05" }]);

    const statusCount = (status: string) => main.shifts.filter((s) => s.status === status).length;
    expect(statusCount("ForSale")).toBe(1);
    expect(statusCount("Approved")).toBe(1);
    expect(statusCount("PunchclockStarted")).toBe(1);
    expect(statusCount("Draft")).toBe(1);
    expect(statusCount("Open")).toBe(1);
    expect(shift(sp.forSaleShiftId)).toMatchObject({ employeeId: 1005, status: "ForSale" });
    expect(shift(sp.forSaleShiftId).start.slice(0, 10)).toBe("2026-10-29");
    const approved = shift(sp.approvedShiftId);
    expect(approved).toMatchObject({
      employeeId: 1001,
      status: "Approved",
      start: "2026-10-19T10:00:00",
      punchClockShiftId: sp.finishedPunchClockShiftId,
    });
    expect(main.shifts.filter((s) => s.employeeId === null)).toHaveLength(1);
  });

  it("has the punch clock records for the Beta tests", () => {
    const sp = fixture.specials;
    expect(main.punchClockShifts).toEqual([
      expect.objectContaining({
        id: sp.inProgressPunchClockShiftId,
        shiftId: sp.inProgressShiftId,
        employeeId: 1001,
        start: "2026-10-21T08:58:00",
        end: null,
      }),
      expect.objectContaining({
        id: sp.finishedPunchClockShiftId,
        shiftId: sp.approvedShiftId,
        employeeId: 1001,
        start: "2026-10-19T09:55:00",
        end: "2026-10-19T18:04:00",
        isApproved: true,
      }),
      expect.objectContaining({
        id: sp.excludedDepartmentPunchClockShiftId,
        shiftId: null,
        departmentId: MOCK_DEPARTMENT_IDS.HEAD_OFFICE,
        employeeId: 1010,
        end: null,
      }),
    ]);
    expect(main.punchClockBreaks).toEqual([
      {
        id: 810001,
        punchClockShiftId: sp.finishedPunchClockShiftId,
        start: "2026-10-19T13:00:00",
        end: "2026-10-19T13:30:00",
      },
    ]);
  });

  it("has a second portal with overlapping ids and a third without departments", () => {
    const cafe = portalOf(fixture, MOCK_SECOND_PORTAL_ID);
    expect(cafe.info).toMatchObject({ id: 4100002, name: "Mock Cafe Co", timeZone: ZONE });
    expect(cafe.departments.map((d) => d.id)).toEqual([101]);
    expect(cafe.employees.map((e) => e.raw.id)).toEqual([1001, 1002, 1003]);
    expect(cafe.employees.map((e) => e.raw.firstName)).not.toContain("Aisha");
    const mainShiftIds = new Set(main.shifts.map((s) => s.id));
    expect(cafe.shifts.length).toBeGreaterThan(0);
    expect(cafe.shifts.every((s) => mainShiftIds.has(s.id))).toBe(true);

    const kiosk = portalOf(fixture, MOCK_NO_DEPARTMENTS_PORTAL_ID);
    expect(kiosk.info).toMatchObject({ id: 4100003, name: "Mock Kiosk" });
    expect(kiosk.departments).toEqual([]);
    expect(kiosk.employees).toHaveLength(3);
    for (const e of kiosk.employees) {
      expect(e.raw.departments).toEqual([]);
      expect(e.raw.primaryDepartmentId).toBeNull();
    }
    expect(kiosk.shifts.length).toBeGreaterThan(0);
    expect(kiosk.shifts.every((s) => s.departmentId === null)).toBe(true);
  });

  it("does not change the main portal's counts with the extra portals", () => {
    expect(fixture.portals.map((p) => p.info.id)).toEqual([4100001, 4100002, 4100003]);
    expect(main.employees).toHaveLength(12);
    expect(main.departments).toHaveLength(3);
  });

  it("has method C credentials for every portal", () => {
    expect(MOCK_CUSTOMER_APP_ID).toBe("5f0c6a3e-0000-4000-8000-00000000c0de");
    expect(MOCK_REFRESH_TOKEN).toBe("mock-refresh-portal-4100001");
    expect(MOCK_TEST_CREDENTIALS).toEqual({
      appId: MOCK_CUSTOMER_APP_ID,
      refreshToken: MOCK_REFRESH_TOKEN,
    });
    expect(fixture.apps).toHaveLength(3);
    for (const app of fixture.apps) {
      expect(app.kind).toBe("CUSTOMER");
      expect(app.scopes).toEqual([...MOCK_READ_SCOPES]);
      expect(app.appId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(app.refreshToken).toBe(`mock-refresh-portal-${app.portalId}`);
    }
  });
});

describe("buildPlandayFixture with another anchor", () => {
  it("moves the in-progress shift to the anchor's day", () => {
    const anchor = new Date("2026-11-30T12:00:00Z"); // Monday, GMT
    const f = buildPlandayFixture({ anchor });
    const p = portalOf(f, MOCK_PORTAL_ID);
    expect(f.weekStarts[0]).toBe("2026-11-30");
    const inProgress = p.shifts.find((s) => s.id === f.specials.inProgressShiftId)!;
    expect([inProgress.start, inProgress.end]).toEqual([
      "2026-11-30T09:00:00",
      "2026-11-30T17:00:00",
    ]);
    expect(
      p.shifts.filter((s) => s.employeeId === 1001 && s.start.startsWith("2026-11-30")),
    ).toHaveLength(1);
    // No transition between 30 Nov and 27 Dec: no DST shift.
    expect(f.specials.dstShiftId).toBeNull();
    expect(p.shifts).toHaveLength(59);
  });

  it("puts the DST shift on the late-March transition when it falls inside the four weeks", () => {
    const f = buildPlandayFixture({ anchor: new Date("2027-03-17T12:00:00Z") });
    const p = portalOf(f, MOCK_PORTAL_ID);
    const dst = p.shifts.find((s) => s.id === f.specials.dstShiftId)!;
    expect([dst.start, dst.end]).toEqual(["2027-03-27T22:00:00", "2027-03-28T06:00:00"]);
    expect(hours(dst)).toBe(7); // spring forward
  });
});

describe("production guard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("names why the mock may not run", () => {
    expect(mockPlandayRefusal({ NODE_ENV: "test" })).toBeNull();
    expect(mockPlandayRefusal({ NODE_ENV: "development" })).toBeNull();
    expect(mockPlandayRefusal({ NODE_ENV: "production" })).toMatch(/NODE_ENV is production/);
    expect(
      mockPlandayRefusal({ NODE_ENV: "development", RAILWAY_ENVIRONMENT_NAME: "production" }),
    ).toMatch(/Railway/);
    expect(mockPlandayRefusal({ RAILWAY_PROJECT_ID: "p" })).toMatch(/Railway/);
    expect(mockPlandayRefusal({ RAILWAY_ENVIRONMENT_ID: " " })).toBeNull();
  });

  it("refuses createMockPlanday in production", () => {
    expect(() => createMockPlanday({ env: { NODE_ENV: "production" } })).toThrowError(
      MockPlandayForbiddenError,
    );
    expect(() => createMockPlanday({ env: { RAILWAY_ENVIRONMENT_ID: "env" } })).toThrowError(
      /never runs in production/,
    );
    vi.stubEnv("NODE_ENV", "production");
    expect(() => createMockPlanday()).toThrowError(MockPlandayForbiddenError);
    expect(() => assertMockPlandayAllowed("scripts/mock-planday.mts")).toThrowError(
      /scripts\/mock-planday\.mts refused/,
    );
  });

  it("checks the real environment even when given one: an injected env can add a refusal, never lift one", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => createMockPlanday({ env: {} })).toThrowError(MockPlandayForbiddenError);
    expect(() => createMockPlanday({ env: { NODE_ENV: "development" } })).toThrowError(
      /NODE_ENV is production/,
    );
    expect(() => assertMockPlandayAllowed("x", { NODE_ENV: "test" })).toThrowError(
      MockPlandayForbiddenError,
    );
    vi.unstubAllEnvs();
    vi.stubEnv("RAILWAY_ENVIRONMENT_ID", "env-1");
    expect(() => createMockPlanday({ env: { NODE_ENV: "development" } })).toThrowError(
      /RAILWAY_ENVIRONMENT_ID is set/,
    );
  });

  it("allows it in development and tests", () => {
    expect(() => assertMockPlandayAllowed("x", { NODE_ENV: "development" })).not.toThrow();
    expect(createMockPlanday().state.portals.size).toBe(3);
  });

  it("can be imported in production (only using it is refused)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(import("./index")).resolves.toHaveProperty("createMockPlanday");
  });
});
