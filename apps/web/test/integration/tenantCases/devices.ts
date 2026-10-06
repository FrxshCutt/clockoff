import { prisma } from "@workmode/db";
import { expect } from "vitest";
import { POST as deactivateRoute } from "@/app/api/devices/[id]/deactivate/route";
import { GET as getDeviceRoute } from "@/app/api/devices/[id]/route";
import { GET as listDevicesRoute } from "@/app/api/devices/route";
import { createTestDevice } from "../../helpers/factories";
import { registerTenantIsolationCase } from "../../helpers/tenantIsolation";

/** Devices: org A's owner must never see or deactivate org B's phones. */

registerTenantIsolationCase({
  name: "GET /api/devices/:id of another tenant",
  build: async (_a, b) => {
    const { device } = await createTestDevice(b.organisation.id);
    return {
      handler: getDeviceRoute,
      path: `/api/devices/${device.id}`,
      params: { id: device.id },
    };
  },
  expectCode: "NOT_FOUND",
});

registerTenantIsolationCase({
  name: "POST /api/devices/:id/deactivate of another tenant",
  build: async (_a, b) => {
    const { device } = await createTestDevice(b.organisation.id);
    return {
      handler: deactivateRoute,
      method: "POST",
      path: `/api/devices/${device.id}/deactivate`,
      params: { id: device.id },
      body: { reason: "cross-tenant attempt" },
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (_a, b) => {
    const row = await prisma.device.findFirstOrThrow({
      where: { organisationId: b.organisation.id },
    });
    expect(row.isActive).toBe(true);
    expect(row.deactivatedAt).toBeNull();
  },
});

registerTenantIsolationCase({
  name: "GET /api/devices filtered by another tenant's employee",
  build: async (_a, b) => {
    const { employee } = await createTestDevice(b.organisation.id);
    return { handler: listDevicesRoute, path: "/api/devices", query: { employeeId: employee.id } };
  },
  // The filter is honoured inside org A only, so the answer is an empty page (asserted in devices.test.ts).
  expectStatus: 200,
});
