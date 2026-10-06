import { describe, expect, it } from "vitest";
import {
  defaultShiftQuickFormValues,
  isOvernightRange,
  shiftQuickFormSchema,
  toCreateShiftInput,
  todayInZone,
} from "./shift-quick-form-model";

const EMPLOYEE = "6f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a10";
const LOCATION = "7f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a11";

describe("shift quick form", () => {
  it("defaults to today in the organisation's zone with a 09:00–17:00 shift", () => {
    const now = new Date("2026-10-06T20:00:00.000Z"); // 21:00 BST on the 6th; already the 7th in Auckland
    expect(todayInZone(now, "Pacific/Auckland")).toBe("2026-10-07");
    expect(defaultShiftQuickFormValues(now, "Europe/London", LOCATION)).toEqual({
      date: "2026-10-06",
      startTime: "09:00",
      endTime: "17:00",
      locationId: LOCATION,
      notes: "",
    });
  });

  it("validates date/time formats and rejects equal start and end", () => {
    expect(
      shiftQuickFormSchema.safeParse({
        date: "2026-10-06",
        startTime: "09:00",
        endTime: "09:00",
        locationId: "",
        notes: "",
      }).success,
    ).toBe(false);
    expect(
      shiftQuickFormSchema.safeParse({
        date: "06/10/2026",
        startTime: "09:00",
        endTime: "17:00",
        locationId: "",
        notes: "",
      }).success,
    ).toBe(false);
    expect(
      shiftQuickFormSchema.safeParse({
        date: "2026-10-06",
        startTime: "9am",
        endTime: "17:00",
        locationId: "",
        notes: "",
      }).success,
    ).toBe(false);
    expect(
      shiftQuickFormSchema.safeParse({
        date: "2026-10-06",
        startTime: "22:00",
        endTime: "06:00",
        locationId: "",
        notes: "",
      }).success,
    ).toBe(true);
  });

  it("flags overnight ranges", () => {
    expect(isOvernightRange("22:00", "06:00")).toBe(true);
    expect(isOvernightRange("09:00", "17:00")).toBe(false);
    expect(isOvernightRange("09:00", "09:00")).toBe(false);
  });

  it("produces the local-time POST /api/shifts body", () => {
    expect(
      toCreateShiftInput(
        {
          date: "2026-10-06",
          startTime: "09:00",
          endTime: "17:00",
          locationId: LOCATION,
          notes: "  Till 2 ",
        },
        EMPLOYEE,
      ),
    ).toEqual({
      employeeId: EMPLOYEE,
      date: "2026-10-06",
      startTime: "09:00",
      endTime: "17:00",
      locationId: LOCATION,
      notes: "Till 2",
    });
    expect(
      toCreateShiftInput(
        { date: "2026-10-06", startTime: "09:00", endTime: "17:00", locationId: "", notes: "" },
        EMPLOYEE,
      ),
    ).toEqual({
      employeeId: EMPLOYEE,
      date: "2026-10-06",
      startTime: "09:00",
      endTime: "17:00",
    });
  });
});
