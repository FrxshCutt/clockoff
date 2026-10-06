import { prisma } from "@workmode/db";
import type { DeviceResponse, ListDevicesResponse } from "@workmode/validation/devices";
import { describe, expect, it } from "vitest";
import { POST as deactivateRoute } from "@/app/api/devices/[id]/deactivate/route";
import { GET as getDeviceRoute } from "@/app/api/devices/[id]/route";
import { GET as listDevicesRoute } from "@/app/api/devices/route";
import { GET as meRoute } from "@/app/api/mobile/v1/me/route";
import { getEventBus, type RealtimeEvent } from "@/server/events";
import { issueMobileTokens, rotateRefreshToken } from "@/server/mobileAuth";
import {
  addMember,
  callRoute,
  createTestDevice,
  createTestOrg,
  createTestUser,
  loginAs,
  type CookieJar,
  type ErrorBody,
} from "../helpers";

async function setup() {
  const org = await createTestOrg();
  const jar = await loginAs(org.owner, { organisationId: org.organisation.id });
  return { org, jar };
}

async function list(
  jar: CookieJar,
  query: Record<string, string | number | boolean | undefined> = {},
) {
  const res = await callRoute<ListDevicesResponse>(listDevicesRoute, {
    path: "/api/devices",
    query,
    jar,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

describe("GET /api/devices", () => {
  it("lists devices with the §12 summary, the employee and a derived badge; filters and paginates", async () => {
    const { org, jar } = await setup();
    const location = await prisma.location.create({
      data: { organisationId: org.organisation.id, name: "Dock" },
    });
    const a = await createTestDevice(org.organisation.id);
    const b = await createTestDevice(org.organisation.id);
    await prisma.employee.update({
      where: { id: b.employee.id },
      data: { primaryLocationId: location.id },
    });
    await prisma.device.update({
      where: { id: b.device.id },
      data: {
        permissionState: "APPROVED",
        selectionState: "CONFIGURED",
        selectionAppCount: 7,
        pushTokenEncrypted: new Uint8Array([9, 9, 9]),
        lastDeviceSyncAt: new Date(),
        restrictionEngineState: "OFF_SHIFT",
      },
    });
    // Archived employees' devices are hidden.
    const archived = await createTestDevice(org.organisation.id);
    await prisma.employee.update({
      where: { id: archived.employee.id },
      data: { deletedAt: new Date() },
    });

    const all = await list(jar);
    expect(all).toMatchObject({ page: 1, pageSize: 25, total: 2, totalPages: 1 });
    const itemA = all.items.find((i) => i.device.id === a.device.id)!;
    const itemB = all.items.find((i) => i.device.id === b.device.id)!;
    expect(itemA.device).toMatchObject({
      platform: "IOS",
      permissionState: "NOT_DETERMINED",
      selectionState: "NONE",
      selectionCounts: { categories: 0, applications: 0, webDomains: 0 },
      hasPushToken: false,
      isActive: true,
    });
    expect(itemA.device).not.toHaveProperty("pushTokenEncrypted");
    expect(itemA.employee).toMatchObject({
      id: a.employee.id,
      firstName: "Test",
      inviteStatus: "NOT_INVITED",
    });
    expect(itemA.status).toMatchObject({ badge: "PERMISSIONS_MISSING", severity: "warning" });
    expect(itemB.device).toMatchObject({
      hasPushToken: true,
      selectionCounts: { applications: 7 },
    });
    expect(itemB.employee.primaryLocation).toEqual({ id: location.id, name: "Dock" });
    expect(itemB.status).toMatchObject({ badge: "OFF_SHIFT", severity: "ok" });

    expect((await list(jar, { employeeId: a.employee.id })).items.map((i) => i.device.id)).toEqual([
      a.device.id,
    ]);
    expect((await list(jar, { locationId: location.id })).items.map((i) => i.device.id)).toEqual([
      b.device.id,
    ]);
    expect(
      (await list(jar, { permissionState: "APPROVED" })).items.map((i) => i.device.id),
    ).toEqual([b.device.id]);
    expect((await list(jar, { isActive: false })).total).toBe(0);
    const paged = await list(jar, { pageSize: 1, page: 2 });
    expect(paged).toMatchObject({ page: 2, pageSize: 1, total: 2, totalPages: 2 });
    expect(paged.items).toHaveLength(1);
  });

  it("ignores filters that name another tenant's employee or location", async () => {
    const { jar } = await setup();
    const other = await createTestOrg();
    const { employee } = await createTestDevice(other.organisation.id);
    const location = await prisma.location.create({
      data: { organisationId: other.organisation.id, name: "Elsewhere" },
    });
    await prisma.employee.update({
      where: { id: employee.id },
      data: { primaryLocationId: location.id },
    });

    expect(await list(jar, { employeeId: employee.id })).toMatchObject({ items: [], total: 0 });
    expect(await list(jar, { locationId: location.id })).toMatchObject({ items: [], total: 0 });
  });

  it("rejects an invalid query", async () => {
    const { jar } = await setup();
    const res = await callRoute<ErrorBody>(listDevicesRoute, {
      path: "/api/devices",
      query: { isActive: "maybe" },
      jar,
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/devices/:id", () => {
  it("returns one device or 404", async () => {
    const { org, jar } = await setup();
    const { device, employee } = await createTestDevice(org.organisation.id);
    const res = await callRoute<DeviceResponse>(getDeviceRoute, {
      path: `/api/devices/${device.id}`,
      params: { id: device.id },
      jar,
    });
    expect(res.status).toBe(200);
    expect(res.body.device.id).toBe(device.id);
    expect(res.body.employee.id).toBe(employee.id);

    const missing = await callRoute<ErrorBody>(getDeviceRoute, {
      path: "/api/devices/00000000-0000-4000-8000-000000000001",
      params: { id: "00000000-0000-4000-8000-000000000001" },
      jar,
    });
    expect(missing.status).toBe(404);
    const notUuid = await callRoute<ErrorBody>(getDeviceRoute, {
      path: "/api/devices/abc",
      params: { id: "abc" },
      jar,
    });
    expect(notUuid.status).toBe(400);
  });
});

describe("POST /api/devices/:id/deactivate", () => {
  it("deactivates, revokes refresh tokens, forgets the push token, re-derives the invite status and audits", async () => {
    const { org } = await setup();
    const { user: manager } = await createTestUser();
    await addMember(org.organisation.id, manager, "MANAGER");
    const jar = await loginAs(manager, { organisationId: org.organisation.id });
    const { device, employee } = await createTestDevice(org.organisation.id);
    await prisma.device.update({
      where: { id: device.id },
      data: {
        pushTokenEncrypted: new Uint8Array([1, 2, 3]),
        permissionState: "APPROVED",
        selectionState: "CONFIGURED",
      },
    });
    await prisma.employee.update({
      where: { id: employee.id },
      data: { inviteStatus: "CONNECTED" },
    });
    await issueMobileTokens(device);
    await issueMobileTokens(device);
    const events: RealtimeEvent[] = [];
    getEventBus().subscribe(org.organisation.id, (event) => events.push(event));

    const res = await callRoute<DeviceResponse>(deactivateRoute, {
      method: "POST",
      path: `/api/devices/${device.id}/deactivate`,
      params: { id: device.id },
      jar,
      body: { reason: "Phone reported lost" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.device).toMatchObject({ isActive: false, hasPushToken: false });
    expect(res.body.device.deactivatedAt).toEqual(expect.any(String));
    expect(res.body.employee.inviteStatus).toBe("DEACTIVATED");
    expect(res.body.status).toBeNull();

    const tokens = await prisma.refreshToken.findMany({ where: { deviceId: device.id } });
    expect(tokens).toHaveLength(2);
    expect(tokens.every((t) => t.revokedAt !== null)).toBe(true);
    const row = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
    expect(row.pushTokenEncrypted).toBeNull();
    expect(
      (await prisma.employee.findUniqueOrThrow({ where: { id: employee.id } })).inviteStatus,
    ).toBe("DEACTIVATED");

    const auditRow = await prisma.auditLog.findFirst({
      where: {
        organisationId: org.organisation.id,
        action: "device.deactivated",
        entityId: device.id,
      },
    });
    expect(auditRow?.actorUserId).toBe(manager.id);
    expect(auditRow?.after).toMatchObject({
      isActive: false,
      revokedTokens: 2,
      pushTokenRemoved: true,
      inviteStatus: "DEACTIVATED",
      reason: "Phone reported lost",
    });
    expect(events.find((e) => e.type === "device.status.changed")?.payload).toMatchObject({
      deviceId: device.id,
      employeeId: employee.id,
      isActive: false,
    });
    expect(await prisma.activityEvent.count({ where: { deviceId: device.id } })).toBe(0);

    // Idempotent: nothing more is written.
    const again = await callRoute<DeviceResponse>(deactivateRoute, {
      method: "POST",
      path: `/api/devices/${device.id}/deactivate`,
      params: { id: device.id },
      jar,
      body: {},
    });
    expect(again.status).toBe(200);
    expect(again.body.device.deactivatedAt).toBe(res.body.device.deactivatedAt);
    expect(
      await prisma.auditLog.count({
        where: { organisationId: org.organisation.id, action: "device.deactivated" },
      }),
    ).toBe(1);
  });

  it("cuts the phone off: the access token and the refresh token stop working immediately", async () => {
    const { org, jar } = await setup();
    const { device } = await createTestDevice(org.organisation.id);
    const issued = await issueMobileTokens(device);
    const headers = { authorization: `Bearer ${issued.accessToken}` };
    const before = await callRoute(meRoute, { path: "/api/mobile/v1/me", headers });
    expect(before.status, JSON.stringify(before.body)).toBe(200);

    const res = await callRoute<DeviceResponse>(deactivateRoute, {
      method: "POST",
      path: `/api/devices/${device.id}/deactivate`,
      params: { id: device.id },
      jar,
      body: {},
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // The still-unexpired access JWT is refused (the device row is re-checked on every request) …
    const after = await callRoute<ErrorBody>(meRoute, { path: "/api/mobile/v1/me", headers });
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe("DEVICE_INACTIVE");
    // … and the refresh token can no longer mint a new pair.
    await expect(rotateRefreshToken(issued.refreshToken)).rejects.toMatchObject({
      name: "AppError",
      status: 401,
    });
  });

  it("rejects unknown body fields and needs the CSRF header", async () => {
    const { org, jar } = await setup();
    const { device } = await createTestDevice(org.organisation.id);
    const bad = await callRoute<ErrorBody>(deactivateRoute, {
      method: "POST",
      path: `/api/devices/${device.id}/deactivate`,
      params: { id: device.id },
      jar,
      body: { wipe: true },
    });
    expect(bad.status).toBe(400);
    const noCsrf = await callRoute<ErrorBody>(deactivateRoute, {
      method: "POST",
      path: `/api/devices/${device.id}/deactivate`,
      params: { id: device.id },
      jar,
      body: {},
      csrf: false,
    });
    expect(noCsrf.status).toBe(403);
    expect((await prisma.device.findUniqueOrThrow({ where: { id: device.id } })).isActive).toBe(
      true,
    );
  });
});
