import { prisma, type Device, type Prisma, type RefreshToken } from "@clockoff/db";
import { AppError } from "@clockoff/shared/errors";
import { SignJWT, decodeProtectedHeader, errors as joseErrors, jwtVerify } from "jose";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { DAY_MS, generateToken, hashToken } from "@/lib/tokens";
import { assertDeviceUsable } from "./deviceUsable";

/**
 * Mobile (employee device) authentication.
 *
 * - Access token: HS256 JWT (`MOBILE_JWT_SECRET`, header `kid` = `MOBILE_JWT_KEY_ID`), 15 min by default.
 *   Claims: sub = mobileUserId, dev = deviceId, emp = employeeId, org = organisationId,
 *   iss "clockoff", aud "clockoff-mobile".
 * - Refresh token: 32 random bytes (base64url), stored as sha256 in `refresh_tokens` with a `familyId`.
 *   Rotation marks the old row `replacedById`; presenting a replaced or revoked token is reuse and
 *   revokes the whole family (an attacker and the victim both lose access; the app re-joins).
 */

export const MOBILE_JWT_ISSUER = "clockoff";
export const MOBILE_JWT_AUDIENCE = "clockoff-mobile";

export interface MobileAccessClaims {
  /** mobileUserId */
  sub: string;
  /** deviceId */
  dev: string;
  /** employeeId */
  emp: string;
  /** organisationId */
  org: string;
}

export interface IssuedMobileTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
}

export type DeviceIdentity = Pick<Device, "id" | "mobileUserId" | "employeeId" | "organisationId">;

type Db = Prisma.TransactionClient | typeof prisma;

function secretKey(): Uint8Array {
  return new TextEncoder().encode(env().MOBILE_JWT_SECRET);
}

export async function signMobileAccessToken(
  claims: MobileAccessClaims,
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const e = env();
  const iat = Math.floor(now.getTime() / 1_000);
  const exp = iat + e.MOBILE_ACCESS_TOKEN_TTL_SECONDS;
  const token = await new SignJWT({ dev: claims.dev, emp: claims.emp, org: claims.org })
    .setProtectedHeader({ alg: "HS256", kid: e.MOBILE_JWT_KEY_ID, typ: "JWT" })
    .setSubject(claims.sub)
    .setIssuer(MOBILE_JWT_ISSUER)
    .setAudience(MOBILE_JWT_AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(secretKey());
  return { token, expiresAt: new Date(exp * 1_000) };
}

/** Verify signature, issuer, audience, expiry and key id. Throws `UNAUTHENTICATED`. */
export async function verifyMobileAccessToken(token: string): Promise<MobileAccessClaims> {
  const e = env();
  let kid: string | undefined;
  try {
    kid = decodeProtectedHeader(token).kid;
  } catch {
    throw new AppError("UNAUTHENTICATED", "Malformed access token");
  }
  if (kid !== e.MOBILE_JWT_KEY_ID) throw new AppError("UNAUTHENTICATED", "Unknown signing key");

  try {
    // `algorithms` pins HS256 (an `alg: none` or any other algorithm is rejected before the signature
    // check); `requiredClaims` makes `exp` mandatory (jose only checks `exp` when present).
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: MOBILE_JWT_ISSUER,
      audience: MOBILE_JWT_AUDIENCE,
      algorithms: ["HS256"],
      requiredClaims: ["exp", "iat", "sub"],
    });
    const { sub, dev, emp, org } = payload as Record<string, unknown>;
    if ([sub, dev, emp, org].some((v) => typeof v !== "string" || v.length === 0)) {
      throw new AppError("UNAUTHENTICATED", "Access token is missing claims");
    }
    return { sub: sub as string, dev: dev as string, emp: emp as string, org: org as string };
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof joseErrors.JWTExpired)
      throw new AppError("UNAUTHENTICATED", "Access token expired");
    throw new AppError("UNAUTHENTICATED", "Invalid access token");
  }
}

function refreshTtlMs(): number {
  return env().MOBILE_REFRESH_TOKEN_TTL_DAYS * DAY_MS;
}

async function createRefreshTokenRow(
  device: DeviceIdentity,
  familyId: string | undefined,
  db: Db,
): Promise<{ raw: string; row: RefreshToken }> {
  const { raw, hash } = generateToken(32);
  const row = await db.refreshToken.create({
    data: {
      deviceId: device.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + refreshTtlMs()),
      ...(familyId ? { familyId } : {}),
    },
  });
  return { raw, row };
}

