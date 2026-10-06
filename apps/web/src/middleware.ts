import { NextResponse, type NextRequest } from "next/server";
import { checkRequestOrigin } from "@/server/http/originCheck";
import { applySecurityHeaders } from "@/server/http/securityHeaders";

/**
 * Edge middleware (§13). For every matched request it:
 * 1. assigns an `x-request-id` (kept when the caller sent a well-formed one) and forwards it to the
 *    route handler so logs and responses correlate;
 * 2. rejects cross-origin mutating `/api/*` calls (CSRF layer 1): `Origin` must equal the `APP_URL`
 *    origin, or be absent with `Sec-Fetch-Site: same-origin`. `/api/mobile/**` and `/api/jobs/**` are
 *    exempt (bearer-token clients, not browsers). The double-submit token (layer 2) is checked by the
 *    handler wrapper;
 * 3. sets security headers (CSP, HSTS in production, X-Frame-Options, nosniff, Referrer-Policy,
 *    Permissions-Policy) on the response.
 *
 * Edge runtime: no Node APIs and no `env()` (secrets are not needed here); `APP_URL` is read directly.
 */

const REQUEST_ID_HEADER = "x-request-id";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

function resolveRequestId(req: NextRequest): string {
  const incoming = req.headers.get(REQUEST_ID_HEADER);
  return incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID();
}

function allowedOrigin(): string | null {
  const configured = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  if (!configured) return null;
  try {
    return new URL(configured).origin;
  } catch {
    return null;
  }
}

function finalise(response: NextResponse, requestId: string): NextResponse {
  response.headers.set(REQUEST_ID_HEADER, requestId);
  applySecurityHeaders(response.headers, { isProduction: process.env.NODE_ENV === "production" });
  return response;
}

export function middleware(req: NextRequest): NextResponse {
  const requestId = resolveRequestId(req);
  const pathname = req.nextUrl.pathname;

  if (pathname.startsWith("/api/")) {
    const origin = allowedOrigin();
    // Fail closed: without a configured APP_URL no mutating browser request can be verified.
    const verdict = checkRequestOrigin({
      method: req.method,
      pathname,
      origin: req.headers.get("origin"),
      secFetchSite: req.headers.get("sec-fetch-site"),
      allowedOrigin: origin ?? "\u0000unconfigured",
    });
    if (!verdict.ok) {
      const response = NextResponse.json(
        {
          error: {
            code: "CSRF_FAILED",
            message:
              verdict.reason === "origin_missing"
                ? "Request origin could not be verified"
                : "Request origin is not allowed",
          },
        },
        { status: 403, headers: { "cache-control": "no-store" } },
      );
      return finalise(response, requestId);
    }
  }

  const forwarded = new Headers(req.headers);
  forwarded.set(REQUEST_ID_HEADER, requestId);
  return finalise(NextResponse.next({ request: { headers: forwarded } }), requestId);
}

export const config = {
  // API routes and pages; skip Next internals and static files (anything with a file extension).
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|txt|xml|woff2?|map)$).*)",
  ],
};
