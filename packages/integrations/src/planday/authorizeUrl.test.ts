import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAuthorizeUrl, pkceCodeChallenge } from "./authorizeUrl";

const REDIRECT = "https://app.clockoff.online/api/integrations/planday/callback";

describe("buildAuthorizeUrl (§5.2)", () => {
  it("builds the documented URL with the full scope list plus openid offline_access", () => {
    const url = buildAuthorizeUrl({
      clientId: "clockoff-app-id",
      redirectUri: REDIRECT,
      state: "nonce.sig",
    });
    expect(url).toBe(
      "https://id.planday.com/connect/authorize?client_id=clockoff-app-id&response_type=code" +
        "&redirect_uri=https%3A%2F%2Fapp.clockoff.online%2Fapi%2Fintegrations%2Fplanday%2Fcallback" +
        "&scope=openid%20offline_access%20department%3Aread%20employeegroup%3Aread%20employee%3Aread%20shift%3Aread%20punchclockshift%3Aread" +
        "&state=nonce.sig",
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(parsed.searchParams.get("scope")).toBe(
      "openid offline_access department:read employeegroup:read employee:read shift:read punchclockshift:read",
    );
    expect(parsed.searchParams.has("code_challenge")).toBe(false);
  });

  it("adds S256 PKCE only when a challenge is given", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "c",
        redirectUri: REDIRECT,
        state: "s",
        codeChallenge: "abc_-123",
      }),
    );
    expect(url.searchParams.get("code_challenge")).toBe("abc_-123");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("uses the mock's authorize route when the transport gives one", () => {
    const url = buildAuthorizeUrl({
      clientId: "c",
      redirectUri: "http://localhost:3000/api/integrations/planday/callback",
      state: "s",
      authorizeBaseUrl: "http://localhost:3000/api/dev/mock-planday/authorize",
    });
    expect(
      url.startsWith("http://localhost:3000/api/dev/mock-planday/authorize?client_id=c&"),
    ).toBe(true);
  });

  it("requires client id, redirect URI and state", () => {
    expect(() => buildAuthorizeUrl({ clientId: "", redirectUri: REDIRECT, state: "s" })).toThrow(
      TypeError,
    );
    expect(() => buildAuthorizeUrl({ clientId: "c", redirectUri: "", state: "s" })).toThrow(
      TypeError,
    );
    expect(() => buildAuthorizeUrl({ clientId: "c", redirectUri: REDIRECT, state: "" })).toThrow(
      TypeError,
    );
  });
});

describe("pkceCodeChallenge", () => {
  it("is base64url(sha256(verifier)) (RFC 7636 appendix B)", () => {
    expect(pkceCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    const verifier = "x".repeat(64);
    expect(pkceCodeChallenge(verifier)).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
  });
});
