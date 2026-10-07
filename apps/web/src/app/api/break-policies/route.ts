import {
  breakPolicyQuerySchema,
  createBreakPolicySchema,
} from "@clockoff/validation/breakPolicies";
import { createBreakPolicy, listBreakPolicies } from "@/server/breakPolicies/breakPolicies.service";
import { createHandler, json } from "@/server/http/apiHandler";

/** `GET /api/break-policies` (policies:read) `?status=&search=&includeArchived=` → `{ breakPolicies }`. */
export const GET = createHandler(
  { auth: "manager", permission: "policies:read", query: breakPolicyQuerySchema },
  async ({ ctx, query }) => listBreakPolicies(ctx, query),
);

/** `POST /api/break-policies` (policies:write) → 201 `{ breakPolicy }`. */
export const POST = createHandler(
  { auth: "manager", permission: "policies:write", body: createBreakPolicySchema },
  async ({ ctx, body }) => json({ breakPolicy: await createBreakPolicy(ctx, body) }, 201),
);
