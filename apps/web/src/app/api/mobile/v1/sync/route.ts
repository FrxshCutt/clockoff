import { mobileSyncQuerySchema } from "@workmode/validation/mobile";
import { createHandler } from "@/server/http/apiHandler";
import { getSyncBundle } from "@/server/sync/sync.service";

export const dynamic = "force-dynamic";

/** `GET /api/mobile/v1/sync` (mobile) → the offline bundle (policy, break policy, shifts, overrides, expected state). */
export const GET = createHandler({ auth: "mobile", query: mobileSyncQuerySchema }, async ({ ctx }) =>
  getSyncBundle(ctx),
);
