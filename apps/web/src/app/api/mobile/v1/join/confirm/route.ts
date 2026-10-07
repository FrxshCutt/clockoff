import { joinConfirmSchema } from "@clockoff/validation/mobile";
import { createHandler, json } from "@/server/http/apiHandler";
import { confirmJoin } from "@/server/mobileJoin";
import { RATE_LIMITS } from "@/server/rateLimit";

/** `POST /api/mobile/v1/join/confirm` (public) → 201 `{ accessToken, refreshToken, …, deviceId, employee, organisation }`. */
export const POST = createHandler(
  { auth: "public", body: joinConfirmSchema, rateLimit: RATE_LIMITS.mobileJoin },
  async ({ body }) => json(await confirmJoin(body), 201),
);
