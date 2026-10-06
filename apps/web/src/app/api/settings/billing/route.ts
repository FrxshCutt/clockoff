import { createHandler } from "@/server/http/apiHandler";
import { getBilling } from "@/server/settings";

/** `GET /api/settings/billing` → `billingResponseSchema` (plan, limits, usage, catalogue). Read-only. */
export const GET = createHandler({ auth: "manager" }, async ({ ctx }) => getBilling(ctx));
