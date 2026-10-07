import { API_ERROR_CODES, type ApiErrorCode } from "@clockoff/shared/errors";

/**
 * Browser client for the ClockOff manager API (`/api/**`).
 *
 * - Same-origin cookie session (`credentials: "same-origin"`).
 * - CSRF double submit: mutating requests echo the JS-readable `wm_csrf` cookie in `x-csrf-token`.
 * - Every non-2xx response becomes an `ApiClientError` carrying the API's `{ error: { code, message, details } }`
 *   envelope. Responses without a recognisable envelope (e.g. an HTML 404 for a route that does not exist yet)
 *   are mapped from the HTTP status, so callers can always switch on `error.code`.
 * - A 401 without a more specific code becomes `UNAUTHENTICATED`; the dashboard layout redirects to `/login`.
 */

export const CSRF_COOKIE_NAME = "wm_csrf";
export const CSRF_HEADER_NAME = "x-csrf-token";

/** Error codes produced by the client itself (no response from the API, or a response it cannot read). */
export const CLIENT_ERROR_CODES = ["NETWORK_ERROR", "INVALID_RESPONSE"] as const;
export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];
export type ApiClientErrorCode = ApiErrorCode | ClientErrorCode;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type QueryPrimitive = string | number | boolean;
export type QueryValue = QueryPrimitive | null | undefined | readonly QueryPrimitive[];
export type QueryParams = Readonly<Record<string, QueryValue>>;

export interface ApiFetchOptions {
  method?: HttpMethod;
  /** JSON-serialisable body, or `FormData` (sent as multipart without a JSON content type). */
  body?: unknown;
  query?: QueryParams;
  signal?: AbortSignal;
  headers?: Readonly<Record<string, string>>;
}

const KNOWN_CODES: ReadonlySet<string> = new Set<string>(API_ERROR_CODES);

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === "string" && KNOWN_CODES.has(value);
}

export class ApiClientError extends Error {
  readonly code: ApiClientErrorCode;
  readonly status: number;
  readonly details?: unknown;
  /** The code exactly as the server sent it (may be a code this client version does not know). */
  readonly rawCode?: string;

  constructor(init: {
    code: ApiClientErrorCode;
    message: string;
    status: number;
    details?: unknown;
    rawCode?: string;
  }) {
    super(init.message);
    this.name = "ApiClientError";
    this.code = init.code;
    this.status = init.status;
    this.details = init.details;
    this.rawCode = init.rawCode;
  }
}

export function isApiClientError(error: unknown): error is ApiClientError {
  return error instanceof ApiClientError;
}

/** True when the error is an `ApiClientError` with one of the given codes. */
export function hasErrorCode(
  error: unknown,
  ...codes: readonly ApiClientErrorCode[]
): error is ApiClientError {
  return isApiClientError(error) && codes.includes(error.code);
}

export function isUnauthenticatedError(error: unknown): error is ApiClientError {
  return hasErrorCode(error, "UNAUTHENTICATED");
}

/** Best-effort code for a non-2xx response that carried no recognisable error envelope. */
export function errorCodeForStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400:
    case 422:
      return "VALIDATION_ERROR";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "FORBIDDEN";
    case 404:
    case 405:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 413:
      return "PAYLOAD_TOO_LARGE";
    case 415:
      return "UNSUPPORTED_MEDIA_TYPE";
    case 429:
      return "RATE_LIMITED";
    case 501:
      return "COMING_SOON";
    default:
      return "INTERNAL_ERROR";
  }
}

