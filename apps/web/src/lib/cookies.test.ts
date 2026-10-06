import { afterEach, describe, expect, it } from "vitest";
import {
  CSRF_COOKIE,
  ORG_COOKIE,
  SESSION_COOKIE,
  appendSetCookies,
  clearAuthCookies,
  csrfCookie,
  orgCookie,
  parseCookieHeader,
  serializeCookie,
  sessionCookie,
} from "./cookies";
import { resetEnvCache } from "./env";

const original = { NODE_ENV: process.env.NODE_ENV, APP_URL: process.env.APP_URL };

function restore(key: keyof typeof original): void {
  const value = original[key];
  if (value === undefined) delete (process.env as Record<string, string | undefined>)[key];
  else (process.env as Record<string, string | undefined>)[key] = value;
}

afterEach(() => {
  restore("NODE_ENV");
  restore("APP_URL");
  resetEnvCache();
});

describe("cookies", () => {
  it("session cookie is httpOnly, SameSite=Lax, path /, with a max-age of SESSION_TTL_DAYS", () => {
    process.env.APP_URL = "http://localhost:3000";
    resetEnvCache();
    const header = sessionCookie("tok");
    expect(header).toMatch(/^wm_session=tok; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax$/);
    expect(header).not.toContain("Secure");
  });

  it("is Secure in production / over https", () => {
    process.env.APP_URL = "https://app.example.com";
    resetEnvCache();
    expect(sessionCookie("tok")).toContain("; Secure");
    expect(csrfCookie("c")).toContain("; Secure");
  });

  it("CSRF cookie is readable by scripts; org cookie is httpOnly", () => {
    expect(csrfCookie("c")).not.toContain("HttpOnly");
    expect(orgCookie("o")).toContain("HttpOnly");
  });

  it("clearing expires every auth cookie", () => {
    const cleared = clearAuthCookies();
    expect(cleared.map((c) => c.split("=")[0])).toEqual([SESSION_COOKIE, CSRF_COOKIE, ORG_COOKIE]);
    for (const c of cleared) expect(c).toContain("Max-Age=0");
  });

  it("serialises and parses round-trip, first occurrence wins", () => {
    expect(serializeCookie("a", "b c;", { maxAge: 10.7 })).toBe(
      "a=b%20c%3B; Path=/; Max-Age=10; SameSite=Lax",
    );
    const parsed = parseCookieHeader("a=b%20c%3B; wm_session=one; wm_session=two; broken; =x");
    expect(parsed.get("a")).toBe("b c;");
    expect(parsed.get("wm_session")).toBe("one");
    expect(parseCookieHeader(null).size).toBe(0);
  });

  it("appendSetCookies adds multiple Set-Cookie headers", () => {
    const res = appendSetCookies(new Response(null), ["a=1", "b=2"]);
    expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  });
});
