/** Response helpers of Mock Planday (fetch `Response` objects, as `globalThis.fetch` returns). */
import type { PlandayJsonProblemDetails } from "./raw";

const TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function emptyResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

/** RFC 7807 `ProblemDetails` (notes §8); Planday documents it on 404s and some 400s. */
export function problemBody(
  status: number,
  detail: string | null = null,
): PlandayJsonProblemDetails {
  return {
    type: `https://httpstatuses.io/${status}`,
    title: TITLES[status] ?? "Error",
    status,
    detail,
    instance: null,
  };
}

export function problemResponse(status: number, detail: string | null = null): Response {
  return new Response(JSON.stringify(problemBody(status, detail)), {
    status,
    headers: { "content-type": "application/problem+json; charset=utf-8" },
  });
}

/** OAuth error body of the identity server (format undocumented, notes §3.3; `invalid_grant` per RFC 6749). */
export function oauthErrorResponse(status: number, error: string): Response {
  return jsonResponse(status, { error });
}
