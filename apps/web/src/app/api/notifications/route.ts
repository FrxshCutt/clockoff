import { notificationQuerySchema } from "@workmode/validation/notifications";
import { createHandler } from "@/server/http/apiHandler";
import { listNotifications } from "@/server/notifications";

/** `GET /api/notifications?unreadOnly&cursor&limit` → `listNotificationsResponseSchema` `{ items, nextCursor, unreadCount }`. */
export const GET = createHandler(
  { auth: "manager", query: notificationQuerySchema },
  async ({ ctx, query }) => listNotifications(ctx, query),
);
