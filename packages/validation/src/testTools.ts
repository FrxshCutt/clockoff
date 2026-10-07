import { z } from "zod";
import { uuidSchema } from "./common";
import { shiftSchema, shiftWarningSchema } from "./shifts";

/**
 * Test tools for checking ClockOff on a real phone. Available only when the server runs with
 * `DEV_TOOLS_ENABLED=true` (local development) or the current organisation is listed in
 * `TEST_TOOLS_ORGANISATION_IDS`; everywhere else the endpoints answer 404 and the dashboard hides them.
 * Deliberately not part of the OpenAPI document (like `/api/dev/*`): the iOS client never calls them.
 */

export const TEST_SHIFT_LIMITS = {
  minStartsInMinutes: 1,
  maxStartsInMinutes: 240,
  defaultStartsInMinutes: 20,
  /**
   * Apple's DeviceActivity minimum interval: a schedule shorter than 15 minutes is rejected by
   * `DeviceActivityCenter.startMonitoring`, so a shorter test shift never switches Work Mode on a phone.
   */
  minDurationMinutes: 15,
  maxDurationMinutes: 480,
  defaultDurationMinutes: 30,
} as const;

/** `POST /api/test-tools/test-shift` — a shift for `employeeId` starting `startsInMinutes` from now. */
export const createTestShiftSchema = z
  .object({
    employeeId: uuidSchema,
    startsInMinutes: z
      .int()
      .min(TEST_SHIFT_LIMITS.minStartsInMinutes)
      .max(TEST_SHIFT_LIMITS.maxStartsInMinutes)
      .default(TEST_SHIFT_LIMITS.defaultStartsInMinutes),
    durationMinutes: z
      .int()
      .min(TEST_SHIFT_LIMITS.minDurationMinutes, {
        message: `Apple requires at least ${TEST_SHIFT_LIMITS.minDurationMinutes} minutes`,
      })
      .max(TEST_SHIFT_LIMITS.maxDurationMinutes)
      .default(TEST_SHIFT_LIMITS.defaultDurationMinutes),
  })
  .strict();
export type CreateTestShiftInput = z.infer<typeof createTestShiftSchema>;

export const createTestShiftResponseSchema = z.object({
  shift: shiftSchema,
  /** Same advisories as `POST /api/shifts` (DST normalisation). */
  warnings: z.array(shiftWarningSchema),
});
export type CreateTestShiftResponse = z.infer<typeof createTestShiftResponseSchema>;

const MINUTE_MS = 60_000;

/**
 * The window of a test shift requested at `now`: it starts `startsInMinutes` from now, rounded UP to
 * the next whole minute (never earlier than asked; phone schedules are minute-precise), and lasts
 * exactly `durationMinutes`. Shared by the server and the dashboard's preview.
 */
export function testShiftWindow(
  input: { startsInMinutes: number; durationMinutes: number },
  now: Date,
): { startsAt: Date; endsAt: Date } {
  const start =
    Math.ceil((now.getTime() + input.startsInMinutes * MINUTE_MS) / MINUTE_MS) * MINUTE_MS;
  return {
    startsAt: new Date(start),
    endsAt: new Date(start + input.durationMinutes * MINUTE_MS),
  };
}
