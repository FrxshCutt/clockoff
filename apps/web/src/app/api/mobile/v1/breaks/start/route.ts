import { mobileStartBreakSchema } from "@clockoff/validation/mobile";
import { startBreakFromDevice } from "@/server/breaks/breaks.service";
import { createHandler, json } from "@/server/http/apiHandler";

export const dynamic = "force-dynamic";

/**
 * `POST /api/mobile/v1/breaks/start` (mobile) → 201 `{ breakSession, allowance }`. Idempotent on
 * `clientBreakId` (a retry returns the recorded session); refusals are the structured break error codes.
 */
export const POST = createHandler(
  { auth: "mobile", body: mobileStartBreakSchema },
  async ({ ctx, body }) => json(await startBreakFromDevice(ctx, body), 201),
);
