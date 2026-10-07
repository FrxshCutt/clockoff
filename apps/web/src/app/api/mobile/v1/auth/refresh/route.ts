import { mobileRefreshSchema } from "@clockoff/validation/mobile";
import { createHandler } from "@/server/http/apiHandler";
import { refreshMobileTokens } from "@/server/mobileJoin";
import { RATE_LIMITS } from "@/server/rateLimit";

/** `POST /api/mobile/v1/auth/refresh` (public, rate limited) `{ refreshToken }` → `mobileTokensSchema`. */
export const POST = createHandler(
  { auth: "public", body: mobileRefreshSchema, rateLimit: RATE_LIMITS.mobileRefresh },
  async ({ body }) => refreshMobileTokens(body),
);
