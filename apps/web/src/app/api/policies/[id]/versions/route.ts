import { idParamsSchema } from "@workmode/validation/primitives";
import { createHandler } from "@/server/http/apiHandler";
import { listPolicyVersions } from "@/server/policies/policies.service";

/** `GET /api/policies/:id/versions` (policies:read) → `{ versions }` newest first. */
export const GET = createHandler(
  { auth: "manager", permission: "policies:read", params: idParamsSchema },
  async ({ ctx, params }) => ({ versions: await listPolicyVersions(ctx, params.id) }),
);
