import {
  testShiftWindow,
  type CreateTestShiftInput,
  type CreateTestShiftResponse,
} from "@clockoff/validation/testTools";
import { createShift } from "@/server/shifts";
import type { ManagerContext } from "@/server/tenancy/context";

/** Notes stored on every test shift, so managers can tell it apart on the schedule. */
export const TEST_SHIFT_NOTES = "Test shift for phone testing (Create test shift…)";

/**
 * `POST /api/test-tools/test-shift`: a one-off shift for `input.employeeId` starting
 * `startsInMinutes` from now. Goes through the ordinary {@link createShift} (instant form) so the
 * tenant check (EMPLOYEE_NOT_FOUND for another organisation's employee), the active-employee and
 * overlap checks, the activity event, the audit entry and the SCHEDULE_CHANGED push that makes the
 * phone re-sync all apply exactly as for a shift added on the schedule. Source MANUAL, organisation
 * timezone, no location. Availability (DEV_TOOLS_ENABLED / TEST_TOOLS_ORGANISATION_IDS) is enforced
 * by the route.
 */
export async function createTestShift(
  ctx: ManagerContext,
  input: CreateTestShiftInput,
  now: Date = new Date(),
): Promise<CreateTestShiftResponse> {
  const { startsAt, endsAt } = testShiftWindow(input, now);
  const created = await createShift(ctx, {
    employeeId: input.employeeId,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    notes: TEST_SHIFT_NOTES,
  });
  return { shift: created.shifts[0]!, warnings: created.warnings };
}
