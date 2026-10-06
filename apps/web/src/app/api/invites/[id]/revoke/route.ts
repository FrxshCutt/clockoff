import { revokeEmployeeInviteSchema } from "@workmode/validation/invites";
import { idParamsSchema } from "@workmode/validation/primitives";
import { revokeEmployeeInvite } from "@/server/employeeInvites";
import { createHandler } from "@/server/http/apiHandler";

/** `POST /api/invites/:id/revoke` (`employees:write`) → `{ invite }`. Idempotent for an already revoked invite. */
export const POST = createHandler(
  {
    auth: "manager",
    permission: "employees:write",
    params: idParamsSchema,
    body: revokeEmployeeInviteSchema,
  },
  async ({ ctx, params }) => revokeEmployeeInvite(ctx, params.id),
);
