import { activityQuerySchema } from "@workmode/validation/activity";
import { listActivity } from "@/server/activity/activity.service";
import { createHandler } from "@/server/http/apiHandler";

export const dynamic = "force-dynamic";

/** `GET /api/activity?employeeId&type&from&to&locationId&cursor&limit` (employees:read) → cursor-paginated feed. */
export const GET = createHandler(
  { auth: "manager", permission: "employees:read", query: activityQuerySchema },
  async ({ ctx, query }) => listActivity(ctx, query),
);
