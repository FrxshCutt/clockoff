import { SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { env, resetEnvCache } from "@/lib/env";
import {
  MOBILE_JWT_AUDIENCE,
  MOBILE_JWT_ISSUER,
  signMobileAccessToken,
  verifyMobileAccessToken,
} from "./tokens";

const claims = { sub: "mobile-user", dev: "device", emp: "employee", org: "organisation" };
const secret = () => new TextEncoder().encode(env().MOBILE_JWT_SECRET);

afterEach(() => {
  delete process.env.MOBILE_JWT_KEY_ID;
  resetEnvCache();
});

describe("mobile access tokens", () => {
  it("are HS256 JWTs with kid, iss, aud, exp and the device claims", async () => {
    const now = new Date();
    const { token, expiresAt } = await signMobileAccessToken(claims, now);
    const [header] = token.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
      alg: "HS256",
      kid: env().MOBILE_JWT_KEY_ID,
      typ: "JWT",
    });
    expect(Math.round((expiresAt.getTime() - now.getTime()) / 1000)).toBeLessThanOrEqual(
      env().MOBILE_ACCESS_TOKEN_TTL_SECONDS,
    );
    expect(await verifyMobileAccessToken(token)).toEqual(claims);
  });

  it("rejects expired, wrong-audience, wrong-key-id and tampered tokens", async () => {
    const past = new Date(Date.now() - 2 * 86_400_000);
    const expired = await signMobileAccessToken(claims, past);
    await expect(verifyMobileAccessToken(expired.token)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      message: "Access token expired",
    });

    const wrongAud = await new SignJWT({ dev: "d", emp: "e", org: "o" })
      .setProtectedHeader({ alg: "HS256", kid: env().MOBILE_JWT_KEY_ID })
      .setSubject("s")
      .setIssuer(MOBILE_JWT_ISSUER)
      .setAudience("someone-else")
      .setExpirationTime("5m")
      .sign(secret());
    await expect(verifyMobileAccessToken(wrongAud)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });

    const missingClaims = await new SignJWT({ dev: "d" })
      .setProtectedHeader({ alg: "HS256", kid: env().MOBILE_JWT_KEY_ID })
      .setSubject("s")
      .setIssuer(MOBILE_JWT_ISSUER)
      .setAudience(MOBILE_JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(secret());
    await expect(verifyMobileAccessToken(missingClaims)).rejects.toMatchObject({
      message: "Access token is missing claims",
    });

    const { token } = await signMobileAccessToken(claims);
    await expect(verifyMobileAccessToken(`${token}x`)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    await expect(verifyMobileAccessToken("not.a.jwt")).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });

    const wrongIssuer = await new SignJWT({ dev: "d", emp: "e", org: "o" })
      .setProtectedHeader({ alg: "HS256", kid: env().MOBILE_JWT_KEY_ID })
      .setSubject("s")
      .setIssuer("someone-else")
      .setAudience(MOBILE_JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(secret());
    await expect(verifyMobileAccessToken(wrongIssuer)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });

    process.env.MOBILE_JWT_KEY_ID = "rotated";
    resetEnvCache();
    await expect(verifyMobileAccessToken(token)).rejects.toMatchObject({
      message: "Unknown signing key",
    });
  });

  it("rejects `alg: none`, other algorithms and tokens without exp / iat even when the key id matches", async () => {
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const nowSeconds = Math.floor(Date.now() / 1000);
    const payload = {
      sub: "s",
      dev: "d",
      emp: "e",
      org: "o",
      iss: MOBILE_JWT_ISSUER,
      aud: MOBILE_JWT_AUDIENCE,
      iat: nowSeconds,
      exp: nowSeconds + 300,
    };

    const unsigned = `${b64({ alg: "none", kid: env().MOBILE_JWT_KEY_ID, typ: "JWT" })}.${b64(payload)}.`;
    await expect(verifyMobileAccessToken(unsigned)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      message: "Invalid access token",
    });

    const hs512 = await new SignJWT({ dev: "d", emp: "e", org: "o" })
      .setProtectedHeader({ alg: "HS512", kid: env().MOBILE_JWT_KEY_ID })
      .setSubject("s")
      .setIssuer(MOBILE_JWT_ISSUER)
      .setAudience(MOBILE_JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(secret());
    await expect(verifyMobileAccessToken(hs512)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      message: "Invalid access token",
    });

    const neverExpires = await new SignJWT({ dev: "d", emp: "e", org: "o" })
      .setProtectedHeader({ alg: "HS256", kid: env().MOBILE_JWT_KEY_ID })
      .setSubject("s")
      .setIssuer(MOBILE_JWT_ISSUER)
      .setAudience(MOBILE_JWT_AUDIENCE)
      .setIssuedAt()
      .sign(secret());
    await expect(verifyMobileAccessToken(neverExpires)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });

    const noIssuedAt = await new SignJWT({ dev: "d", emp: "e", org: "o" })
      .setProtectedHeader({ alg: "HS256", kid: env().MOBILE_JWT_KEY_ID })
      .setSubject("s")
      .setIssuer(MOBILE_JWT_ISSUER)
      .setAudience(MOBILE_JWT_AUDIENCE)
      .setExpirationTime("5m")
      .sign(secret());
    await expect(verifyMobileAccessToken(noIssuedAt)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });
});
