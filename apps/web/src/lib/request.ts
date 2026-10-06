import { randomUUID } from "node:crypto";
import { parseCookieHeader } from "@/lib/cookies";
import { env } from "@/lib/env";

/**
 * Request inspection helpers (Node runtime). The middleware sets `x-request-id`; handlers echo it.
 *
 * Client IP: Next.js route handlers cannot see the socket address, so the IP comes from
 * `X-Forwarded-For` as written by our own reverse proxy. Proxies APPEND the address they received the
 * connection from, so everything left of the trusted hops is client-supplied and spoofable: the client
 * IP is the entry `TRUSTED_PROXY_HOPS` (default 1) positions from the RIGHT. Taking the first (leftmost)
 * entry would let any caller pick their own rate-limit bucket. `X-Real-IP` is only used when there is
 * no `X-Forwarded-For` at all. Without either header the IP is unknown and rate limits share a bucket.
 */

export const REQUEST_ID_HEADER = "x-request-id";
export const CSRF_HEADER = "x-csrf-token";

const MAX_USER_AGENT = 512;

export function getRequestId(req: Request): string {
  const incoming = req.headers.get(REQUEST_ID_HEADER);
  if (incoming && /^[A-Za-z0-9._:-]{8,128}$/.test(incoming)) return incoming;
  return randomUUID();
}

export function getClientIp(
  req: Request,
  trustedProxyHops: number = env().TRUSTED_PROXY_HOPS,
): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (hops.length > 0) {
      const index = Math.max(0, hops.length - Math.max(1, trustedProxyHops));
      return hops[index]!.slice(0, 64);
    }
  }
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real.slice(0, 64);
  return null;
}

export function getUserAgent(req: Request): string | null {
  const ua = req.headers.get("user-agent");
  if (!ua) return null;
  return ua.slice(0, MAX_USER_AGENT);
}

export function getBearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export function getCookie(req: Request, name: string): string | undefined {
  return parseCookieHeader(req.headers.get("cookie")).get(name);
}

export function isMutatingMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m !== "GET" && m !== "HEAD" && m !== "OPTIONS";
}
