import { setDefaultBreakPolicySchema } from "@clockoff/validation/breakPolicies";
import { setDefaultBreakPolicy } from "@/server/breakPolicies/breakPolicies.service";
import { createHandler } from "@/server/http/apiHandler";

/** `POST /api/organisations/current/default-break-policy` (policies:write) `{ breakPolicyId | null }` → `{ organisation }`. */
export const POST = createHandler(
  { auth: "manager", permission: "policies:write", body: setDefaultBreakPolicySchema },
  async ({ ctx, body }) => ({ organisation: await setDefaultBreakPolicy(ctx, body) }),
);
