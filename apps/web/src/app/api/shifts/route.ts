import { createShiftSchema, shiftQuerySchema } from "@workmode/validation/shifts";
import { createHandler, json } from "@/server/http/apiHandler";
import { createShift, listShifts } from "@/server/shifts";

/**
 * `GET /api/shifts?from&to&employeeId&locationId&teamId&status` (`schedule:read`) → `{ shifts }`.
 * `from`/`to` default to the current week in the organisation's timezone; the range is capped at 93 days.
 */
export const GET = createHandler(
  { auth: "manager", permission: "schedule:read", query: shiftQuerySchema },
  async ({ ctx, query }) => listShifts(ctx, query),
);

/**
 * `POST /api/shifts` (`schedule:write`) → 201 `{ shifts, warnings, skippedOccurrences }`. Local-time form
 * (`date`, `startTime`, `endTime`, `timezone?`) or instant form (`startsAt`, `endsAt`); optional
 * `scheduledBreaks`, `recurrence { rule, until }` and `allowOverlap`.
 */
export const POST = createHandler(
  { auth: "manager", permission: "schedule:write", body: createShiftSchema },
  async ({ ctx, body }) => json(await createShift(ctx, body), 201),
);
