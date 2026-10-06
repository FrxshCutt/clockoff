import { idParamsSchema } from "@workmode/validation/primitives";
import { duplicatePolicySchema } from "@workmode/validation/policies";
import { createHandler, json } from "@/server/http/apiHandler";
import { duplicatePolicy } from "@/server/policies/policies.service";

/** `POST /api/policies/:id/duplicate` (policies:write) `{ name? }` → 201 `{ policy }` (new DRAFT). */
export const POST = createHandler(
  {
    auth: "manager",
    permission: "policies:write",
    params: idParamsSchema,
    body: duplicatePolicySchema,
  },
  async ({ ctx, params, body }) =>
    json({ policy: await duplicatePolicy(ctx, params.id, body) }, 201),
);
