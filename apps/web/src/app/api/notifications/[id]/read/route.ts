import { emptyBodySchema, idParamsSchema } from "@workmode/validation/primitives";
import { createHandler } from "@/server/http/apiHandler";
import { markNotificationAsRead } from "@/server/notifications";

/** `POST /api/notifications/:id/read` → `{ notification }`. 404 unless the caller is the recipient. */
export const POST = createHandler(
  { auth: "manager", params: idParamsSchema, body: emptyBodySchema },
  async ({ ctx, params }) => ({ notification: await markNotificationAsRead(ctx, params.id) }),
);
