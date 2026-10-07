import { emptyBodySchema } from "@clockoff/validation/primitives";
import { createHandler } from "@/server/http/apiHandler";
import { revokeJoinCode } from "@/server/joinCodes";

/** `POST /api/organisations/current/join-code/revoke` (org:manage) → `joinCodeResponseSchema`. Idempotent. */
export const POST = createHandler(
  { auth: "manager", permission: "org:manage", body: emptyBodySchema },
  async ({ ctx }) => revokeJoinCode(ctx),
);