/** Builds `/api/...?...` from a path and query object. Arrays repeat the key; null/undefined are skipped. */
export function buildApiUrl(path: string, query?: QueryParams): string {
  if (!path.startsWith("/")) {
    throw new Error(`apiFetch path must start with "/": ${path}`);
  }
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value as readonly QueryPrimitive[]) params.append(key, String(item));
    } else {
      params.append(key, String(value));
    }
  }
  const qs = params.toString();
  if (!qs) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${qs}`;
}

/** Reads one cookie from a `document.cookie`-style string (URI-decoded; first occurrence wins). */
export function readCookieValue(cookieString: string, name: string): string | null {
  for (const part of cookieString.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    const raw = part.slice(idx + 1).trim();
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

let csrfTokenFallback: string | null = null;

/**
 * Remembers the CSRF token returned by `GET /api/auth/me`. Used only when the `wm_csrf` cookie cannot be
 * read (the cookie stays the source of truth because the server rotates it).
 */
export function rememberCsrfToken(token: string | null): void {
  csrfTokenFallback = token;
}

export function getCsrfToken(): string | null {
  if (typeof document !== "undefined") {
    const fromCookie = readCookieValue(document.cookie, CSRF_COOKIE_NAME);
    if (fromCookie) return fromCookie;
  }
  return csrfTokenFallback;
}

function isMutating(method: HttpMethod): boolean {
  return method !== "GET";
}

interface ParsedErrorEnvelope {
  code?: string;
  message?: string;
  details?: unknown;
}

function readErrorEnvelope(payload: unknown): ParsedErrorEnvelope | null {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return null;
  const error = (payload as { error: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const { code, message, details } = error as Record<string, unknown>;
  return {
    code: typeof code === "string" ? code : undefined,
    message: typeof message === "string" ? message : undefined,
    details,
  };
}

/** Converts a non-2xx response body (already parsed, or null when unreadable) into an `ApiClientError`. */
export function toApiClientError(status: number, payload: unknown): ApiClientError {
  const envelope = readErrorEnvelope(payload);
  const code: ApiErrorCode = isApiErrorCode(envelope?.code)
    ? envelope.code
    : errorCodeForStatus(status);
  return new ApiClientError({
    code,
    status,
    message: envelope?.message ?? `Request failed with status ${status}`,
    details: envelope?.details,
    rawCode: envelope?.code,
  });
}

async function readBody(response: Response): Promise<{ ok: true; value: unknown } | { ok: false }> {
  if (response.status === 204 || response.status === 205) return { ok: true, value: undefined };
  const text = await response.text();
  if (text.trim() === "") return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Calls the API and returns the parsed JSON body typed as `T`. The type parameter is a declaration of the
 * contract, not a runtime check: validate with a Zod schema at the call site when the shape matters.
 */
export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const method: HttpMethod = options.method ?? "GET";
  const headers = new Headers({ accept: "application/json" });
  for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value);

  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    if (typeof FormData !== "undefined" && options.body instanceof FormData) {
      body = options.body;
    } else {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.body);
    }
  } else if (method === "POST" || method === "PUT" || method === "PATCH") {
    // Body-carrying mutations always send a JSON object so strict empty-body schemas (`{}`) validate.
    headers.set("content-type", "application/json");
    body = "{}";
  }

  if (isMutating(method)) {
    const csrf = getCsrfToken();
    if (csrf) headers.set(CSRF_HEADER_NAME, csrf);
  }

  let response: Response;
  try {
    response = await fetch(buildApiUrl(path, options.query), {
      method,
      headers,
      body,
      credentials: "same-origin",
      signal: options.signal,
      cache: "no-store",
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiClientError({
      code: "NETWORK_ERROR",
      status: 0,
      message: "Network request failed",
    });
  }

  const parsed = await readBody(response);

  if (!response.ok) {
    throw toApiClientError(response.status, parsed.ok ? parsed.value : null);
  }
  if (!parsed.ok) {
    throw new ApiClientError({
      code: "INVALID_RESPONSE",
      status: response.status,
      message: "The server returned a response that could not be read",
    });
  }
  return parsed.value as T;
}

/** Shorthands. */
export const api = {
  get: <T>(path: string, query?: QueryParams, signal?: AbortSignal) =>
    apiFetch<T>(path, { query, signal }),
  post: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: "POST", body }),
  patch: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: "PATCH", body }),
  put: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: "PUT", body }),
  delete: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: "DELETE", body }),
} as const;
