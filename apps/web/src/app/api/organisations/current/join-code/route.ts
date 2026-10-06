import { createHandler } from "@/server/http/apiHandler";
import { getJoinCodes } from "@/server/joinCodes";

/** `GET /api/organisations/current/join-code` (employees:read) → `joinCodeResponseSchema` `{ current, history }`. */
export const GET = createHandler(
  { auth: "manager", permission: "employees:read" },
  async ({ ctx }) => getJoinCodes(ctx),
);
