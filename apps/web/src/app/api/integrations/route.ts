import { createHandler } from "@/server/http/apiHandler";
import { listIntegrations } from "@/server/integrations";

/** `GET /api/integrations` → `listIntegrationsResponseSchema` — one entry per provider, enum order. */
export const GET = createHandler({ auth: "manager" }, async ({ ctx }) => listIntegrations(ctx));
