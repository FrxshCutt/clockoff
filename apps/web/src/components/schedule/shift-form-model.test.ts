import type { Shift } from "@clockoff/validation/shifts";
import { describe, expect, it } from "vitest";
import {
  daysBetweenLocalDates,
  emptyShiftForm,
  formTimezone,
  previewShiftTimes,
  readOverlapConflictIds,
  readResponseWarnings,
  resolveConflicts,
  shiftFormSchema,
  shiftToFormValues,
  toCreateShiftInput,
  toUpdateShiftInput,
  type ShiftFormValues,
} from "./shift-form-model";

const EMPLOYEE = "6f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a10";
const LOCATION = "7f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a11";
const LONDON = "Europe/London";

const base: ShiftFormValues = {
  ...emptyShiftForm({ employeeId: EMPLOYEE, locationId: LOCATION, date: "2026-10-06" }),
};

const shift: Shift = {
  id: "00000000-0000-4000-8000-000000000001",
  employee: {
    id: EMPLOYEE,
    firstName: "Jane",
    lastName: "Smith",
    jobTitle: null,
    primaryLocation: null,
    inviteStatus: "CONNECTED",
  },
  location: { id: LOCATION, name: "High Street" },
  startsAt: "2026-10-06T21:00:00.000Z",
  endsAt: "2026-10-07T05:00:00.000Z",
  timezone: LONDON,
  durationMinutes: 480,
  status: "SCHEDULED",
  source: "MANUAL",
  externalShiftId: null,
  notes: "Lock up",
  recurrenceRule: "FREQ=WEEKLY;BYDAY=TU",
  parentRecurrenceId: null,
  version: 4,
  scheduledBreaks: [
    {
      id: "00000000-0000-4000-8000-000000000002",
      offsetMinutesFromStart: 240,
      durationMinutes: 30,
    },
  ],
  isOvernight: true,
  localDate: "2026-10-06",
  localStartTime: "22:00",
  localEndTime: "06:00",
  displayRange: "Tue 6 Oct, 22:00–06:00 (+1)",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

describe("shiftFormSchema", () => {
  it("accepts a plain shift and an overnight one, rejecting equal times", () => {
    expect(shiftFormSchema.safeParse(base).success).toBe(true);
    expect(
      shiftFormSchema.safeParse({ ...base, startTime: "22:00", endTime: "06:00" }).success,
    ).toBe(true);
    const equal = shiftFormSchema.safeParse({ ...base, startTime: "09:00", endTime: "09:00" });
    expect(equal.success).toBe(false);
    if (!equal.success) expect(equal.error.issues[0]?.path).toEqual(["endTime"]);
  });

  it("requires an employee, a valid date and HH:mm times", () => {
    expect(shiftFormSchema.safeParse({ ...base, employeeId: "" }).success).toBe(false);
    expect(shiftFormSchema.safeParse({ ...base, date: "06/10/2026" }).success).toBe(false);
    expect(shiftFormSchema.safeParse({ ...base, startTime: "9am" }).success).toBe(false);
    expect(shiftFormSchema.safeParse({ ...base, notes: "x".repeat(1001) }).success).toBe(false);
  });

  it("validates the recurrence controls only when repeating", () => {
    expect(shiftFormSchema.safeParse({ ...base, repeat: "none", until: "" }).success).toBe(true);
    const noUntil = shiftFormSchema.safeParse({ ...base, repeat: "daily", until: "" });
    expect(noUntil.success).toBe(false);
    if (!noUntil.success)
      expect(noUntil.error.issues.map((i) => i.path.join("."))).toContain("until");
    expect(
      shiftFormSchema.safeParse({ ...base, repeat: "daily", until: "2026-10-06" }).success,
    ).toBe(false); // must end after the first shift
    expect(
      shiftFormSchema.safeParse({ ...base, repeat: "daily", until: "2026-10-20" }).success,
    ).toBe(true);
    const noWeekdays = shiftFormSchema.safeParse({
      ...base,
      repeat: "weekly",
      weekdays: [],
      until: "2026-10-20",
    });
    expect(noWeekdays.success).toBe(false);
    if (!noWeekdays.success)
      expect(noWeekdays.error.issues.map((i) => i.path.join("."))).toContain("weekdays");
    const badCustom = shiftFormSchema.safeParse({
      ...base,
      repeat: "custom",
      customRule: "FREQ=DAILY;COUNT=3",
      until: "2026-10-20",
    });
    expect(badCustom.success).toBe(false);
    if (!badCustom.success)
      expect(badCustom.error.issues.map((i) => i.path.join("."))).toContain("customRule");
  });

  it("validates break minutes as whole numbers within limits", () => {
    expect(
      shiftFormSchema.safeParse({
        ...base,
        scheduledBreaks: [{ offsetMinutesFromStart: "240", durationMinutes: "30" }],
      }).success,
    ).toBe(true);
    expect(
      shiftFormSchema.safeParse({
        ...base,
        scheduledBreaks: [{ offsetMinutesFromStart: "abc", durationMinutes: "30" }],
      }).success,
    ).toBe(false);
    expect(
      shiftFormSchema.safeParse({
        ...base,
        scheduledBreaks: [{ offsetMinutesFromStart: "240", durationMinutes: "0" }],
      }).success,
    ).toBe(false);
    expect(
      shiftFormSchema.safeParse({
        ...base,
        scheduledBreaks: [{ offsetMinutesFromStart: "240", durationMinutes: "500" }],
      }).success,
    ).toBe(false);
  });
});

describe("request bodies", () => {
  it("builds the minimal local-time create body", () => {
    expect(toCreateShiftInput({ ...base, locationId: "", notes: "  " })).toEqual({
      employeeId: EMPLOYEE,
      date: "2026-10-06",
      startTime: "09:00",
      endTime: "17:00",
    });
  });

  it("includes location, notes, breaks, recurrence and the overlap override", () => {
    const values: ShiftFormValues = {
      ...base,
      notes: " Till 2 ",
      scheduledBreaks: [{ offsetMinutesFromStart: "240", durationMinutes: "30" }],
      repeat: "weekly",
      weekdays: ["WE", "MO"],
      until: "2026-12-18",
    };
    expect(toCreateShiftInput(values, { allowOverlap: true })).toEqual({
      employeeId: EMPLOYEE,
      date: "2026-10-06",
      startTime: "09:00",
      endTime: "17:00",
      allowOverlap: true,
      locationId: LOCATION,
      notes: "Till 2",
      scheduledBreaks: [{ offsetMinutesFromStart: 240, durationMinutes: 30 }],
      recurrence: { rule: "FREQ=WEEKLY;BYDAY=MO,WE", until: "2026-12-18" },
    });
  });

  it("builds the PATCH body with the shift's own timezone, version and series scope", () => {
    const values = shiftToFormValues(shift);
    expect(values).toMatchObject({
      employeeId: EMPLOYEE,
      locationId: LOCATION,
      date: "2026-10-06",
      startTime: "22:00",
      endTime: "06:00",
      notes: "Lock up",
      repeat: "none",
      weekdays: [],
      customRule: "",
      until: "",
    });
    expect(values.scheduledBreaks).toEqual([
      { offsetMinutesFromStart: "240", durationMinutes: "30" },
    ]);
    // Recurrence is not editable through PATCH; the edit form of a series anchor must still validate
    // (pre-filling "repeat" used to demand the never-rendered "until" field and silently block saving).
    expect(
      shiftFormSchema.safeParse(
        shiftToFormValues({ ...shift, recurrenceRule: "FREQ=WEEKLY;BYDAY=TU" }),
      ).success,
    ).toBe(true);
    expect(
      shiftFormSchema.safeParse(
        shiftToFormValues({ ...shift, recurrenceRule: null, parentRecurrenceId: EMPLOYEE }),
      ).success,
    ).toBe(true);
    expect(toUpdateShiftInput({ ...values, locationId: "", notes: "" }, shift)).toEqual({
      locationId: null,
      date: "2026-10-06",
      startTime: "22:00",
      endTime: "06:00",
      timezone: LONDON,
      notes: null,
      scheduledBreaks: [{ offsetMinutesFromStart: 240, durationMinutes: 30 }],
      expectedVersion: 4,
    });
    expect(
      toUpdateShiftInput(values, shift, { applyTo: "THIS_AND_FUTURE", allowOverlap: true }),
    ).toMatchObject({ applyTo: "THIS_AND_FUTURE", allowOverlap: true, notes: "Lock up" });
    expect(toUpdateShiftInput(values, shift, { applyTo: "THIS" })).not.toHaveProperty("applyTo");
  });
});

describe("time preview", () => {
  it("detects overnight shifts and computes the elapsed length", () => {
    expect(
      previewShiftTimes({ date: "2026-10-06", startTime: "22:00", endTime: "06:00" }, LONDON),
    ).toMatchObject({ overnight: true, durationMinutes: 480, tooShort: false, warnings: [] });
    expect(
      previewShiftTimes({ date: "2026-10-06", startTime: "09:00", endTime: "09:10" }, LONDON),
    ).toMatchObject({ overnight: false, durationMinutes: 10, tooShort: true });
  });

  it("reports DST adjustments on clock-change nights", () => {
    const forward = previewShiftTimes(
      { date: "2026-03-29", startTime: "01:30", endTime: "05:00" },
      LONDON,
    );
    expect(forward.warnings).toEqual(["START_NONEXISTENT_LOCAL_TIME_SHIFTED"]);
    const back = previewShiftTimes(
      { date: "2026-10-24", startTime: "22:00", endTime: "06:00" },
      LONDON,
    );
    expect(back.durationMinutes).toBe(540);
    const ambiguous = previewShiftTimes(
      { date: "2026-10-25", startTime: "01:30", endTime: "05:00" },
      LONDON,
    );
    expect(ambiguous.warnings).toEqual(["START_AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE"]);
  });

  it("stays quiet for incomplete input", () => {
    expect(
      previewShiftTimes({ date: "", startTime: "09:00", endTime: "17:00" }, LONDON),
    ).toMatchObject({ durationMinutes: null, warnings: [] });
    expect(
      previewShiftTimes({ date: "2026-10-06", startTime: "09:00", endTime: "17:00" }, "Not/AZone"),
    ).toMatchObject({ durationMinutes: null });
  });

  it("resolves the entry timezone from the location, falling back to the organisation", () => {
    const locations = [
      { id: LOCATION, timezone: "America/New_York" },
      { id: "7f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a99", timezone: null },
    ];
    expect(formTimezone(LOCATION, locations, LONDON)).toBe("America/New_York");
    expect(formTimezone("7f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a99", locations, LONDON)).toBe(LONDON);
    expect(formTimezone("", locations, LONDON)).toBe(LONDON);
  });
});

describe("API error helpers", () => {
  it("reads overlap conflict ids and resolves them against loaded shifts", () => {
    const other = "00000000-0000-4000-8000-000000000009";
    expect(readOverlapConflictIds({ conflictingShiftIds: [shift.id, other] })).toEqual([
      shift.id,
      other,
    ]);
    expect(readOverlapConflictIds({ nope: true })).toEqual([]);
    expect(readOverlapConflictIds(undefined)).toEqual([]);
    expect(resolveConflicts([shift.id, other], [shift])).toEqual([
      { id: shift.id, shift },
      { id: other, shift: null },
    ]);
  });

  it("reads response warnings in either shape", () => {
    expect(
      readResponseWarnings({ warnings: [{ code: "X", message: "Start moved" }, "plain"] }),
    ).toEqual(["Start moved", "plain"]);
    expect(readResponseWarnings({ warnings: "no" })).toEqual([]);
    expect(readResponseWarnings(null)).toEqual([]);
  });

  it("counts days between local dates", () => {
    expect(daysBetweenLocalDates("2026-10-06", "2026-10-09")).toBe(3);
    expect(daysBetweenLocalDates("2026-11-01", "2026-10-31")).toBe(-1);
  });
});
