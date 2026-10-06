import { describe, expect, it } from "vitest";
import { checkRequestOrigin, isOriginCheckExempt } from "./originCheck";

const base = {
  allowedOrigin: "https://app.example.com",
  secFetchSite: null,
  origin: null,
} as const;

describe("checkRequestOrigin", () => {
  it("lets safe methods, non-API paths and bearer-token APIs through", () => {
    expect(checkRequestOrigin({ ...base, method: "GET", pathname: "/api/x" })).toEqual({
      ok: true,
      reason: "safe_method",
    });
    expect(checkRequestOrigin({ ...base, method: "POST", pathname: "/login" })).toEqual({
      ok: true,
      reason: "not_api",
    });
    expect(
      checkRequestOrigin({ ...base, method: "POST", pathname: "/api/mobile/v1/sync" }).ok,
    ).toBe(true);
    expect(checkRequestOrigin({ ...base, method: "POST", pathname: "/api/jobs/tick" }).ok).toBe(
      true,
    );
    expect(isOriginCheckExempt("/api/mobile")).toBe(true);
    expect(isOriginCheckExempt("/api/mobilex")).toBe(false);
  });

  it("requires the exact APP_URL origin on mutating API calls", () => {
    expect(
      checkRequestOrigin({
        ...base,
        method: "POST",
        pathname: "/api/auth/login",
        origin: "https://app.example.com",
      }),
    ).toEqual({ ok: true, reason: "origin_match" });
    expect(
      checkRequestOrigin({
        ...base,
        method: "DELETE",
        pathname: "/api/x",
        origin: "https://evil.example",
      }),
    ).toEqual({ ok: false, reason: "origin_mismatch" });
    expect(
      checkRequestOrigin({
        ...base,
        method: "POST",
        pathname: "/api/x",
        origin: "https://app.example.com.evil.example",
      }).ok,
    ).toBe(false);
  });

  it("accepts a missing Origin only for same-origin Sec-Fetch-Site", () => {
    expect(
      checkRequestOrigin({
        ...base,
        method: "POST",
        pathname: "/api/x",
        secFetchSite: "same-origin",
      }).ok,
    ).toBe(true);
    expect(
      checkRequestOrigin({
        ...base,
        method: "POST",
        pathname: "/api/x",
        secFetchSite: "cross-site",
      }),
    ).toEqual({
      ok: false,
      reason: "origin_missing",
    });
    expect(checkRequestOrigin({ ...base, method: "POST", pathname: "/api/x" }).ok).toBe(false);
    expect(
      checkRequestOrigin({ ...base, method: "POST", pathname: "/api/x", origin: "null" }).ok,
    ).toBe(false);
  });

  it("treats the opaque null origin as a mismatch even with Sec-Fetch-Site: same-origin", () => {
    expect(
      checkRequestOrigin({
        ...base,
        method: "POST",
        pathname: "/api/auth/login",
        origin: "null",
        secFetchSite: "same-origin",
      }),
    ).toEqual({ ok: false, reason: "origin_mismatch" });
  });
});
