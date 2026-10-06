import { describe, expect, it } from "vitest";
import {
  bulkShiftActionSchema,
  createShiftSchema,
  duplicateShiftSchema,
  employeeShiftsQuerySchema,
  isInstantShiftInput,
  shiftQuerySchema,
  updateShiftSchema,
} from "./shifts";
import { searchParamsToObject } from "./common";

const employeeId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const shiftId = "9b2f3c4d-1e2f-4a5b-8c6d-7e8f9a0b1c2d";

describe("createShiftSchema", () => {
  it("accepts the local wall-clock form, including overnight shifts", () => {
    const input = createShiftSchema.parse({
      employeeId,
      date: "2026-10-06",
      startTime: "22:00",
      endTime: "06:00",
      timezone: "Europe/London",
      scheduledBreaks: [{ offsetMinutesFromStart: 240, durationMinutes: 30 }],
      recurrence: { rule: "FREQ=WEEKLY;BYDAY=MO,TU", until: "2026-12-31" },
    });
    expect(isInstantShiftInput(input)).toBe(false);
  });

  it("accepts the instant form as an alternative", () => {
    const input = createShiftSchema.parse({
      employeeId,
      startsAt: "2026-10-06T09:00:00Z",
      endsAt: "2026-10-06T17:00:00+00:00",
    });
    expect(isInstantShiftInput(input)).toBe(true);
  });

  it("rejects mixed, incomplete or inverted input", () => {
    expect(
      createShiftSchema.safeParse({
        employeeId,
        date: "2026-10-06",
        startTime: "09:00",
        endTime: "17:00",
        startsAt: "2026-10-06T09:00:00Z",
      }).success,
    ).toBe(false);
    expect(
      createShiftSchema.safeParse({ employeeId, date: "2026-10-06", startTime: "09:00" }).success,
    ).toBe(false);
    expect(
      createShiftSchema.safeParse({
        employeeId,
        startsAt: "2026-10-06T17:00:00Z",
        endsAt: "2026-10-06T09:00:00Z",
      }).success,
    ).toBe(false);
    expect(
      createShiftSchema.safeParse({
        employeeId,
        startsAt: "2026-10-06T09:00:00",
        endsAt: "2026-10-06T17:00:00",
      }).success,
    ).toBe(false);
    expect(
      createShiftSchema.safeParse({
        employeeId,
        date: "2026-02-30",
        startTime: "09:00",
        endTime: "17:00",
      }).success,
    ).toBe(false);
    expect(
      createShiftSchema.safeParse({
        employeeId,
        date: "2026-10-06",
        startTime: "9:00",
        endTime: "17:00",
      }).success,
    ).toBe(false);
    expect(
      createShiftSchema.safeParse({
        employeeId,
        date: "2026-10-06",
        startTime: "09:00",
        endTime: "09:00",
      }).success,
    ).toBe(false);
  });

  it("requires the recurrence end via `until`, not UNTIL/COUNT", () => {
    const base = { employeeId, date: "2026-10-06", startTime: "09:00", endTime: "17:00" };
    expect(
      createShiftSchema.safeParse({
        ...base,
        recurrence: { rule: "FREQ=DAILY;COUNT=5", until: "2026-10-30" },
      }).success,
    ).toBe(false);
    expect(
      createShiftSchema.safeParse({
        ...base,
        recurrence: { rule: "FREQ=HOURLY", until: "2026-10-30" },
      }).success,
    ).toBe(false);
    expect(
      createShiftSchema.safeParse({
        ...base,
        recurrence: { rule: "FREQ=DAILY", until: "2026-10-30" },
      }).success,
    ).toBe(true);
  });
});

describe("updateShiftSchema / duplicate", () => {
  it("does not allow local and instant fields together", () => {
    expect(
      updateShiftSchema.safeParse({ startTime: "10:00", startsAt: "2026-10-06T10:00:00Z" }).success,
    ).toBe(false);
    expect(updateShiftSchema.parse({ notes: "", expectedVersion: 3 })).toEqual({
      notes: null,
      expectedVersion: 3,
    });
  });

  it("duplicates onto a date", () => {
    expect(duplicateShiftSchema.safeParse({ date: "2026-10-07" }).success).toBe(true);
    expect(duplicateShiftSchema.safeParse({ date: "07/10/2026" }).success).toBe(false);
  });
});

describe("shift queries", () => {
  it("parses repeated or comma-separated statuses from a URL", () => {
    const params = new URLSearchParams(
      "from=2026-10-01T00:00:00Z&to=2026-10-08T00:00:00Z&status=SCHEDULED&status=CANCELLED",
    );
    expect(shiftQuerySchema.parse(searchParamsToObject(params)).status).toEqual([
      "SCHEDULED",
      "CANCELLED",
    ]);
    const comma = new URLSearchParams(
      "from=2026-10-01T00:00:00Z&to=2026-10-08T00:00:00Z&status=SCHEDULED,COMPLETED",
    );
    expect(shiftQuerySchema.parse(searchParamsToObject(comma)).status).toEqual([
      "SCHEDULED",
      "COMPLETED",
    ]);
  });

  it("bounds the range to 93 days", () => {
    expect(
      shiftQuerySchema.safeParse({ from: "2026-01-01T00:00:00Z", to: "2026-06-01T00:00:00Z" })
        .success,
    ).toBe(false);
    expect(
      shiftQuerySchema.safeParse({ from: "2026-10-08T00:00:00Z", to: "2026-10-01T00:00:00Z" })
        .success,
    ).toBe(false);
  });

  it("coerces the employee-shifts limit", () => {
    expect(employeeShiftsQuerySchema.parse({ limit: "20" }).limit).toBe(20);
    expect(employeeShiftsQuerySchema.parse({}).limit).toBe(50);
  });
});

describe("bulkShiftActionSchema", () => {
  it("validates each action's payload", () => {
    expect(
      bulkShiftActionSchema.parse({
        action: "MOVE",
        shiftIds: [shiftId],
        payload: { deltaDays: 1 },
      }),
    ).toEqual({
      action: "MOVE",
      shiftIds: [shiftId],
      payload: { deltaDays: 1, deltaMinutes: 0 },
    });
    expect(
      bulkShiftActionSchema.safeParse({
        action: "REPEAT",
        shiftIds: [shiftId],
        payload: { weeks: 13 },
      }).success,
    ).toBe(false);
    expect(bulkShiftActionSchema.safeParse({ action: "CANCEL", shiftIds: [shiftId] }).success).toBe(
      true,
    );
    expect(bulkShiftActionSchema.safeParse({ action: "DELETE", shiftIds: [] }).success).toBe(false);
    expect(
      bulkShiftActionSchema.safeParse({ action: "ARCHIVE", shiftIds: [shiftId] }).success,
    ).toBe(false);
  });
});
