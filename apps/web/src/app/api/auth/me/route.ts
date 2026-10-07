import { ORG_COOKIE } from "@/lib/cookies";
import { getCookie } from "@/lib/request";
import { getCurrentUser } from "@/server/auth/service";
import { createHandler, json } from "@/server/http/apiHandler";

/**
 * `GET /api/auth/me` → `currentUserSchema` (`@clockoff/validation/auth`): the user, their
 * organisations, the selected organisation id and the CSRF token (cookie re-issued when missing).
 * Works for unverified users even when `REQUIRE_EMAIL_VERIFICATION=true`.
 */
export const GET = createHandler({ auth: "user" }, async ({ req, ctx }) => {
  const { body, cookies } = await getCurrentUser(ctx, req, getCookie(req, ORG_COOKIE));
  return json(body, { cookies });
});
