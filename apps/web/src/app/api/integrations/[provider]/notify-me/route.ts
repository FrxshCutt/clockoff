import { integrationActionSchema, integrationParamsSchema } from "@workmode/validation/integrations";
import { createHandler } from "@/server/http/apiHandler";
import { requestIntegrationNotification } from "@/server/integrations";

/** `POST /api/integrations/:provider/notify-me` (any manager) → `{ integration }` with `notifyRequested: true`. */
export const POST = createHandler(
  { auth: "manager", params: integrationParamsSchema, body: integrationActionSchema },
  async ({ ctx, params }) => requestIntegrationNotification(ctx, params.provider),
);
