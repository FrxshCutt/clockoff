import { SESSION_COOKIE } from "@/lib/cookies";
import { getCookie } from "@/lib/request";
import { logoutManager } from "@/server/auth/service";
import { createHandler, json } from "@/server/http/apiHandler";

/**
 * `POST /api/auth/logout` → `{ ok: true }`, revokes the session and clears every auth cookie. Works
 * with an expired session (no authentication required) but still demands the CSRF double-submit so a
 * third-party page cannot sign the manager out.
 */
export const POST = createHandler({ auth: "public", csrf: true }, async ({ req }) => {
  const cookies = await logoutManager(getCookie(req, SESSION_COOKIE));
  return json({ ok: true }, { cookies });
});
