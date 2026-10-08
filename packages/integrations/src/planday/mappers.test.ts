import { describe, expect, it } from "vitest";
import {
  plandayClockEventExternalId,
  plandayEmployeeExternalId,
  plandayShiftExternalId,
} from "./constants";
import {
  hasValidTimes,
  mapDeactivatedEmployee,
  mapDeletedShift,
  mapDepartment,
  mapEmployee,
  mapEmployeeGroup,
  mapEmployeeStatus,
  mapPortal,
  mapPunchClockBreak,
  mapPunchClockShift,
  mapScheduleDay,
  mapShift,
  toBreakClockEvents,
  toExternalShift,
  toPunchClockEvents,
} from "./mappers";
import {
  deactivatedEmployeeSchema,
  deletedShiftSchema,
  employeeDetailsSchema,
  employeeSchema,
  portalInfoSchema,
  shiftSchema,
} from "./schemas";

const LONDON = "Europe/London";
const SENTINEL = /SENTINEL|pii\.invalid|1901-02-03|\+447009/;

function rawEmployee(id: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    firstName: " Aisha ",
    lastName: "Khan",
    email: " aisha@example.test ",
    departments: [101, 102, 101],
    primaryDepartmentId: 101,
    employeeGroups: [201],
    deactivationDate: null,
    userName: `sentinel-${id}@pii.invalid`,
    cellPhone: `+4470090${id}`,
    street1: `SENTINEL-PII-street1-${id}`,
    ssn: `SENTINEL-PII-ssn-${id}`,
    birthDate: "1901-02-03T00:00:00Z",
    salaryIdentifier: `SENTINEL-PII-salary-${id}`,
    ...extra,
  };
}

function rawShift(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 5001,
    departmentId: 101,
    employeeId: 1001,
    employeeGroupId: 201,
    positionId: null,
    shiftTypeId: null,
    date: "2026-10-21",
    comment: "SENTINEL-PII-COMMENT-5001",
    timeZone: LONDON,
    punchClockShiftId: null,
    startDateTime: "2026-10-21T09:00:00",
    endDateTime: "2026-10-21T17:00:00",
    status: "Assigned",
    dateTimeCreated: null,
    dateTimeModified: null,
    skillIds: [],
    ...extra,
  };
}