/**
 * Issue a fresh access + refresh token pair for a device (join/confirm, or after rotation).
 * A new refresh-token family starts unless `familyId` is given.
 */
export async function issueMobileTokens(
  device: DeviceIdentity,
  options: { familyId?: string; db?: Db } = {},
): Promise<IssuedMobileTokens> {
  const db = options.db ?? prisma;
  const [{ token: accessToken, expiresAt: accessTokenExpiresAt }, refresh] = await Promise.all([
    signMobileAccessToken({
      sub: device.mobileUserId,
      dev: device.id,
      emp: device.employeeId,
      org: device.organisationId,
    }),
    createRefreshTokenRow(device, options.familyId, db),
  ]);
  return {
    accessToken,
    refreshToken: refresh.raw,
    accessTokenExpiresAt,
    refreshTokenExpiresAt: refresh.row.expiresAt,
  };
}

export async function revokeRefreshTokenFamily(familyId: string, db: Db = prisma): Promise<number> {
  const result = await db.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

/** Revoke every live refresh token of a device (deactivation, unlink, sign-out). */
export async function revokeDeviceTokens(deviceId: string, db: Db = prisma): Promise<number> {
  const result = await db.refreshToken.updateMany({
    where: { deviceId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

export interface RotatedMobileTokens extends IssuedMobileTokens {
  device: Device;
}

/**
 * Exchange a refresh token for a new pair. Detects reuse (token already rotated or revoked) and
 * revokes the entire family, throwing `TOKEN_REUSED` (401). Fails with `TOKEN_EXPIRED` (401) for an
 * expired token and with `DEVICE_INACTIVE` / `UNAUTHENTICATED` when the device, its employee or its
 * organisation is no longer usable (see `assertDeviceUsable`).
 */
export async function rotateRefreshToken(rawToken: string): Promise<RotatedMobileTokens> {
  if (!rawToken || rawToken.length > 256)
    throw new AppError("UNAUTHENTICATED", "Invalid refresh token");
  const found = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { device: { include: { employee: true, organisation: true } } },
  });
  if (!found) throw new AppError("UNAUTHENTICATED", "Invalid refresh token");
  const { employee, organisation, ...device } = found.device;
  const existing = { ...found, device };

  if (existing.revokedAt || existing.replacedById) {
    const revoked = await revokeRefreshTokenFamily(existing.familyId);
    logger.warn(
      { deviceId: existing.deviceId, familyId: existing.familyId, revoked },
      "refresh token reuse detected",
    );
    throw new AppError("TOKEN_REUSED", "Refresh token was already used; sign in again");
  }
  if (existing.expiresAt.getTime() <= Date.now()) {
    throw new AppError("TOKEN_EXPIRED", "Refresh token expired", { status: 401 });
  }
  // Same rule as access tokens: inactive device, deactivated/deleted employee or deleted organisation.
  assertDeviceUsable({ isActive: device.isActive, employee, organisation });

  const issued = await prisma.$transaction(async (tx) => {
    const next = await createRefreshTokenRow(existing.device, existing.familyId, tx);
    // Compare-and-set: only one concurrent rotation of the same token can flip `replacedById` from
    // null. Postgres re-evaluates the WHERE after acquiring the row lock, so the loser sees count 0.
    const claimed = await tx.refreshToken.updateMany({
      where: { id: existing.id, replacedById: null, revokedAt: null },
      data: { replacedById: next.row.id },
    });
    if (claimed.count !== 1) return null;
    const access = await signMobileAccessToken({
      sub: existing.device.mobileUserId,
      dev: existing.device.id,
      emp: existing.device.employeeId,
      org: existing.device.organisationId,
    });
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: next.raw,
      refreshTokenExpiresAt: next.row.expiresAt,
    };
  });
  if (!issued) {
    // Lost the race: the same refresh token was presented twice concurrently — treat as reuse.
    await revokeRefreshTokenFamily(existing.familyId);
    logger.warn(
      { deviceId: existing.deviceId, familyId: existing.familyId },
      "concurrent refresh token reuse",
    );
    throw new AppError("TOKEN_REUSED", "Refresh token was already used; sign in again");
  }
  return { ...issued, device: existing.device };
}
