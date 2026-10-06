import { createEmployeeInviteSchema } from "@workmode/validation/invites";
import { idParamsSchema } from "@workmode/validation/primitives";
import { createEmployeeInvite } from "@/server/employeeInvites";
import { createHandler, json } from "@/server/http/apiHandler";
import { RATE_LIMITS } from "@/server/rateLimit";

/**
 * `POST /api/employees/:id/invites` (`employees:write`) `{ channel }` → 201 `{ invite, instructions }`.
 * LINK is SENT immediately; EMAIL is sent to the employee's address; SMS is `COMING_SOON` (501).
 */
export const POST = createHandler(
  {
    auth: "manager",
    permission: "employees:write",
    params: idParamsSchema,
    body: createEmployeeInviteSchema,
    rateLimit: RATE_LIMITS.employeeInvite,
  },
  async ({ ctx, params, body }) => json(await createEmployeeInvite(ctx, params.id, body), 201),
);
