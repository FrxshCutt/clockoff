import { setDefaultPolicySchema } from "@workmode/validation/policies";
import { createHandler } from "@/server/http/apiHandler";
import { setDefaultPolicy } from "@/server/policies/policies.service";

/**
 * `POST /api/organisations/current/default-policy` (policies:write) `{ policyId | null }` → `{ organisation }`.
 * The policy must be published (`POLICY_NOT_PUBLISHED`) and not archived (`POLICY_ARCHIVED`).
 */
export const POST = createHandler(
  { auth: "manager", permission: "policies:write", body: setDefaultPolicySchema },
  async ({ ctx, body }) => ({ organisation: await setDefaultPolicy(ctx, body) }),
);
