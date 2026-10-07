import { NextRequest } from "next/server";
import { CSRF_COOKIE } from "@/lib/cookies";
import { env } from "@/lib/env";
import { settleBackgroundTasks } from "@/server/background";
import type { RouteHandler } from "@/server/http/apiHandler";

/**
 * Call an App Router route handler in-process with a real `NextRequest`, like a browser would:
 * cookies from a {@link CookieJar}, `Origin: APP_URL` and the `x-csrf-token` header on mutating
 * requests (both can be switched off to test the protections), JSON body, dynamic `params`.
 *
 * Note: `src/middleware.ts` does not run here (it is an edge concern tested in `middleware.test.ts`);
 * the handler-level checks (double-submit CSRF, Origin re-check) do run. Background work started with
 * `runAfterResponse` (e.g. emails) is awaited before `callRoute` resolves.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A minimal browser cookie store: applies `Set-Cookie` (incl. deletions) and renders `Cookie`. */
export class CookieJar {
  private readonly store = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [name, value] of Object.entries(initial)) this.store.set(name, value);
  }

  get(name: string): string | undefined {
    return this.store.get(name);
  }

  set(name: string, value: string): void {
    this.store.set(name, value);
  }

  delete(name: string): void {
    this.store.delete(name);
  }

  has(name: string): boolean {
    return this.store.has(name);
  }

  /** Apply `Set-Cookie` header values: `Max-Age=0` / past `Expires` / empty value delete the cookie. */
  apply(setCookies: readonly string[]): void {
    for (const header of setCookies) {
      const parsed = parseSetCookie(header);
      if (!parsed) continue;
      if (parsed.deleted) this.store.delete(parsed.name);
      else this.store.set(parsed.name, parsed.value);
    }
  }

  header(): string {
    return [...this.store.entries()].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
  }

  clone(): CookieJar {
    return new CookieJar(Object.fromEntries(this.store));
  }

  toObject(): Record<string, string> {
    return Object.fromEntries(this.store);
  }
}

export interface ParsedSetCookie {
  name: string;
  value: string;
  attributes: Record<string, string | true>;
  deleted: boolean;
}

export function parseSetCookie(header: string): ParsedSetCookie | null {
  const [pair, ...attrs] = header.split(";").map((s) => s.trim());
  if (!pair) return null;
  const idx = pair.indexOf("=");
  if (idx <= 0) return null;
  const name = pair.slice(0, idx);
  let value = pair.slice(idx + 1);
  try {
    value = decodeURIComponent(value);
  } catch {
    // keep raw
  }
  const attributes: Record<string, string | true> = {};
  for (const attr of attrs) {
    const eq = attr.indexOf("=");
    if (eq === -1) attributes[attr.toLowerCase()] = true;
    else attributes[attr.slice(0, eq).toLowerCase()] = attr.slice(eq + 1);
  }
  const maxAge = attributes["max-age"];
  const expires = attributes.expires;
  const deleted =
    value === "" ||
    (typeof maxAge === "string" && Number(maxAge) <= 0) ||
    (typeof expires === "string" && Date.parse(expires) <= Date.now());
  return { name, value, attributes, deleted };
}

export interface CallRouteOptions {
  method?: HttpMethod;
  /** Path (and optional query string) of the request, e.g. `/api/auth/login`. */
  path: string;
  /** JSON-serialised unless it is already a string (sent verbatim). */
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Dynamic route params, passed as Next 15's `Promise<params>`. */
  params?: Record<string, string | string[]>;
  /** Cookie jar to send from and update with the response's `Set-Cookie` headers. */
  jar?: CookieJar;
  /** Extra raw cookies (merged over the jar). */
  cookies?: Record<string, string>;
  headers?: Record<string, string>;
  /** Send `x-csrf-token` from the jar's `clockoff_csrf` cookie on mutating requests (default true). */
  csrf?: boolean;
  /** `Origin` header for mutating requests; `null` omits it. Default: the APP_URL origin. */
  origin?: string | null;
  /** Client IP via `x-forwarded-for` (rate-limit identity). */
  ip?: string;
}

export interface RouteResult<T = unknown> {
  status: number;
  headers: Headers;
  /** Parsed JSON body (`null` for empty bodies). */
  body: T;
  /** Raw `Set-Cookie` header values. */
  setCookies: string[];
  /** Parsed `Set-Cookie` values by cookie name. */
  cookies: Record<string, ParsedSetCookie>;
}

/** The envelope every non-2xx response carries. */
export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function callRoute<T = unknown>(
  handler: RouteHandler,
  options: CallRouteOptions,
): Promise<RouteResult<T>> {
  const method = options.method ?? "GET";
  const url = new URL(options.path, env().APP_URL);
  for (const [k, v] of Object.entries(options.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const headers = new Headers(options.headers ?? {});
  const jarForRequest = options.jar?.clone() ?? new CookieJar();
  for (const [k, v] of Object.entries(options.cookies ?? {})) jarForRequest.set(k, v);
  const cookieHeader = jarForRequest.header();
  if (cookieHeader) headers.set("cookie", cookieHeader);
  if (options.ip) headers.set("x-forwarded-for", options.ip);

  if (MUTATING.has(method)) {
    const origin = options.origin === undefined ? env().APP_ORIGIN : options.origin;
    if (origin !== null && !headers.has("origin")) headers.set("origin", origin);
    const csrf = jarForRequest.get(CSRF_COOKIE);
    if ((options.csrf ?? true) && csrf && !headers.has("x-csrf-token"))
      headers.set("x-csrf-token", csrf);
  }

  let body: string | undefined;
  if (options.body !== undefined) {
    body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }

  const req = new NextRequest(url, { method, headers, ...(body !== undefined ? { body } : {}) });
  const response = await handler(req, { params: Promise.resolve(options.params ?? {}) });
  // Work deferred with `runAfterResponse` (emails) has run by the time a browser could act on it.
  await settleBackgroundTasks();

  const setCookies = response.headers.getSetCookie();
  options.jar?.apply(setCookies);
  const cookies: Record<string, ParsedSetCookie> = {};
  for (const header of setCookies) {
    const parsed = parseSetCookie(header);
    if (parsed) cookies[parsed.name] = parsed;
  }

  const text = await response.text();
  let parsedBody: unknown = null;
  if (text) {
    try {
      parsedBody = JSON.parse(text);
    } catch {
      parsedBody = text;
    }
  }
  return {
    status: response.status,
    headers: response.headers,
    body: parsedBody as T,
    setCookies,
    cookies,
  };
}
