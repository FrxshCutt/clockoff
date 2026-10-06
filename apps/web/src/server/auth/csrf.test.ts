import { describe, expect, it } from "vitest";
import { createCsrfToken } from "@/lib/crypto";
import { env } from "@/lib/env";
import { assertCsrf, ensureCsrfToken } from "./csrf";

function req(method: string, headers: Record<string, string>): Request {
  return new Request("http://localhost:3000/api/x", { method, headers });
}

describe("assertCsrf", () => {
  const token = createCsrfToken();

  it("ignores safe methods", () => {
    expect(() => assertCsrf(req("GET", {}))).not.toThrow();
  });

  it("accepts a matching signed cookie + header from the app origin", () => {
    expect(() =>
      assertCsrf(
        req("POST", {
          cookie: `wm_csrf=${token}`,
          "x-csrf-token": token,
          origin: env().APP_ORIGIN,
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertCsrf(req("PATCH", { cookie: `wm_csrf=${token}`, "x-csrf-token": token })),
    ).not.toThrow();
  });

  it("rejects missing / mismatched tokens and foreign origins", () => {
    expect(() => assertCsrf(req("POST", { cookie: `wm_csrf=${token}` }))).toThrow(/CSRF/);
    expect(() => assertCsrf(req("POST", { "x-csrf-token": token }))).toThrow(/CSRF/);
    expect(() =>
      assertCsrf(req("DELETE", { cookie: `wm_csrf=${token}`, "x-csrf-token": createCsrfToken() })),
    ).toThrow();
    expect(() =>
      assertCsrf(
        req("POST", {
          cookie: `wm_csrf=${token}`,
          "x-csrf-token": token,
          origin: "https://evil.example",
        }),
      ),
    ).toThrow(/origin/);
  });
});

describe("ensureCsrfToken", () => {
  it("reuses a valid cookie and mints a new one otherwise", () => {
    const token = createCsrfToken();
    expect(ensureCsrfToken(req("GET", { cookie: `wm_csrf=${token}` }))).toEqual({ token });
    const minted = ensureCsrfToken(req("GET", { cookie: "wm_csrf=forged.value" }));
    expect(minted.token).not.toBe("forged.value");
    expect(minted.setCookie).toContain(`wm_csrf=${encodeURIComponent(minted.token)}`);
  });
});
