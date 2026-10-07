import {
  integrationActionSchema,
  integrationParamsSchema,
} from "@clockoff/validation/integrations";
import { createHandler } from "@/server/http/apiHandler";
import { syncIntegration } from "@/server/integrations";

/** `POST /api/integrations/:provider/sync` (integrations:write) → `syncIntegrationResponseSchema`. 501 COMING_SOON for now. */
export const POST = createHandler(
  {
    auth: "manager",
    permission: "integrations:write",
    params: integrationParamsSchema,
    body: integrationActionSchema,
  },
  async ({ ctx, params }) => syncIntegration(ctx, params.provider),
);
