import { AppError } from "@clockoff/shared/errors";
import { CSRF_COOKIE, csrfCookie } from "@/lib/cookies";
import { createCsrfToken, isValidCsrfToken, verifyCsrfPair } from "@/lib/crypto";
import { env } from "@/lib/env";
import { CSRF_HEADER, getCookie, isMutatingMethod } from "@/lib/request";
import { allowedOriginForRequest, readHostRoutingConfig } from "@/server/http/hostRouting";

/**
 * CSRF protection for cookie-authenticated (manager) requests:
 *
 * 1. Origin check — the middleware enforces `Origin === APP_URL` (or same-origin `Sec-Fetch-Site`) for
 *    every non-GET `/api/*` request; this module re-checks a present `Origin` header as defence in depth.
 * 2. Double submit — the `clockoff_csrf` cookie (signed, readable by JS) must be echoed in `x-csrf-token`.
 */

/**
 * Reject a present `Origin` header that is not the app's own origin (including the opaque `null`
 * origin of sandboxed frames and `file:` pages). An absent Origin is left to the middleware, which
 * only accepts it together with `Sec-Fetch-Site: same-origin`.
 */
export function assertAllowedOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  if (origin === null) return;
  // With hostname routing on, the marketing host's own APIs accept its origin (server/http/hostRouting.ts).
  const allowed = allowedOriginForRequest(readHostRoutingConfig(process.env), env().APP_ORIGIN, {
    host: req.headers.get("host"),
    pathname: new URL(req.url).pathname,
  });
  if (origin !== allowed) {
    throw new AppError("CSRF_FAILED", "Request origin is not allowed");
  }
}

export function assertCsrf(req: Request): void {
  if (!isMutatingMethod(req.method)) return;

  assertAllowedOrigin(req);

  const cookie = getCookie(req, CSRF_COOKIE);
  const header = req.headers.get(CSRF_HEADER);
  if (!verifyCsrfPair(cookie, header)) {
    throw new AppError("CSRF_FAILED", "Missing or invalid CSRF token");
  }
}

/**
 * Return the request's CSRF token when the cookie is present and validly signed, otherwise mint a new
 * one and the `Set-Cookie` header that installs it.
 */
export function ensureCsrfToken(req: Request): { token: string; setCookie?: string } {
  const existing = getCookie(req, CSRF_COOKIE);
  if (existing && isValidCsrfToken(existing)) return { token: existing };
  const token = createCsrfToken();
  return { token, setCookie: csrfCookie(token) };
}
