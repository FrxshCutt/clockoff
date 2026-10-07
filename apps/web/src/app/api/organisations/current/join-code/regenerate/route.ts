import { emptyBodySchema } from "@clockoff/validation/primitives";
import { createHandler } from "@/server/http/apiHandler";
import { regenerateJoinCode } from "@/server/joinCodes";

/**
 * `POST /api/organisations/current/join-code/regenerate` (org:manage) → `joinCodeResponseSchema`.
 * Revokes the active code and creates a new one; phones that already joined are unaffected.
 */
export const POST = createHandler(
  { auth: "manager", permission: "org:manage", body: emptyBodySchema },
  async ({ ctx }) => regenerateJoinCode(ctx),
);
