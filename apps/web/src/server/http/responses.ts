import type { AppError, ApiErrorBody } from "@workmode/shared/errors";
import { appendSetCookies } from "@/lib/cookies";
import { REQUEST_ID_HEADER } from "@/lib/request";

/** Response helpers shared by the handler wrapper and route implementations. */

export interface ResponseInitExtras {
  status?: number;
  headers?: Record<string, string>;
  /** Pre-serialised `Set-Cookie` values (see `@/lib/cookies`). */
  cookies?: readonly string[];
}

function normaliseInit(init: number | ResponseInitExtras | undefined): ResponseInitExtras {
  if (typeof init === "number") return { status: init };
  return init ?? {};
}

/**
 * JSON response. `init` is either a status code (`json(data, 201)`) or `{ status, headers, cookies }`.
 * Responses are `no-store` by default: API data is per-user and must never be cached by proxies.
 */
export function json<T>(data: T, init?: number | ResponseInitExtras): Response {
  const options = normaliseInit(init);
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(options.headers ?? {}),
  });
  const response = new Response(JSON.stringify(data), { status: options.status ?? 200, headers });
  if (options.cookies?.length) appendSetCookies(response, options.cookies);
  return response;
}

/** `204 No Content`, optionally with headers / cookies. */
export function noContent(init: Omit<ResponseInitExtras, "status"> = {}): Response {
  const response = new Response(null, {
    status: 204,
    headers: { "cache-control": "no-store", ...(init.headers ?? {}) },
  });
  if (init.cookies?.length) appendSetCookies(response, init.cookies);
  return response;
}

/** The `{ error: { code, message, details? } }` envelope with the error's HTTP status. */
export function errorResponse(
  error: AppError,
  requestId?: string,
  extraHeaders?: Record<string, string>,
): Response {
  const body: ApiErrorBody = error.toBody();
  const headers: Record<string, string> = { ...(extraHeaders ?? {}) };
  if (requestId) headers[REQUEST_ID_HEADER] = requestId;
  if (error.code === "RATE_LIMITED") {
    const retry = (error.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
    if (retry) headers["Retry-After"] = String(retry);
  }
  return json(body, { status: error.status, headers });
}

/**
 * Server-Sent Events response wrapping a ReadableStream of already-encoded SSE frames.
 * Returned from a `createHandler` implementation as-is; the wrapper does not touch the body.
 */
export function sseResponse(
  stream: ReadableStream<Uint8Array>,
  init: Omit<ResponseInitExtras, "status"> = {},
): Response {
  const headers = new Headers({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...(init.headers ?? {}),
  });
  const response = new Response(stream, { status: 200, headers });
  if (init.cookies?.length) appendSetCookies(response, init.cookies);
  return response;
}
