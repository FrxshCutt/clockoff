import { describe, expect, it } from "vitest";
import { createTestShiftSchema, TEST_SHIFT_LIMITS, testShiftWindow } from "./testTools";

const employeeId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

describe("createTestShiftSchema", () => {
  it("defaults to a 30-minute shift starting in 20 minutes", () => {
    expect(createTestShiftSchema.parse({ employeeId })).toEqual({
      employeeId,
      startsInMinutes: 20,
      durationMinutes: 30,
    });
    expect(TEST_SHIFT_LIMITS.defaultStartsInMinutes).toBe(20);
    expect(TEST_SHIFT_LIMITS.defaultDurationMinutes).toBe(30);
  });

  it("accepts the bounds: starts in 1–240 minutes, lasts 15–480 minutes", () => {
    for (const startsInMinutes of [1, 240]) {
      for (const durationMinutes of [15, 480]) {
        expect(
          createTestShiftSchema.safeParse({ employeeId, startsInMinutes, durationMinutes }).success,
        ).toBe(true);
      }
    }
  });

  it("rejects shifts shorter than Apple's 15-minute DeviceActivity minimum, with a readable message", () => {
    const result = createTestShiftSchema.safeParse({ employeeId, durationMinutes: 14 });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["durationMinutes"]);
    expect(result.error?.issues[0]?.message).toBe("Apple requires at least 15 minutes");
  });

  it("rejects out-of-range, fractional or non-numeric values", () => {
    for (const body of [
      { employeeId, durationMinutes: 481 },
      { employeeId, startsInMinutes: 0 },
      { employeeId, startsInMinutes: 241 },
      { employeeId, startsInMinutes: 2.5 },
      { employeeId, startsInMinutes: "20" },
      { employeeId: "not-a-uuid" },
      {},
    ]) {
      expect(createTestShiftSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it("never accepts an organisation from the body (strict)", () => {
    expect(
      createTestShiftSchema.safeParse({ employeeId, organisationId: employeeId }).success,
    ).toBe(false);
  });
});

describe("testShiftWindow", () => {
  it("starts N minutes from now and lasts exactly the requested duration", () => {
    const now = new Date("2026-10-07T09:00:00.000Z");
    expect(testShiftWindow({ startsInMinutes: 20, durationMinutes: 30 }, now)).toEqual({
      startsAt: new Date("2026-10-07T09:20:00.000Z"),
      endsAt: new Date("2026-10-07T09:50:00.000Z"),
    });
  });

  it("rounds the start up to the next whole minute, never earlier than asked", () => {
    const now = new Date("2026-10-07T09:00:12.345Z");
    expect(testShiftWindow({ startsInMinutes: 1, durationMinutes: 15 }, now)).toEqual({
      startsAt: new Date("2026-10-07T09:02:00.000Z"),
      endsAt: new Date("2026-10-07T09:17:00.000Z"),
    });
  });
});
