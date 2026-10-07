import { env } from "@/lib/env";

/**
 * Cookie names and attribute builders for the manager web session.
 *
 * - `clockoff_session`  httpOnly, opaque session token (hash stored server-side).
 * - `clockoff_csrf`     readable by JS; double-submit CSRF token echoed in `x-csrf-token`.
 * - `clockoff_org`      httpOnly, currently selected organisation id (membership is re-checked per request).
 *
 * All cookies are `SameSite=Lax`, `Path=/`, and `Secure` whenever APP_URL is https or in production.
 */

export const SESSION_COOKIE = "clockoff_session";
export const CSRF_COOKIE = "clockoff_csrf";
export const ORG_COOKIE = "clockoff_org";

export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  path?: string;
  domain?: string;
  maxAge?: number;
  expires?: Date;
}

export function cookiesAreSecure(): boolean {
  const e = env();
  return e.isProduction || e.APP_URL.startsWith("https://");
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? "/"}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.maxAge !== undefined)
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
  return parts.join("; ");
}

/** Parse a `Cookie` request header into a name → value map (first occurrence wins). */
export function parseCookieHeader(header: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name || out.has(name)) continue;
    try {
      out.set(name, decodeURIComponent(value));
    } catch {
      out.set(name, value);
    }
  }
  return out;
}

function sessionMaxAgeSeconds(): number {
  return env().SESSION_TTL_DAYS * 24 * 60 * 60;
}

export function sessionCookie(token: string): string {
  return serializeCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: cookiesAreSecure(),
    sameSite: "Lax",
    maxAge: sessionMaxAgeSeconds(),
  });
}

export function csrfCookie(token: string): string {
  return serializeCookie(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: cookiesAreSecure(),
    sameSite: "Lax",
    maxAge: sessionMaxAgeSeconds(),
  });
}

export function orgCookie(organisationId: string): string {
  return serializeCookie(ORG_COOKIE, organisationId, {
    httpOnly: true,
    secure: cookiesAreSecure(),
    sameSite: "Lax",
    maxAge: sessionMaxAgeSeconds(),
  });
}

export function clearCookie(name: string): string {
  return serializeCookie(name, "", {
    httpOnly: name !== CSRF_COOKIE,
    secure: cookiesAreSecure(),
    sameSite: "Lax",
    maxAge: 0,
    expires: new Date(0),
  });
}

export function clearAuthCookies(): string[] {
  return [clearCookie(SESSION_COOKIE), clearCookie(CSRF_COOKIE), clearCookie(ORG_COOKIE)];
}

/** Append one or more `Set-Cookie` headers to a response (mutates and returns it). */
export function appendSetCookies<T extends Response>(response: T, cookies: readonly string[]): T {
  for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
  return response;
}
