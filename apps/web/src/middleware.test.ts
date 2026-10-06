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

describe("middleware with hostname routing on", () => {
  const ROUTING = {
    HOST_ROUTING: "on",
    APP_URL: "https://app.example.com",
    MARKETING_URL: "https://example.com",
  };

  function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    try {
      return fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  function hostReq(url: string, init: { method?: string; headers?: Record<string, string> } = {}) {
    const u = new URL(url);
    return new NextRequest(u, {
      method: init.method ?? "GET",
      headers: { host: u.host, ...init.headers },
    });
  }

  it("redirects dashboard pages on the apex to the app host, with security headers", () => {
    const res = withEnv(ROUTING, () =>
      middleware(hostReq("https://example.com/login?next=%2Foverview")),
    );
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://app.example.com/login?next=%2Foverview");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("serves marketing pages on the apex and redirects www to the apex", () => {
    const apex = withEnv(ROUTING, () => middleware(hostReq("https://example.com/pricing")));
    expect(apex.headers.get("location")).toBeNull();
    const www = withEnv(ROUTING, () => middleware(hostReq("https://www.example.com/")));
    expect(www.status).toBe(308);
    expect(www.headers.get("location")).toBe("https://example.com/");
  });

  it("404s app APIs on the apex", async () => {
    const res = withEnv(ROUTING, () =>
      middleware(
        hostReq("https://example.com/api/auth/login", {
          method: "POST",
          headers: { origin: "https://example.com" },
        }),
      ),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } });
  });

  it("accepts a demo request posted from the marketing origin, but not from elsewhere", () => {
    const ok = withEnv(ROUTING, () =>
      middleware(
        hostReq("https://example.com/api/request-demo", {
          method: "POST",
          headers: { origin: "https://example.com" },
        }),
      ),
    );
    expect(ok.status).toBe(200);
    const evil = withEnv(ROUTING, () =>
      middleware(
        hostReq("https://example.com/api/request-demo", {
          method: "POST",
          headers: { origin: "https://evil.example" },
        }),
      ),
    );
    expect(evil.status).toBe(403);
    const crossHost = withEnv(ROUTING, () =>
      middleware(
        hostReq("https://app.example.com/api/auth/login", {
          method: "POST",
          headers: { origin: "https://example.com" },
        }),
      ),
    );
    expect(crossHost.status).toBe(403);
  });

  it("sends the app root to /overview and leaves preview hosts alone", () => {
    const root = withEnv(ROUTING, () => middleware(hostReq("https://app.example.com/")));
    expect(root.status).toBe(307);
    expect(root.headers.get("location")).toBe("https://app.example.com/overview");
    const preview = withEnv(ROUTING, () =>
      middleware(hostReq("https://deploy-preview-12--clockoff.netlify.app/login")),
    );
    expect(preview.headers.get("location")).toBeNull();
  });
});
