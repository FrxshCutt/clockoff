import { mobileScheduleQuerySchema } from "@workmode/validation/mobile";
import { createHandler } from "@/server/http/apiHandler";
import { getSchedule } from "@/server/sync/sync.service";

export const dynamic = "force-dynamic";

/** `GET /api/mobile/v1/schedule?from&to` (mobile) → this employee's SCHEDULED shifts (default −1 d … +14 d). */
export const GET = createHandler(
  { auth: "mobile", query: mobileScheduleQuerySchema },
  async ({ ctx, query }) => getSchedule(ctx, query),
);
