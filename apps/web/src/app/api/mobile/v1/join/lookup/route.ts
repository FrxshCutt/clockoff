import { joinLookupSchema } from "@workmode/validation/mobile";
import { createHandler } from "@/server/http/apiHandler";
import { lookupJoin } from "@/server/mobileJoin";
import { RATE_LIMITS } from "@/server/rateLimit";

/**
 * `POST /api/mobile/v1/join/lookup` (public). Per-IP limit here; the service adds a per-company-code limit.
 * → `{ organisation: { name }, match: SINGLE | NONE | AMBIGUOUS, employeePreview }`.
 */
export const POST = createHandler(
  { auth: "public", body: joinLookupSchema, rateLimit: RATE_LIMITS.mobileJoin },
  async ({ body }) => lookupJoin(body),
);
