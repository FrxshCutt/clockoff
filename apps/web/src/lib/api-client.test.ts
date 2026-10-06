import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiClientError,
  apiFetch,
  buildApiUrl,
  errorCodeForStatus,
  getCsrfToken,
  hasErrorCode,
  isApiErrorCode,
  readCookieValue,
  rememberCsrfToken,
  toApiClientError,
} from "./api-client";

type FetchArgs = [input: string, init: RequestInit];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mockFetch(response: Response | (() => Promise<Response>)) {
  const fn = vi.fn<(...args: FetchArgs) => Promise<Response>>(() =>
    typeof response === "function" ? response() : Promise.resolve(response),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

function sentHeaders(fn: ReturnType<typeof mockFetch>): Headers {
  const init = fn.mock.calls[0]?.[1];
  return new Headers(init?.headers);
}

describe("buildApiUrl", () => {
  it("appends query params, repeating arrays and skipping nullish values", () => {
    expect(buildApiUrl("/api/employees")).toBe("/api/employees");
    expect(buildApiUrl("/api/employees", { q: "a b", page: 2, active: true, skip: null, none: undefined })).toBe(
      "/api/employees?q=a+b&page=2&active=true",
    );
    expect(buildApiUrl("/api/x", { status: ["INVITED", "JOINED"] })).toBe("/api/x?status=INVITED&status=JOINED");
    expect(buildApiUrl("/api/x?a=1", { b: 2 })).toBe("/api/x?a=1&b=2");
    expect(buildApiUrl("/api/x", { only: null })).toBe("/api/x");
  });

  it("refuses non-absolute paths so requests never leave the origin", () => {
    expect(() => buildApiUrl("https://evil.example/api")).toThrow();
    expect(() => buildApiUrl("api/x")).toThrow();
  });
});

describe("readCookieValue", () => {
  it("reads and decodes a single cookie", () => {
    expect(readCookieValue("a=1; wm_csrf=abc%3D%3D; b=2", "wm_csrf")).toBe("abc==");
    expect(readCookieValue("wm_csrf_old=x; wm_csrf=y", "wm_csrf")).toBe("y");
    expect(readCookieValue("a=1", "wm_csrf")).toBeNull();
    expect(readCookieValue("wm_csrf=", "wm_csrf")).toBeNull();
    expect(readCookieValue("wm_csrf=%E0%A4%A", "wm_csrf")).toBe("%E0%A4%A");
  });
});

describe("error mapping", () => {
  it("knows the shared API codes", () => {
    expect(isApiErrorCode("LAST_OWNER")).toBe(true);
    expect(isApiErrorCode("SOMETHING_NEW")).toBe(false);
    expect(isApiErrorCode(42)).toBe(false);
  });

  it("maps HTTP statuses without an envelope", () => {
    expect(errorCodeForStatus(400)).toBe("VALIDATION_ERROR");
    expect(errorCodeForStatus(401)).toBe("UNAUTHENTICATED");
    expect(errorCodeForStatus(403)).toBe("FORBIDDEN");
    expect(errorCodeForStatus(404)).toBe("NOT_FOUND");
    expect(errorCodeForStatus(409)).toBe("CONFLICT");
    expect(errorCodeForStatus(429)).toBe("RATE_LIMITED");
    expect(errorCodeForStatus(501)).toBe("COMING_SOON");
    expect(errorCodeForStatus(502)).toBe("INTERNAL_ERROR");
  });

  it("reads the envelope and keeps unknown codes as rawCode", () => {
    const known = toApiClientError(409, { error: { code: "LAST_OWNER", message: "m", details: { a: 1 } } });
    expect(known).toMatchObject({ code: "LAST_OWNER", status: 409, message: "m", details: { a: 1 } });
    const unknown = toApiClientError(409, { error: { code: "BRAND_NEW", message: "m" } });
    expect(unknown.code).toBe("CONFLICT");
    expect(unknown.rawCode).toBe("BRAND_NEW");
    expect(toApiClientError(500, null).code).toBe("INTERNAL_ERROR");
    expect(toApiClientError(500, { error: "nope" }).code).toBe("INTERNAL_ERROR");
  });

  it("hasErrorCode narrows ApiClientErrors only", () => {
    const error = new ApiClientError({ code: "NOT_FOUND", status: 404, message: "x" });
    expect(hasErrorCode(error, "NOT_FOUND", "COMING_SOON")).toBe(true);
    expect(hasErrorCode(error, "FORBIDDEN")).toBe(false);
    expect(hasErrorCode(new Error("NOT_FOUND"), "NOT_FOUND")).toBe(false);
  });
});

describe("apiFetch", () => {
  beforeEach(() => {
    rememberCsrfToken(null);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rememberCsrfToken(null);
  });

  it("GETs same-origin JSON without a CSRF header", async () => {
    vi.stubGlobal("document", { cookie: "wm_csrf=tok123" });
    const fetchFn = mockFetch(jsonResponse(200, { ok: true }));
    await expect(apiFetch<{ ok: boolean }>("/api/auth/me", { query: { a: 1 } })).resolves.toEqual({ ok: true });
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe("/api/auth/me?a=1");
    expect(init?.method).toBe("GET");
    expect(init?.credentials).toBe("same-origin");
    expect(init?.body).toBeUndefined();
    expect(sentHeaders(fetchFn).has("x-csrf-token")).toBe(false);
  });

  it("sends JSON bodies with the CSRF token from the wm_csrf cookie on mutations", async () => {
    vi.stubGlobal("document", { cookie: "other=1; wm_csrf=tok%2B123" });
    const fetchFn = mockFetch(jsonResponse(201, { ok: true }));
    await apiFetch("/api/organisations", { method: "POST", body: { name: "Acme" } });
    const init = fetchFn.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ name: "Acme" }));
    const headers = sentHeaders(fetchFn);
    expect(headers.get("x-csrf-token")).toBe("tok+123");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("sends `{}` for body-less POST/PATCH so strict empty schemas validate, but not for DELETE", async () => {
    vi.stubGlobal("document", { cookie: "" });
    const fetchFn = mockFetch(jsonResponse(200, { ok: true }));
    await apiFetch("/api/auth/logout", { method: "POST" });
    expect(fetchFn.mock.calls[0]?.[1].body).toBe("{}");
    fetchFn.mockClear();
    fetchFn.mockImplementation(() => Promise.resolve(jsonResponse(200, { ok: true })));
    await apiFetch("/api/x", { method: "DELETE" });
    expect(fetchFn.mock.calls[0]?.[1].body).toBeUndefined();
  });

  it("falls back to the token remembered from /api/auth/me when the cookie is unreadable", async () => {
    vi.stubGlobal("document", { cookie: "" });
    rememberCsrfToken("from-me");
    expect(getCsrfToken()).toBe("from-me");
    const fetchFn = mockFetch(jsonResponse(200, {}));
    await apiFetch("/api/x", { method: "PATCH", body: { a: 1 } });
    expect(sentHeaders(fetchFn).get("x-csrf-token")).toBe("from-me");
  });

  it("passes FormData through without a JSON content type", async () => {
    vi.stubGlobal("document", { cookie: "wm_csrf=t" });
    const fetchFn = mockFetch(jsonResponse(200, {}));
    const form = new FormData();
    form.append("file", "a,b");
    await apiFetch("/api/imports", { method: "POST", body: form });
    expect(fetchFn.mock.calls[0]?.[1].body).toBe(form);
    expect(sentHeaders(fetchFn).has("content-type")).toBe(false);
  });

  it("throws ApiClientError with the envelope for non-2xx responses", async () => {
    mockFetch(jsonResponse(401, { error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" } }));
    const error = await apiFetch("/api/auth/login", { method: "POST", body: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ code: "INVALID_CREDENTIALS", status: 401 });
  });

  it("maps a bare 401 to UNAUTHENTICATED and an HTML 404 to NOT_FOUND", async () => {
    mockFetch(new Response("", { status: 401 }));
    await expect(apiFetch("/api/auth/me")).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    mockFetch(new Response("<!doctype html><h1>404</h1>", { status: 404, headers: { "content-type": "text/html" } }));
    await expect(apiFetch("/api/notifications")).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("reports network failures as NETWORK_ERROR and rethrows aborts untouched", async () => {
    mockFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(apiFetch("/api/x")).rejects.toMatchObject({ code: "NETWORK_ERROR", status: 0 });
    const abort = new DOMException("The operation was aborted.", "AbortError");
    mockFetch(() => Promise.reject(abort));
    await expect(apiFetch("/api/x")).rejects.toBe(abort);
  });

  it("returns undefined for empty 2xx bodies and INVALID_RESPONSE for unreadable ones", async () => {
    mockFetch(new Response(null, { status: 204 }));
    await expect(apiFetch("/api/x", { method: "DELETE" })).resolves.toBeUndefined();
    mockFetch(new Response("not json", { status: 200 }));
    await expect(apiFetch("/api/x")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
