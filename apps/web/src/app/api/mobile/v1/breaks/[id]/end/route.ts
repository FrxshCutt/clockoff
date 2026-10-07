import { mobileBreakParamsSchema, mobileEndBreakSchema } from "@clockoff/validation/mobile";
import { endBreakFromDevice } from "@/server/breaks/breaks.service";
import { createHandler } from "@/server/http/apiHandler";

export const dynamic = "force-dynamic";

/** `POST /api/mobile/v1/breaks/:id/end` (mobile) → `{ breakSession, allowance }`; idempotent once ended. */
export const POST = createHandler(
  { auth: "mobile", params: mobileBreakParamsSchema, body: mobileEndBreakSchema },
  async ({ ctx, params, body }) => endBreakFromDevice(ctx, params.id, body),
);
