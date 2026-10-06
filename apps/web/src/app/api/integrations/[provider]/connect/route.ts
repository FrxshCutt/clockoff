import { connectIntegrationSchema, integrationParamsSchema } from "@workmode/validation/integrations";
import { createHandler } from "@/server/http/apiHandler";
import { connectIntegration } from "@/server/integrations";

/**
 * `POST /api/integrations/:provider/connect` (integrations:write) → `connectIntegrationResponseSchema`.
 * 501 COMING_SOON while the provider is not available (every provider in the MVP).
 */
export const POST = createHandler(
  {
    auth: "manager",
    permission: "integrations:write",
    params: integrationParamsSchema,
    body: connectIntegrationSchema,
  },
  async ({ ctx, params, body }) => connectIntegration(ctx, params.provider, body),
);
