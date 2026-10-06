import { bulkShiftActionSchema } from "@workmode/validation/shifts";
import { createHandler } from "@/server/http/apiHandler";
import { bulkShiftAction } from "@/server/shifts";

/**
 * `POST /api/shifts/bulk` (`schedule:write`) → `{ action, processed, succeeded, failed, shifts }`.
 * `MOVE { deltaDays, deltaMinutes }`, `REPEAT { weeks }`, `CANCEL { reason? }`, `DELETE`. Per-item
 * failures (NOT_FOUND, SHIFT_OVERLAP, CONFLICT, EMPLOYEE_INACTIVE) never block the other items.
 */
export const POST = createHandler(
  { auth: "manager", permission: "schedule:write", body: bulkShiftActionSchema },
  async ({ ctx, body }) => bulkShiftAction(ctx, body),
);