describe("allow-list mappers: exactly the spec §8 fields", () => {
  it("portal", () => {
    const portal = mapPortal(
      portalInfoSchema.parse({
        id: 4100001,
        name: "Mock Bistro Group",
        companyName: "Mock Bistro Group Ltd",
        timeZone: "Europe/London",
        portals: [{ id: 4100002, name: "Mock Cafe Co" }],
      }),
    );
    expect(portal).toEqual({
      externalId: "4100001",
      name: "Mock Bistro Group",
      timezone: LONDON,
      reportedTimezone: LONDON,
      childPortalCount: 1,
    });
  });

  it("portal with a Windows zone keeps the reported value but no usable zone", () => {
    const portal = mapPortal(
      portalInfoSchema.parse({ id: 1, name: "P", timeZone: "GMT Standard Time", portals: null }),
    );
    expect(portal).toMatchObject({
      timezone: null,
      reportedTimezone: "GMT Standard Time",
      childPortalCount: 0,
    });
  });

  it("department and group", () => {
    expect(Object.keys(mapDepartment({ id: "101", name: " Bar ", number: " " }))).toEqual([
      "externalId",
      "name",
      "number",
    ]);
    expect(mapDepartment({ id: "101", name: " Bar ", number: " " })).toEqual({
      externalId: "101",
      name: "Bar",
      number: null,
    });
    expect(mapEmployeeGroup({ id: "201", name: "Bartenders" })).toEqual({
      externalId: "201",
      name: "Bartenders",
    });
  });

  it("employee: no phone, job title, user name, address or any strip-set field", () => {
    const employee = mapEmployee(employeeSchema.parse(rawEmployee(1001)), LONDON);
    expect(Object.keys(employee).sort()).toEqual(
      [
        "active",
        "deactivationDate",
        "email",
        "externalId",
        "externalLocationIds",
        "externalTeamIds",
        "firstName",
        "lastName",
        "primaryExternalLocationId",
      ].sort(),
    );
    expect(employee).toEqual({
      externalId: "1001",
      firstName: "Aisha",
      lastName: "Khan",
      email: "aisha@example.test",
      externalLocationIds: ["101", "102"],
      externalTeamIds: ["201"],
      primaryExternalLocationId: "101",
      active: true,
      deactivationDate: null,
    });
    expect(JSON.stringify(employee)).not.toMatch(SENTINEL);
  });

  it("employee without email or memberships; a future dismissal date in the portal zone", () => {
    const employee = mapEmployee(
      employeeSchema.parse({
        id: 1004,
        firstName: "Daniel",
        lastName: "Evans",
        email: "",
        deactivationDate: "2026-11-02",
      }),
      LONDON,
    );
    expect(employee).toMatchObject({
      email: null,
      externalLocationIds: [],
      externalTeamIds: [],
      primaryExternalLocationId: null,
      deactivationDate: new Date("2026-11-02T00:00:00Z"),
    });
  });

  it("deactivated employee and by-id status", () => {
    expect(
      mapDeactivatedEmployee(
        deactivatedEmployeeSchema.parse(rawEmployee(1011, { deactivationDate: "2026-10-01" })),
        LONDON,
      ),
    ).toEqual({ externalId: "1011", deactivationDate: new Date("2026-09-30T23:00:00Z") });
    expect(
      mapEmployeeStatus("1011", employeeDetailsSchema.parse({ isDeactivated: true }), LONDON),
    ).toEqual({
      externalId: "1011",
      isDeactivated: true,
      deactivationDate: null,
    });
    // Only an explicit true is positive evidence.
    expect(
      mapEmployeeStatus("1012", employeeDetailsSchema.parse({ isDeactivated: null }), null)
        .isDeactivated,
    ).toBe(false);
    expect(mapEmployeeStatus("1012", employeeDetailsSchema.parse({}), null).isDeactivated).toBe(
      false,
    );
  });

  it("shift → sink record: start, end, employee, department, zone; never notes or comment", () => {
    const shift = mapShift(shiftSchema.parse(rawShift()), LONDON);
    expect(shift).toMatchObject({
      externalId: "5001",
      externalEmployeeId: "1001",
      externalDepartmentId: "101",
      externalGroupId: "201",
      status: "Assigned",
      date: "2026-10-21",
    });
    expect(hasValidTimes(shift)).toBe(true);
    if (!hasValidTimes(shift)) return;
    const record = toExternalShift(shift);
    expect(Object.keys(record).sort()).toEqual(
      [
        "cancelled",
        "endsAt",
        "externalEmployeeId",
        "externalId",
        "externalLocationId",
        "removalReason",
        "startsAt",
        "timeWarning",
        "timezone",
      ].sort(),
    );
    expect(record).toEqual({
      externalId: "5001",
      externalEmployeeId: "1001",
      externalLocationId: "101",
      startsAt: new Date("2026-10-21T08:00:00Z"),
      endsAt: new Date("2026-10-21T16:00:00Z"),
      timezone: LONDON,
      cancelled: false,
      removalReason: null,
      timeWarning: null,
    });
    expect(JSON.stringify(record)).not.toMatch(SENTINEL);
    expect(toExternalShift(shift, { cancelled: true, removalReason: "DRAFT" })).toMatchObject({
      cancelled: true,
      removalReason: "DRAFT",
    });
  });

  it("shift with unreadable times is kept for the caller to skip; an encoding mismatch fails", () => {
    const bad = mapShift(
      shiftSchema.parse(rawShift({ timeZone: "W. Europe Standard Time" })),
      LONDON,
    );
    expect(bad.times).toEqual({ ok: false, reason: "INVALID_ZONE" });
    expect(hasValidTimes(bad)).toBe(false);
    expect(() =>
      mapShift(
        shiftSchema.parse(
          rawShift({
            date: "2026-10-22",
            startDateTime: "2026-10-21T23:30:00",
            endDateTime: "2026-10-22T07:30:00",
          }),
        ),
        LONDON,
        "/scheduling/v1.0/shifts",
      ),
    ).toThrow(
      expect.objectContaining({
        code: "PLANDAY_INVALID_RESPONSE",
        reason: "TIME_ENCODING_MISMATCH",
      }),
    );
  });

  it("deleted shift, schedule day, punch records", () => {
    expect(
      mapDeletedShift(
        deletedShiftSchema.parse({ id: 5009, dateTimeDeleted: "2026-10-20T10:00:00Z" }),
      ),
    ).toEqual({
      externalId: "5009",
      deletedAt: new Date("2026-10-20T10:00:00Z"),
    });
    expect(mapDeletedShift({ id: "5010", dateTimeDeleted: "garbage" })).toEqual({
      externalId: "5010",
      deletedAt: null,
    });
    expect(mapScheduleDay({ date: "2026-11-05", departmentId: "102", isVisible: null })).toEqual({
      externalDepartmentId: "102",
      date: "2026-11-05",
      isVisible: true,
    });
    expect(
      mapPunchClockShift({
        id: "9001",
        departmentId: "101",
        employeeId: "1001",
        startDateTime: "2026-10-21T08:58",
      }),
    ).toEqual({
      externalId: "9001",
      externalShiftId: null,
      externalDepartmentId: "101",
      externalEmployeeId: "1001",
      startDateTime: "2026-10-21T08:58",
      endDateTime: null,
      isApproved: null,
    });
    expect(mapPunchClockBreak({ id: "7", startDateTime: "2026-10-21T12:00" })).toEqual({
      externalId: "7",
      startDateTime: "2026-10-21T12:00",
      endDateTime: null,
    });
  });
});

