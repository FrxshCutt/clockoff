import {
  disconnectIntegrationSchema,
  integrationParamsSchema,
} from "@clockoff/validation/integrations";
import { createHandler } from "@/server/http/apiHandler";
import { disconnectIntegration } from "@/server/integrations";

/**
 * `POST /api/integrations/:provider/disconnect` (integrations:write) `{ mode? }` → `{ integration }`. Idempotent.
 * `mode` (default `KEEP_RECORDS`) is validated here and used by Planday's disconnect (stage 5); the generic
 * providers never synced records, so it changes nothing for them.
 */
export const POST = createHandler(
  {
    auth: "manager",
    permission: "integrations:write",
    params: integrationParamsSchema,
    body: disconnectIntegrationSchema,
  },
  async ({ ctx, params }) => disconnectIntegration(ctx, params.provider),
);
