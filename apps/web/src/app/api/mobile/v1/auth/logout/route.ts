import { mobileLogoutSchema } from "@clockoff/validation/mobile";
import { createHandler } from "@/server/http/apiHandler";
import { logoutDevice } from "@/server/mobileJoin";

/** `POST /api/mobile/v1/auth/logout` (mobile) `{ refreshToken? }` → 204. The device stays linked. */
export const POST = createHandler(
  { auth: "mobile", body: mobileLogoutSchema },
  async ({ ctx, body }) => {
    await logoutDevice(ctx, body);
  },
);
