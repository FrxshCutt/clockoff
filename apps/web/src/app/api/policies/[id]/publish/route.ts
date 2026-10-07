import { idParamsSchema } from "@clockoff/validation/primitives";
import { publishPolicySchema } from "@clockoff/validation/policies";
import { createHandler } from "@/server/http/apiHandler";
import { publishPolicy } from "@/server/policies/policies.service";

/** `POST /api/policies/:id/publish` (policies:write) `{ changeNote? }` → `{ policy }`. */
export const POST = createHandler(
  {
    auth: "manager",
    permission: "policies:write",
    params: idParamsSchema,
    body: publishPolicySchema,
  },
  async ({ ctx, params, body }) => ({ policy: await publishPolicy(ctx, params.id, body) }),
);
