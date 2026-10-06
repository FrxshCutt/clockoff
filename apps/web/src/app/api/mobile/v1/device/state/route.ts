import { deviceStateReportSchema } from "@workmode/validation/mobile";
import { reportDeviceState } from "@/server/deviceState/deviceState.service";
import { createHandler } from "@/server/http/apiHandler";

export const dynamic = "force-dynamic";

/** `POST /api/mobile/v1/device/state` (mobile) → `{ ok, serverTime, clockSkewSeconds, expectedState }`. */
export const POST = createHandler(
  { auth: "mobile", body: deviceStateReportSchema },
  async ({ ctx, body }) => reportDeviceState(ctx, body),
);
