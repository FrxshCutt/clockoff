import { idParamsSchema } from "@clockoff/validation/primitives";
import { getInviteInstructions } from "@/server/employeeInvites";
import { createHandler } from "@/server/http/apiHandler";

/** `GET /api/invites/:id/instructions` (`employees:read`) → `{ instructions }` (copy to share with the employee). */
export const GET = createHandler(
  { auth: "manager", permission: "employees:read", params: idParamsSchema },
  async ({ ctx, params }) => getInviteInstructions(ctx, params.id),
);
