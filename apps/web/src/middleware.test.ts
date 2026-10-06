import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, middleware } from "./middleware";

const APP = new URL(process.env.APP_URL ?? "http://localhost:3000").origin;

function req(
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): NextRequest {
  return new NextRequest(new URL(path, APP), {
    method: init.method ?? "GET",
    headers: init.headers ?? {},
  });
}

describe("middleware", () => {
  it("adds security headers and a request id to pages and API responses", () => {
    const res = middleware(req("/dashboard"));
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("permissions-policy")).toContain("camera=()");
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    // forwarded to the route handler
    expect(res.headers.get("x-middleware-request-x-request-id")).toBe(
      res.headers.get("x-request-id"),
    );
  });

  it("keeps a well-formed incoming request id", () => {
    expect(
      middleware(
        req("/api/health", { headers: { "x-request-id": "client-req-0001" } }),
      ).headers.get("x-request-id"),
    ).toBe("client-req-0001");
  });

  it("rejects cross-origin and origin-less mutating API calls with CSRF_FAILED", async () => {
    const evil = middleware(
      req("/api/auth/login", { method: "POST", headers: { origin: "https://evil.example" } }),
    );
    expect(evil.status).toBe(403);
    expect(await evil.json()).toEqual({
      error: { code: "CSRF_FAILED", message: "Request origin is not allowed" },
    });
    expect(evil.headers.get("x-frame-options")).toBe("DENY");

    const missing = middleware(req("/api/organisations/current", { method: "PATCH" }));
    expect(missing.status).toBe(403);
    const crossSite = middleware(
      req("/api/x", { method: "DELETE", headers: { "sec-fetch-site": "cross-site" } }),
    );
    expect(crossSite.status).toBe(403);
  });

  it("allows same-origin mutating calls and exempts mobile + jobs APIs", () => {
    expect(
      middleware(req("/api/auth/login", { method: "POST", headers: { origin: APP } })).status,
    ).toBe(200);
    expect(
      middleware(
        req("/api/auth/login", { method: "POST", headers: { "sec-fetch-site": "same-origin" } }),
      ).status,
    ).toBe(200);
    expect(middleware(req("/api/mobile/v1/refresh", { method: "POST" })).status).toBe(200);
    expect(middleware(req("/api/jobs/tick", { method: "POST" })).status).toBe(200);
    expect(middleware(req("/login", { method: "POST" })).status).toBe(200);
  });

  it("matches pages and API routes but not static assets", () => {
    const matcher = new RegExp(`^${config.matcher[0]}$`);
    expect(matcher.test("/api/auth/login")).toBe(true);
    expect(matcher.test("/dashboard")).toBe(true);
    expect(matcher.test("/_next/static/chunk.js")).toBe(false);
    expect(matcher.test("/logo.svg")).toBe(false);
  });
});
