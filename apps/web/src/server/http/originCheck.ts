/**
 * Browser-request origin policy. Edge-safe (no Node imports) because the middleware runs it.
 *
 * Non-GET `/api/*` calls from browsers must carry `Origin: <APP_URL origin>`. Requests without an
 * Origin header are only accepted when the browser says they are same-origin (`Sec-Fetch-Site`).
 * The mobile app (`/api/mobile/**`) and the scheduler (`/api/jobs/**`) are not browsers and are
 * authenticated by bearer tokens instead.
 */

export const ORIGIN_CHECK_EXEMPT_PREFIXES = ["/api/mobile/", "/api/jobs/"] as const;

export function isOriginCheckExempt(pathname: string): boolean {
  return ORIGIN_CHECK_EXEMPT_PREFIXES.some(
    (prefix) => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix),
  );
}

export function isSafeMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS";
}

export interface OriginCheckInput {
  method: string;
  pathname: string;
  origin: string | null;
  secFetchSite: string | null;
  allowedOrigin: string;
}

export type OriginCheckResult =
  | {
      ok: true;
      reason: "safe_method" | "exempt_path" | "not_api" | "origin_match" | "same_origin_fetch";
    }
  | { ok: false; reason: "origin_mismatch" | "origin_missing" };

export function checkRequestOrigin(input: OriginCheckInput): OriginCheckResult {
  if (!input.pathname.startsWith("/api/")) return { ok: true, reason: "not_api" };
  if (isSafeMethod(input.method)) return { ok: true, reason: "safe_method" };
  if (isOriginCheckExempt(input.pathname)) return { ok: true, reason: "exempt_path" };

  // A present Origin must match exactly. The opaque `null` origin (sandboxed frames, `file:`/`data:`
  // pages, cross-origin redirects) is never the app and is a mismatch, not a missing header.
  if (input.origin !== null) {
    return input.origin === input.allowedOrigin
      ? { ok: true, reason: "origin_match" }
      : { ok: false, reason: "origin_mismatch" };
  }
  if (input.secFetchSite === "same-origin") return { ok: true, reason: "same_origin_fetch" };
  return { ok: false, reason: "origin_missing" };
}
