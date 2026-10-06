import { idParamsSchema } from "@workmode/validation/primitives";
import { createPolicyAssignmentSchema } from "@workmode/validation/policies";
import { createHandler, json } from "@/server/http/apiHandler";
import {
  createPolicyAssignment,
  listPolicyAssignments,
} from "@/server/policies/policies.service";

/** `GET /api/policies/:id/assignments` (policies:read) → `{ assignments }`. */
export const GET = createHandler(
  { auth: "manager", permission: "policies:read", params: idParamsSchema },
  async ({ ctx, params }) => ({ assignments: await listPolicyAssignments(ctx, params.id) }),
);

/**
 * `POST /api/policies/:id/assignments` (policies:write) `{ scopeType, scopeId, effectiveFrom?, effectiveTo? }`
 * → 201 `{ assignment }`. Replaces the scope's open assignment; `POLICY_NOT_PUBLISHED` for drafts.
 */
export const POST = createHandler(
  {
    auth: "manager",
    permission: "policies:write",
    params: idParamsSchema,
    body: createPolicyAssignmentSchema,
  },
  async ({ ctx, params, body }) =>
    json({ assignment: await createPolicyAssignment(ctx, params.id, body) }, 201),
);