describe("portal-qualified external ids (D-050)", () => {
  it("formats employee, shift and clock event ids with the portal id", () => {
    expect(plandayEmployeeExternalId("4100001", "1001")).toBe("PLANDAY:4100001:1001");
    expect(plandayShiftExternalId("4100001", "5001")).toBe("PLANDAY:4100001:5001");
    expect(plandayClockEventExternalId("4100001", "9001", "in")).toBe("4100001:9001:in");
    // Overlapping ids on two portals never collide.
    expect(plandayEmployeeExternalId("4100002", "1001")).not.toBe(
      plandayEmployeeExternalId("4100001", "1001"),
    );
  });

  it("clock events carry portal-qualified ids and resolve wall-clock punches in the given zone", () => {
    const punch = mapPunchClockShift({
      id: "9001",
      shiftId: "5001",
      departmentId: "101",
      employeeId: "1001",
      startDateTime: "2026-10-21T08:58",
      endDateTime: "2026-10-21T17:02",
    });
    expect(toPunchClockEvents(punch, { portalId: "4100001", zone: LONDON })).toEqual([
      {
        externalId: "4100001:9001:in",
        externalEmployeeId: "1001",
        type: "CLOCK_IN",
        occurredAt: new Date("2026-10-21T07:58:00Z"),
      },
      {
        externalId: "4100001:9001:out",
        externalEmployeeId: "1001",
        type: "CLOCK_OUT",
        occurredAt: new Date("2026-10-21T16:02:00Z"),
      },
    ]);
    expect(
      toPunchClockEvents(
        { ...punch, externalEmployeeId: null },
        { portalId: "4100001", zone: LONDON },
      ),
    ).toEqual([]);
    expect(
      toBreakClockEvents(
        { externalId: "77", startDateTime: "2026-10-21T12:00", endDateTime: null },
        { portalId: "4100001", externalEmployeeId: "1001", zone: LONDON },
      ),
    ).toEqual([
      {
        externalId: "4100001:77:start",
        externalEmployeeId: "1001",
        type: "BREAK_START",
        occurredAt: new Date("2026-10-21T11:00:00Z"),
      },
    ]);
  });
});
