import { AppError } from "@clockoff/shared/errors";
import { createTestShiftSchema } from "@clockoff/validation/testTools";
import type { NextRequest } from "next/server";
import { testToolsConfigured, testToolsEnabledFor } from "@/lib/env";
import { getRequestId } from "@/lib/request";
import { createHandler, errorResponse, json } from "@/server/http/apiHandler";
import { RATE_LIMITS } from "@/server/rateLimit";
import { createTestShift } from "@/server/testTools";

export const dynamic = "force-dynamic";

const handler = createHandler(
  {
    auth: "manager",
    // Same permission as POST /api/shifts.
    permission: "schedule:write",
    available: (ctx) => testToolsEnabledFor(ctx.organisation.id),
    body: createTestShiftSchema,
    rateLimit: RATE_LIMITS.testShift,
  },
  async ({ ctx, body }) => json(await createTestShift(ctx, body), 201),
);

/**
 * `POST /api/test-tools/test-shift` (`schedule:write`) → 201 `{ shift, warnings }`: a shift for
 * `employeeId` starting `startsInMinutes` (1–240, default 20) from now and lasting `durationMinutes`
 * (15–480, default 30; Apple's DeviceActivity needs at least 15), created through the ordinary
 * `createShift` so overlap checks, activity, audit and the phone's re-sync push all apply. The
 * organisation is the manager's current one, never read from the body.
 *
 * Answers 404 `NOT_FOUND` unless `DEV_TOOLS_ENABLED=true` or the current organisation is listed in
 * `TEST_TOOLS_ORGANISATION_IDS`: up front when neither is configured, otherwise after sign-in and the
 * CSRF check but before the permission check and validation. Rate limit `testShift` (30 / hour per IP).
 * Not part of the OpenAPI document.
 */
export async function POST(req: NextRequest, context: unknown): Promise<Response> {
  if (!testToolsConfigured()) {
    return errorResponse(new AppError("NOT_FOUND", "Not found"), getRequestId(req));
  }
  return handler(req, context);
}
