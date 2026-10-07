import { emptyBodySchema } from "@clockoff/validation/primitives";
import { createHandler } from "@/server/http/apiHandler";
import { markAllNotificationsAsRead } from "@/server/notifications";

/** `POST /api/notifications/read-all` → `{ updated }`. */
export const POST = createHandler({ auth: "manager", body: emptyBodySchema }, async ({ ctx }) =>
  markAllNotificationsAsRead(ctx),
);
