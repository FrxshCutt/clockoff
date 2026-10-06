import { leaveWorkplaceSchema } from "@workmode/validation/mobile";
import { createHandler } from "@/server/http/apiHandler";
import { leaveWorkplace } from "@/server/mobileJoin";

/** `POST /api/mobile/v1/leave-workplace` (mobile) → `{ ok: true }`. Unlinks, deactivates this device, revokes tokens. */
export const POST = createHandler({ auth: "mobile", body: leaveWorkplaceSchema }, async ({ ctx }) =>
  leaveWorkplace(ctx),
);
