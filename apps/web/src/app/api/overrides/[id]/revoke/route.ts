import { revokeOverrideSchema } from "@workmode/validation/overrides";
import { idParamsSchema } from "@workmode/validation/primitives";
import { createHandler } from "@/server/http/apiHandler";
import { revokeOverride } from "@/server/overrides/overrides.service";

export const dynamic = "force-dynamic";

/** `POST /api/overrides/:id/revoke` (overrides:create) → `{ override }`; OVERRIDE_EXPIRED once past expiry. */
export const POST = createHandler(
  {
    auth: "manager",
    permission: "overrides:create",
    params: idParamsSchema,
    body: revokeOverrideSchema,
  },
  async ({ ctx, params, body }) => ({ override: await revokeOverride(ctx, params.id, body) }),
);
