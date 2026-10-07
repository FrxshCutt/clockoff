import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEST_SHIFT_VALUES,
  TEST_SHIFT_COPY,
  buildTestShiftInput,
  previewTestShift,
  testShiftSuccessDescription,
} from "./test-shift-model";

const employeeId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

describe("buildTestShiftInput", () => {
  it("defaults to a 30-minute shift starting in 20 minutes", () => {
    expect(DEFAULT_TEST_SHIFT_VALUES).toEqual({ startsIn: "20", duration: "30" });
    expect(buildTestShiftInput({ employeeId, ...DEFAULT_TEST_SHIFT_VALUES })).toEqual({
      ok: true,
      input: { employeeId, startsInMinutes: 20, durationMinutes: 30 },
    });
  });

  it("asks for an employee first", () => {
    expect(buildTestShiftInput({ employeeId: null, ...DEFAULT_TEST_SHIFT_VALUES })).toMatchObject({
      ok: false,
      field: "employee",
    });
  });

  it("explains Apple's 15-minute minimum for short shifts", () => {
    expect(buildTestShiftInput({ employeeId, startsIn: "5", duration: "14" })).toEqual({
      ok: false,
      field: "duration",
      message: "Apple requires at least 15 minutes.",
    });
    expect(buildTestShiftInput({ employeeId, startsIn: "5", duration: "15" }).ok).toBe(true);
  });

  it("rejects starts outside 1–240 minutes and durations above 480 or not whole", () => {
    for (const startsIn of ["0", "241", "", "1.5", "-3", "abc"]) {
      expect(buildTestShiftInput({ employeeId, startsIn, duration: "30" }), startsIn).toMatchObject(
        { ok: false, field: "startsIn" },
      );
    }
    for (const duration of ["481", "", "20.5"]) {
      expect(buildTestShiftInput({ employeeId, startsIn: "20", duration }), duration).toMatchObject(
        { ok: false, field: "duration" },
      );
    }
    expect(buildTestShiftInput({ employeeId, startsIn: " 240 ", duration: "480" }).ok).toBe(true);
  });
});

describe("previewTestShift", () => {
  it("shows the window the server will create (start rounded up to the minute)", () => {
    const now = new Date("2026-10-07T09:00:30.000Z");
    expect(previewTestShift(DEFAULT_TEST_SHIFT_VALUES, now)).toEqual({
      startsAt: new Date("2026-10-07T09:21:00.000Z"),
      endsAt: new Date("2026-10-07T09:51:00.000Z"),
    });
    expect(previewTestShift({ startsIn: "20", duration: "10" }, now)).toBeNull();
  });
});

describe("copy", () => {
  it("keeps the labels the device-testing guide quotes", () => {
    expect(TEST_SHIFT_COPY.action).toBe("Create test shift…");
    expect(TEST_SHIFT_COPY.startsInLabel).toBe("Starts in (minutes)");
    expect(TEST_SHIFT_COPY.durationLabel).toBe("Lasts (minutes)");
    expect(TEST_SHIFT_COPY.note).toBe(
      "Apple requires at least 15 minutes; leave time for the phone to sync before it starts.",
    );
    expect(testShiftSuccessDescription("Zach Stephens", "Wed 7 Oct, 10:20–10:50")).toBe(
      "Zach Stephens, Wed 7 Oct, 10:20–10:50. Sync ClockOff on the phone before it starts.",
    );
  });
});
