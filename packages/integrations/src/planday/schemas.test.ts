import { describe, expect, it } from "vitest";
import {
  codeExchangeResponseSchema,
  deactivatedEmployeeSchema,
  deletedShiftSchema,
  departmentSchema,
  employeeDetailsSchema,
  employeeGroupSchema,
  employeeSchema,
  pagedResponseSchema,
  plandayIdSchema,
  portalInfoResponseSchema,
  punchClockBreakSchema,
  punchClockShiftSchema,
  scheduleDaySchema,
  shiftSchema,
  singleResponseSchema,
  tokenResponseSchema,
} from "./schemas";

/** Every field of notes §9.2 strip set E, filled with sentinels the way Mock Planday does (plan §12.3). */
function stripSetE(id: number): Record<string, unknown> {
  return {
    userName: `sentinel-${id}@pii.invalid`,
    cellPhone: `+4470090${id}`,
    cellPhoneWithoutCountryPrefix: `70090${id}`,
    cellPhoneCountryPrefix: "+44",
    cellPhoneCountryCode: "GB",
    phone: `+4470091${id}`,
    phoneWithoutCountryPrefix: `70091${id}`,
    phoneCountryPrefix: "+44",
    phoneCountryCode: "GB",
    street1: `SENTINEL-PII-street1-${id}`,
    street2: `SENTINEL-PII-street2-${id}`,
    zip: `SENTINEL-PII-zip-${id}`,
    city: `SENTINEL-PII-city-${id}`,
    hiredDate: "1901-02-03",
    salaryIdentifier: `SENTINEL-PII-salaryIdentifier-${id}`,
    terminationTypeId: 7,
    terminationTypeName: `SENTINEL-PII-terminationTypeName-${id}`,
    deactivationReason: `SENTINEL-PII-REASON-${id}`,
    ssn: `SENTINEL-PII-ssn-${id}`,
    bankAccount: { registrationNumber: "SENTINEL-PII-reg", accountNumber: "SENTINEL-PII-acct" },
    birthDate: "1901-02-03T00:00:00Z",
    employeeTypeId: 3,
    isPublic: true,
    supervisorId: 1009,
    securityGroups: [{ id: 1, name: "SENTINEL-PII-group" }],
    dateTimeCreated: "2020-01-01T00:00:00Z",
    dateTimeModified: "2020-01-02T00:00:00Z",
    dateTimeDeleted: null,
  };
}

/** Strip set E+ (by-id only), custom fields included. */
function stripSetEPlus(id: number): Record<string, unknown> {
  return {
    gender: "Female",
    countryId: 44,
    hiredFrom: "1901-02-03",
    contractRulesRuleId: 12,
    workHours: 160,
    supervisorEmployeeId: 1009,
    skillIds: [1, 2],
    jobTitle: `SENTINEL-PII-jobTitle-${id}`,
    custom_1: { name: "Shoe size", type: "Text", value: `SENTINEL-PII-CUSTOM-${id}`, url: null },
    custom_2: { name: "Photo", type: "Image", value: null, url: "https://example.invalid/p.png" },
  };
}

function rawEmployee(id: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    firstName: "Aisha",
    lastName: "Khan",
    email: "aisha@example.test",
    departments: [101],
    primaryDepartmentId: 101,
    employeeGroups: [201],
    deactivationDate: null,
    ...stripSetE(id),
    ...extra,
  };
}

function rawShift(id: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    departmentId: 101,
    employeeId: 1001,
    employeeGroupId: 201,
    positionId: null,
    shiftTypeId: null,
    date: "2026-10-21",
    comment: `SENTINEL-PII-COMMENT-${id}`,
    timeZone: "Europe/London",
    punchClockShiftId: null,
    startDateTime: "2026-10-21T09:00:00",
    endDateTime: "2026-10-21T17:00:00",
    status: "Assigned",
    dateTimeCreated: "2026-10-01T00:00:00Z",
    dateTimeModified: "2026-10-01T00:00:00Z",
    skillIds: [],
    ...extra,
  };
}

const SENTINEL = /SENTINEL|pii\.invalid|1901-02-03|\+447009|Shoe size|Female|example\.invalid/;

describe("plandayIdSchema", () => {
  it("accepts safe non-negative integers and outputs decimal strings", () => {
    expect(plandayIdSchema.parse(4100001)).toBe("4100001");
    expect(plandayIdSchema.parse(Number.MAX_SAFE_INTEGER)).toBe("9007199254740991");
  });

  it("refuses unsafe integers, fractions, negatives and strings", () => {
    for (const bad of [2 ** 53, Number.MAX_SAFE_INTEGER + 2, 1.5, -1, "1001", null]) {
      expect(plandayIdSchema.safeParse(bad).success, String(bad)).toBe(false);
    }
  });
});

