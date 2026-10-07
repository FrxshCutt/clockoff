import { idParamsSchema } from "@clockoff/validation/primitives";
import { createBreakPolicyAssignmentSchema } from "@clockoff/validation/breakPolicies";
import {
  createBreakPolicyAssignment,
  listBreakPolicyAssignments,
} from "@/server/breakPolicies/breakPolicies.service";
import { createHandler, json } from "@/server/http/apiHandler";

/** `GET /api/break-policies/:id/assignments` (policies:read) → `{ assignments }`. */
export const GET = createHandler(
  { auth: "manager", permission: "policies:read", params: idParamsSchema },
  async ({ ctx, params }) => ({ assignments: await listBreakPolicyAssignments(ctx, params.id) }),
);

/** `POST /api/break-policies/:id/assignments` (policies:write) → 201 `{ assignment }`. */
export const POST = createHandler(
  {
    auth: "manager",
    permission: "policies:write",
    params: idParamsSchema,
    body: createBreakPolicyAssignmentSchema,
  },
  async ({ ctx, params, body }) =>
    json({ assignment: await createBreakPolicyAssignment(ctx, params.id, body) }, 201),
);
