import { prisma } from "@workmode/db";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { env } from "@/lib/env";
import { hashToken } from "@/lib/tokens";
import { createHandler } from "@/server/http/apiHandler";
import {
  issueMobileTokens,
  revokeDeviceTokens,
  rotateRefreshToken,
  signMobileAccessToken,
} from "@/server/mobileAuth";
import { getCurrentDeviceContext } from "@/server/tenancy/context";
import { callRoute, createTestDevice, createTestOrg, type ErrorBody } from "../helpers";

function bearer(token: string): NextRequest {
  return new NextRequest(new URL("/api/mobile/v1/me", env().APP_URL), {
    headers: { authorization: `Bearer ${token}` },
  });
}

async function expectAppError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "AppError", code });
}

describe("mobile tokens", () => {
  it("issue → device context → refresh → rotation → reuse detection revokes the family", async () => {
    const org = await createTestOrg();
    const { device, employee, mobileUser } = await createTestDevice(org.organisation.id);

    const issued = await issueMobileTokens(device);
    expect(issued.accessToken.split(".")).toHaveLength(3);
    expect(issued.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.accessTokenExpiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
      env().MOBILE_ACCESS_TOKEN_TTL_SECONDS * 1000,
    );
    const stored = await prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hashToken(issued.refreshToken) },
    });
    expect(stored.deviceId).toBe(device.id);

    const ctx = await getCurrentDeviceContext(bearer(issued.accessToken));
    expect(ctx.device.id).toBe(device.id);
    expect(ctx.employee.id).toBe(employee.id);
    expect(ctx.mobileUser.id).toBe(mobileUser.id);
    expect(ctx.organisation.id).toBe(org.organisation.id);

    const rotated = await rotateRefreshToken(issued.refreshToken);
    expect(rotated.refreshToken).not.toBe(issued.refreshToken);
    const second = await prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hashToken(rotated.refreshToken) },
    });
    expect(second.familyId).toBe(stored.familyId);
    expect(
      (await prisma.refreshToken.findUniqueOrThrow({ where: { id: stored.id } })).replacedById,
    ).toBe(second.id);

    const rotatedAgain = await rotateRefreshToken(rotated.refreshToken);
    expect(rotatedAgain.refreshToken).toBeTruthy();

    // Replaying the first (already rotated) token is reuse: the whole family dies.
    await expectAppError(rotateRefreshToken(issued.refreshToken), "TOKEN_REUSED");
    const live = await prisma.refreshToken.count({
      where: { familyId: stored.familyId, revokedAt: null },
    });
    expect(live).toBe(0);
    await expectAppError(rotateRefreshToken(rotatedAgain.refreshToken), "TOKEN_REUSED");
  });

  it("concurrent use of one refresh token is treated as reuse", async () => {
    const org = await createTestOrg();
    const { device } = await createTestDevice(org.organisation.id);
    const issued = await issueMobileTokens(device);
    const results = await Promise.allSettled([
      rotateRefreshToken(issued.refreshToken),
      rotateRefreshToken(issued.refreshToken),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeLessThanOrEqual(1);
    const familyId = (
      await prisma.refreshToken.findUniqueOrThrow({
        where: { tokenHash: hashToken(issued.refreshToken) },
      })
    ).familyId;
    if (fulfilled.length === 1) {
      // The loser revoked the family, so even the winner's new token is dead.
      expect(await prisma.refreshToken.count({ where: { familyId, revokedAt: null } })).toBe(0);
    }
  });

  it("rejects unknown, expired and deactivated-device tokens", async () => {
    const org = await createTestOrg();
    const { device } = await createTestDevice(org.organisation.id);
    await expectAppError(rotateRefreshToken("not-a-real-token"), "UNAUTHENTICATED");

    const issued = await issueMobileTokens(device);
    await prisma.refreshToken.updateMany({
      where: { deviceId: device.id },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    await expectAppError(rotateRefreshToken(issued.refreshToken), "TOKEN_EXPIRED");

    const fresh = await issueMobileTokens(device);
    await prisma.device.update({ where: { id: device.id }, data: { isActive: false } });
    await expectAppError(rotateRefreshToken(fresh.refreshToken), "DEVICE_INACTIVE");
    await expectAppError(getCurrentDeviceContext(bearer(fresh.accessToken)), "DEVICE_INACTIVE");
  });

  it("refresh fails once the employee is deactivated or deleted, or the organisation is deleted", async () => {
    const org = await createTestOrg();
    const { device, employee } = await createTestDevice(org.organisation.id);

    const beforeDeactivation = await issueMobileTokens(device);
    await prisma.employee.update({
      where: { id: employee.id },
      data: { employmentStatus: "INACTIVE" },
    });
    await expectAppError(rotateRefreshToken(beforeDeactivation.refreshToken), "DEVICE_INACTIVE");
    await expectAppError(
      getCurrentDeviceContext(bearer(beforeDeactivation.accessToken)),
      "DEVICE_INACTIVE",
    );

    await prisma.employee.update({
      where: { id: employee.id },
      data: { employmentStatus: "ACTIVE", deletedAt: new Date() },
    });
    const beforeDeletion = await issueMobileTokens(device);
    await expectAppError(rotateRefreshToken(beforeDeletion.refreshToken), "UNAUTHENTICATED");

    await prisma.employee.update({ where: { id: employee.id }, data: { deletedAt: null } });
    await prisma.organisation.update({
      where: { id: org.organisation.id },
      data: { deletedAt: new Date() },
    });
    const beforeOrgDeletion = await issueMobileTokens(device);
    await expectAppError(rotateRefreshToken(beforeOrgDeletion.refreshToken), "UNAUTHENTICATED");
    // A rejected refresh does not consume the token (no new row in the family).
    const family = await prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hashToken(beforeOrgDeletion.refreshToken) },
    });
    expect(family.replacedById).toBeNull();
  });

  it("revokeDeviceTokens kills every refresh token of the device", async () => {
    const org = await createTestOrg();
    const { device } = await createTestDevice(org.organisation.id);
    const a = await issueMobileTokens(device);
    await issueMobileTokens(device);
    expect(await revokeDeviceTokens(device.id)).toBe(2);
    await expectAppError(rotateRefreshToken(a.refreshToken), "TOKEN_REUSED");
  });

  it("access tokens must match the device row and be signed with the current key", async () => {
    const orgA = await createTestOrg();
    const orgB = await createTestOrg();
    const { device } = await createTestDevice(orgA.organisation.id);
    // Claims pointing the device at another organisation are rejected.
    const forged = await signMobileAccessToken({
      sub: device.mobileUserId,
      dev: device.id,
      emp: device.employeeId,
      org: orgB.organisation.id,
    });
    await expectAppError(getCurrentDeviceContext(bearer(forged.token)), "UNAUTHENTICATED");
    await expectAppError(getCurrentDeviceContext(bearer("garbage")), "UNAUTHENTICATED");
  });

  it("createHandler({ auth: 'mobile' }) exposes the device context and rejects missing tokens", async () => {
    const org = await createTestOrg();
    const { device } = await createTestDevice(org.organisation.id);
    const handler = createHandler({ auth: "mobile" }, async ({ ctx }) => ({
      deviceId: ctx.device.id,
      organisationId: ctx.organisation.id,
    }));
    const { accessToken } = await issueMobileTokens(device);
    const ok = await callRoute<{ deviceId: string; organisationId: string }>(handler, {
      path: "/api/mobile/v1/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(ok.body).toEqual({ deviceId: device.id, organisationId: org.organisation.id });
    const missing = await callRoute<ErrorBody>(handler, { path: "/api/mobile/v1/me" });
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe("UNAUTHENTICATED");
  });
});