describe("portal info", () => {
  const body = {
    data: {
      id: 4100001,
      name: "Mock Bistro Group",
      companyName: "Mock Bistro Group Ltd",
      country: "GB",
      timeZone: "Europe/London",
      maxDepartments: null,
      aliases: ["mock-bistro"],
      portals: [{ id: 4100002, name: "Mock Cafe Co", aliases: null }],
    },
  };

  it("keeps id, name, time zone and child portal ids only", () => {
    expect(portalInfoResponseSchema.parse(body)).toEqual({
      data: {
        id: "4100001",
        name: "Mock Bistro Group",
        timeZone: "Europe/London",
        portals: [{ id: "4100002" }],
      },
    });
  });

  it("fails without data or id", () => {
    expect(portalInfoResponseSchema.safeParse({ data: null }).success).toBe(false);
    const { id: _id, ...noId } = body.data;
    expect(portalInfoResponseSchema.safeParse({ data: noId }).success).toBe(false);
  });
});

describe("HR schemas", () => {
  it("departments and groups keep id, name (and number)", () => {
    expect(departmentSchema.parse({ id: 101, name: "Bar", number: "B1", extra: "x" })).toEqual({
      id: "101",
      name: "Bar",
      number: "B1",
    });
    expect(employeeGroupSchema.parse({ id: 201, name: "Bartenders", extra: 1 })).toEqual({
      id: "201",
      name: "Bartenders",
    });
    expect(departmentSchema.safeParse({ name: "Bar" }).success).toBe(false);
  });

  it("employees: strip set E never survives the parse", () => {
    const parsed = employeeSchema.parse(rawEmployee(1001));
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "deactivationDate",
        "departments",
        "email",
        "employeeGroups",
        "firstName",
        "id",
        "lastName",
        "primaryDepartmentId",
      ].sort(),
    );
    expect(JSON.stringify(parsed)).not.toMatch(SENTINEL);
  });

  it("employees: optional memberships, null email; malformed records fail", () => {
    expect(
      employeeSchema.parse({ id: 1004, firstName: "Daniel", lastName: "Evans", email: null }),
    ).toMatchObject({ id: "1004", email: null });
    expect(employeeSchema.safeParse(rawEmployee(1001, { firstName: undefined })).success).toBe(
      false,
    );
    expect(employeeSchema.safeParse(rawEmployee(1001, { departments: [2 ** 53] })).success).toBe(
      false,
    );
    expect(
      employeeSchema.safeParse(rawEmployee(1001, { deactivationDate: "next week" })).success,
    ).toBe(false);
  });

  it("deactivated employees keep the id and the deactivation date", () => {
    expect(
      deactivatedEmployeeSchema.parse({ ...rawEmployee(1011), deactivationDate: "2026-10-01" }),
    ).toEqual({ id: "1011", deactivationDate: "2026-10-01" });
  });

  it("by-id reads keep the deactivation evidence only (strip sets E and E+)", () => {
    const body = {
      data: {
        ...rawEmployee(1011),
        ...stripSetEPlus(1011),
        isDeactivated: true,
        deactivationDate: "2026-10-01",
      },
    };
    const parsed = singleResponseSchema(employeeDetailsSchema).parse(body);
    expect(parsed).toEqual({ data: { isDeactivated: true, deactivationDate: "2026-10-01" } });
    expect(JSON.stringify(parsed)).not.toMatch(SENTINEL);
    expect(singleResponseSchema(employeeDetailsSchema).parse({ data: null })).toEqual({
      data: null,
    });
  });
});

