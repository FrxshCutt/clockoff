import { emptyQuerySchema } from "@workmode/validation/primitives";
import { createHandler } from "@/server/http/apiHandler";
import { getMe } from "@/server/sync/sync.service";

export const dynamic = "force-dynamic";

/** `GET /api/mobile/v1/me` (mobile) → the employee, organisation and resolved policies. Strict empty query. */
export const GET = createHandler({ auth: "mobile", query: emptyQuerySchema }, async ({ ctx }) =>
  getMe(ctx),
);
