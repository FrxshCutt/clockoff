import { resendEmployeeInviteSchema } from "@clockoff/validation/invites";
import { idParamsSchema } from "@clockoff/validation/primitives";
import { resendEmployeeInvite } from "@/server/employeeInvites";
import { createHandler } from "@/server/http/apiHandler";
import { RATE_LIMITS } from "@/server/rateLimit";

/** `POST /api/invites/:id/resend` (`employees:write`) `{ channel? }` → `{ invite }` with a fresh 14-day expiry. */
export const POST = createHandler(
  {
    auth: "manager",
    permission: "employees:write",
    params: idParamsSchema,
    body: resendEmployeeInviteSchema,
    rateLimit: RATE_LIMITS.employeeInvite,
  },
  async ({ ctx, params, body }) => resendEmployeeInvite(ctx, params.id, body),
);