describe("Scheduling schemas", () => {
  it("shifts keep the §8 fields and drop comment, position, type and skills", () => {
    const parsed = shiftSchema.parse(rawShift(5001));
    expect(parsed).toEqual({
      id: "5001",
      departmentId: "101",
      employeeId: "1001",
      employeeGroupId: "201",
      date: "2026-10-21",
      startDateTime: "2026-10-21T09:00:00",
      endDateTime: "2026-10-21T17:00:00",
      timeZone: "Europe/London",
      status: "Assigned",
    });
    expect(JSON.stringify(parsed)).not.toMatch(SENTINEL);
  });

  it("an open shift has employeeId null; a missing employeeId or departmentId key fails", () => {
    expect(shiftSchema.parse(rawShift(5002, { employeeId: null, status: "Open" }))).toMatchObject({
      employeeId: null,
      status: "Open",
    });
    const { employeeId: _e, ...noEmployee } = rawShift(5003);
    expect(shiftSchema.safeParse(noEmployee).success).toBe(false);
    const { departmentId: _d, ...noDepartment } = rawShift(5004);
    expect(shiftSchema.safeParse(noDepartment).success).toBe(false);
    const { status: _s, ...noStatus } = rawShift(5005);
    expect(shiftSchema.safeParse(noStatus).success).toBe(false);
  });

  it("unknown status values parse (classification happens later)", () => {
    expect(shiftSchema.parse(rawShift(5006, { status: "SomethingNew" })).status).toBe(
      "SomethingNew",
    );
  });

  it("deleted shifts keep the id and deletion time, never deletedBy", () => {
    expect(
      deletedShiftSchema.parse({
        ...rawShift(5007),
        dateTimeDeleted: "2026-10-20T10:00:00Z",
        deletedBy: 99,
      }),
    ).toEqual({ id: "5007", dateTimeDeleted: "2026-10-20T10:00:00Z" });
  });

  it("schedule days keep date, department and visibility, never the description", () => {
    expect(
      scheduleDaySchema.parse({
        id: 1,
        date: "2026-11-05",
        departmentId: 102,
        isVisible: false,
        title: "t",
        description: "SENTINEL-PII-notes",
        holiday: [],
        lockState: "Unlocked",
      }),
    ).toEqual({ date: "2026-11-05", departmentId: "102", isVisible: false });
    expect(
      scheduleDaySchema.safeParse({ date: "soon", departmentId: 102, isVisible: true }).success,
    ).toBe(false);
  });
});

describe("Punch Clock schemas", () => {
  it("punch records drop the description", () => {
    expect(
      punchClockShiftSchema.parse({
        id: 9001,
        shiftId: 5001,
        departmentId: 101,
        employeeId: 1001,
        startDateTime: "2026-10-21T08:58",
        endDateTime: null,
        shiftStartDateTime: "2026-10-21T09:00",
        shiftEndDateTime: "2026-10-21T17:00",
        description: "SENTINEL-PII-description",
        isApproved: null,
      }),
    ).toEqual({
      id: "9001",
      shiftId: "5001",
      departmentId: "101",
      employeeId: "1001",
      startDateTime: "2026-10-21T08:58",
      endDateTime: null,
      isApproved: null,
    });
    expect(
      punchClockBreakSchema.parse({
        id: 1,
        punchClocksShiftId: 9001,
        startDateTime: "x",
        duration: "00:15:00",
      }),
    ).toEqual({ id: "1", startDateTime: "x" });
  });
});

describe("paged envelope", () => {
  const schema = pagedResponseSchema(departmentSchema);

  it("accepts paging, null paging and missing paging", () => {
    expect(schema.parse({ data: [], paging: { offset: 0, limit: 50, total: 0 } }).paging).toEqual({
      offset: 0,
      limit: 50,
      total: 0,
    });
    expect(schema.parse({ data: [], paging: null }).paging).toBeNull();
    expect(schema.parse({ data: [] }).paging).toBeNull();
    expect(schema.parse({ data: [], paging: { total: 3 } }).paging).toEqual({ total: 3 });
  });

  it("fails on a missing data array or a malformed record", () => {
    expect(schema.safeParse({ paging: null }).success).toBe(false);
    expect(schema.safeParse({ data: [{ id: 101, name: "Bar" }, { name: "no id" }] }).success).toBe(
      false,
    );
    expect(schema.safeParse({ data: [], paging: { offset: 0, limit: 50 } }).success).toBe(false);
  });
});

describe("token responses", () => {
  it("drop id_token and keep the token fields", () => {
    const parsed = codeExchangeResponseSchema.parse({
      id_token: "eyJ.id.token",
      access_token: "eyJ.access",
      expires_in: 3600,
      token_type: "Bearer",
      refresh_token: "VxLtcy_OWkWoPKqs4uFhTg",
      scope: "openid shift:read offline_access",
    });
    expect(parsed).not.toHaveProperty("id_token");
    expect(parsed).toEqual({
      access_token: "eyJ.access",
      expires_in: 3600,
      token_type: "Bearer",
      refresh_token: "VxLtcy_OWkWoPKqs4uFhTg",
      scope: "openid shift:read offline_access",
    });
  });

  it("the refresh grant may omit refresh_token, expires_in and scope; the code exchange may not omit refresh_token", () => {
    expect(tokenResponseSchema.parse({ access_token: "a" })).toEqual({ access_token: "a" });
    expect(codeExchangeResponseSchema.safeParse({ access_token: "a" }).success).toBe(false);
    expect(tokenResponseSchema.safeParse({ refresh_token: "r" }).success).toBe(false);
    expect(tokenResponseSchema.safeParse({ access_token: "" }).success).toBe(false);
  });
});
