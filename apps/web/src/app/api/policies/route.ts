import { createPolicySchema, policyQuerySchema } from "@clockoff/validation/policies";
import { createHandler, json } from "@/server/http/apiHandler";
import { createPolicy, listPolicies } from "@/server/policies/policies.service";

/** `GET /api/policies` (policies:read) `?status=&search=&includeArchived=` → `{ policies }`. */
export const GET = createHandler(
  { auth: "manager", permission: "policies:read", query: policyQuerySchema },
  async ({ ctx, query }) => listPolicies(ctx, query),
);

/** `POST /api/policies` (policies:write) → 201 `{ policy }` (DRAFT with draft version 1). */
export const POST = createHandler(
  { auth: "manager", permission: "policies:write", body: createPolicySchema },
  async ({ ctx, body }) => json({ policy: await createPolicy(ctx, body) }, 201),
);
