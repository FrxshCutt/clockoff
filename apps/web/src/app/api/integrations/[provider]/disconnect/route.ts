import {
  integrationActionSchema,
  integrationParamsSchema,
} from "@clockoff/validation/integrations";
import { createHandler } from "@/server/http/apiHandler";
import { disconnectIntegration } from "@/server/integrations";

/** `POST /api/integrations/:provider/disconnect` (integrations:write) → `{ integration }`. Idempotent. */
export const POST = createHandler(
  {
    auth: "manager",
    permission: "integrations:write",
    params: integrationParamsSchema,
    body: integrationActionSchema,
  },
  async ({ ctx, params }) => disconnectIntegration(ctx, params.provider),
);
