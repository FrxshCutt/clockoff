import { emptyBodySchema, idParamsSchema } from "@clockoff/validation/primitives";
import { createHandler } from "@/server/http/apiHandler";
import { archivePolicy } from "@/server/policies/policies.service";

/** `POST /api/policies/:id/archive` (policies:write) → `{ policy }`; `POLICY_ASSIGNED` while in use. */
export const POST = createHandler(
  { auth: "manager", permission: "policies:write", params: idParamsSchema, body: emptyBodySchema },
  async ({ ctx, params }) => ({ policy: await archivePolicy(ctx, params.id) }),
);
