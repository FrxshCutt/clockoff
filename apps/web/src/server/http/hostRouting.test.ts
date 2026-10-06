import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MARKETING_PATHS,
  allowedOriginForRequest,
  readHostRoutingConfig,
  routeByHost,
} from "./hostRouting";

const ENV = {
  HOST_ROUTING: "on",
  APP_URL: "https://app.example.com",
  MARKETING_URL: "https://example.com",
};
const config = readHostRoutingConfig(ENV);

function route(host: string | null, pathname: string, search = "") {
  return routeByHost(config, { host, pathname, search });
}

describe("readHostRoutingConfig", () => {
  it("is off unless HOST_ROUTING is on and both URLs are valid on different hosts", () => {
    expect(readHostRoutingConfig({ ...ENV, HOST_ROUTING: undefined })).toBeNull();
    expect(readHostRoutingConfig({ ...ENV, HOST_ROUTING: "off" })).toBeNull();
    expect(readHostRoutingConfig({ ...ENV, MARKETING_URL: undefined })).toBeNull();
    expect(readHostRoutingConfig({ ...ENV, MARKETING_URL: "not a url" })).toBeNull();
    expect(readHostRoutingConfig({ ...ENV, MARKETING_URL: "https://app.example.com" })).toBeNull();
  });

  it("derives hosts, origins and the www alias", () => {
    expect(config).toEqual({
      appHost: "app.example.com",
      appOrigin: "https://app.example.com",
      marketingHost: "example.com",
      marketingOrigin: "https://example.com",
      marketingAliasHosts: ["www.example.com"],
    });
  });

  it("accepts extra alias hosts", () => {
    const c = readHostRoutingConfig({
      ...ENV,
      MARKETING_ALIAS_HOSTS: "workmode.co.uk, www.workmode.co.uk",
    });
    expect(c?.marketingAliasHosts).toEqual([
      "www.example.com",
      "workmode.co.uk",
      "www.workmode.co.uk",
    ]);
  });
});

describe("routeByHost", () => {
  it("leaves every request alone when routing is off", () => {
    expect(routeByHost(null, { host: "example.com", pathname: "/login", search: "" })).toEqual({
      action: "next",
    });
  });

  it("never touches unknown hosts (localhost, preview deployments)", () => {
    expect(route("localhost:3000", "/overview")).toEqual({ action: "next" });
    expect(route("workmode-git-main-acme.vercel.app", "/")).toEqual({ action: "next" });
  });

  it("redirects www to the apex, keeping path and query", () => {
    expect(route("www.example.com", "/pricing", "?ref=ad")).toEqual({
      action: "redirect",
      location: "https://example.com/pricing?ref=ad",
      status: 308,
    });
  });

  it("serves marketing pages and the marketing APIs on the apex", () => {
    for (const path of MARKETING_PATHS)
      expect(route("example.com", path)).toEqual({ action: "next" });
    expect(route("example.com", "/pricing/")).toEqual({ action: "next" });
    expect(route("example.com", "/api/request-demo")).toEqual({ action: "next" });
    expect(route("example.com", "/api/health")).toEqual({ action: "next" });
  });

  it("sends dashboard and auth pages from the apex to the app host", () => {
    expect(route("example.com", "/login", "?next=%2Foverview")).toEqual({
      action: "redirect",
      location: "https://app.example.com/login?next=%2Foverview",
      status: 308,
    });
    expect(route("EXAMPLE.com", "/employees/123")).toMatchObject({
      location: "https://app.example.com/employees/123",
    });
  });

  it("404s app APIs on the apex instead of redirecting them", () => {
    expect(route("example.com", "/api/auth/login")).toEqual({ action: "not_found" });
    expect(route("example.com", "/api/mobile/v1/join/lookup")).toEqual({ action: "not_found" });
  });

  it("sends the app root to the dashboard and marketing pages to the apex", () => {
    expect(route("app.example.com", "/")).toEqual({
      action: "redirect",
      location: "https://app.example.com/overview",
      status: 307,
    });
    expect(route("app.example.com", "/pricing")).toEqual({
      action: "redirect",
      location: "https://example.com/pricing",
      status: 308,
    });
  });

  it("serves the dashboard, auth pages and every API on the app host", () => {
    for (const path of [
      "/login",
      "/overview",
      "/api/auth/me",
      "/api/mobile/v1/sync",
      "/api/request-demo",
    ]) {
      expect(route("app.example.com", path)).toEqual({ action: "next" });
    }
  });
});

describe("allowedOriginForRequest", () => {
  it("accepts the marketing origin only for marketing APIs on the marketing host", () => {
    const app = "https://app.example.com";
    expect(
      allowedOriginForRequest(config, app, { host: "example.com", pathname: "/api/request-demo" }),
    ).toBe("https://example.com");
    expect(
      allowedOriginForRequest(config, app, { host: "example.com", pathname: "/api/auth/login" }),
    ).toBe(app);
    expect(
      allowedOriginForRequest(config, app, {
        host: "app.example.com",
        pathname: "/api/request-demo",
      }),
    ).toBe(app);
    expect(
      allowedOriginForRequest(null, app, { host: "example.com", pathname: "/api/request-demo" }),
    ).toBe(app);
  });
});

describe("MARKETING_PATHS", () => {
  it("lists every top-level page in app/(marketing)", () => {
    const dir = resolve(import.meta.dirname, "../../app/(marketing)");
    const pages = readdirSync(dir)
      .filter((entry) => statSync(join(dir, entry)).isDirectory())
      .filter((entry) => readdirSync(join(dir, entry)).includes("page.tsx"))
      .map((entry) => `/${entry}`);
    expect([...MARKETING_PATHS].sort()).toEqual(["/", ...pages].sort());
  });
});
