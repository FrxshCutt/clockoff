import { randomUUID } from "node:crypto";
import { prisma } from "@workmode/db";
import { expect } from "vitest";
import { POST as bulkRoute } from "@/app/api/shifts/bulk/route";
import { POST as cancelRoute } from "@/app/api/shifts/[id]/cancel/route";
import { POST as duplicateRoute } from "@/app/api/shifts/[id]/duplicate/route";
import { DELETE as deleteRoute, GET as getRoute, PATCH as patchRoute } from "@/app/api/shifts/[id]/route";
import { GET as listRoute, POST as createRoute } from "@/app/api/shifts/route";
import { registerTenantIsolationCase } from "../../helpers/tenantIsolation";

/** Shift endpoints: org A's owner must never see or change org B's shifts, employees or locations. */

async function createEmployeeInOrg(organisationId: string) {
  return prisma.employee.create({
    data: { organisationId, firstName: "B", lastName: `Only ${randomUUID().slice(0, 4)}` },
  });
}

/** A scheduled 09:00–17:00 London shift on 10 March 2027, written directly so each case is self-contained. */
async function createShiftInOrg(organisationId: string) {
  const employee = await createEmployeeInOrg(organisationId);
  const shift = await prisma.shift.create({
    data: {
      organisationId,
      employeeId: employee.id,
      startsAt: new Date("2027-03-10T09:00:00.000Z"),
      endsAt: new Date("2027-03-10T17:00:00.000Z"),
      timezone: "Europe/London",
      notes: "Untouched",
    },
  });
  return { employee, shift };
}

async function expectShiftUnchanged(organisationId: string) {
  const row = await prisma.shift.findFirstOrThrow({ where: { organisationId } });
  expect(row.status).toBe("SCHEDULED");
  expect(row.deletedAt).toBeNull();
  expect(row.version).toBe(1);
  expect(row.notes).toBe("Untouched");
  expect(row.endsAt.toISOString()).toBe("2027-03-10T17:00:00.000Z");
}

registerTenantIsolationCase({
  name: "GET /api/shifts/:id of another tenant",
  build: async (_a, b) => {
    const { shift } = await createShiftInOrg(b.organisation.id);
    return { handler: getRoute, path: `/api/shifts/${shift.id}`, params: { id: shift.id } };
  },
  expectCode: "NOT_FOUND",
});

registerTenantIsolationCase({
  name: "PATCH /api/shifts/:id of another tenant",
  build: async (_a, b) => {
    const { shift } = await createShiftInOrg(b.organisation.id);
    return {
      handler: patchRoute,
      method: "PATCH",
      path: `/api/shifts/${shift.id}`,
      params: { id: shift.id },
      body: { notes: "Hijacked", endTime: "18:00" },
    };
  },
  expectCode: "NOT_FOUND",
  verify: (_a, b) => expectShiftUnchanged(b.organisation.id),
});

registerTenantIsolationCase({
  name: "DELETE /api/shifts/:id of another tenant",
  build: async (_a, b) => {
    const { shift } = await createShiftInOrg(b.organisation.id);
    return { handler: deleteRoute, method: "DELETE", path: `/api/shifts/${shift.id}`, params: { id: shift.id } };
  },
  expectCode: "NOT_FOUND",
  verify: (_a, b) => expectShiftUnchanged(b.organisation.id),
});

registerTenantIsolationCase({
  name: "POST /api/shifts/:id/cancel of another tenant",
  build: async (_a, b) => {
    const { shift } = await createShiftInOrg(b.organisation.id);
    return {
      handler: cancelRoute,
      method: "POST",
      path: `/api/shifts/${shift.id}/cancel`,
      params: { id: shift.id },
      body: { reason: "nope" },
    };
  },
  expectCode: "NOT_FOUND",
  verify: (_a, b) => expectShiftUnchanged(b.organisation.id),
});

registerTenantIsolationCase({
  name: "POST /api/shifts/:id/duplicate of another tenant",
  build: async (_a, b) => {
    const { shift } = await createShiftInOrg(b.organisation.id);
    return {
      handler: duplicateRoute,
      method: "POST",
      path: `/api/shifts/${shift.id}/duplicate`,
      params: { id: shift.id },
      body: { date: "2027-03-11" },
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (a, b) => {
    expect(await prisma.shift.count({ where: { organisationId: a.organisation.id } })).toBe(0);
    expect(await prisma.shift.count({ where: { organisationId: b.organisation.id } })).toBe(1);
  },
});

registerTenantIsolationCase({
  name: "POST /api/shifts for another tenant's employee",
  build: async (_a, b) => {
    const employee = await createEmployeeInOrg(b.organisation.id);
    return {
      handler: createRoute,
      method: "POST",
      path: "/api/shifts",
      body: { employeeId: employee.id, date: "2027-03-10", startTime: "09:00", endTime: "17:00" },
    };
  },
  expectCode: "EMPLOYEE_NOT_FOUND",
  verify: async (a, b) => {
    expect(
      await prisma.shift.count({ where: { organisationId: { in: [a.organisation.id, b.organisation.id] } } }),
    ).toBe(0);
  },
});

registerTenantIsolationCase({
  name: "POST /api/shifts with another tenant's location",
  build: async (a, b) => {
    const employee = await createEmployeeInOrg(a.organisation.id);
    const location = await prisma.location.create({ data: { organisationId: b.organisation.id, name: "B site" } });
    return {
      handler: createRoute,
      method: "POST",
      path: "/api/shifts",
      body: {
        employeeId: employee.id,
        locationId: location.id,
        date: "2027-03-10",
        startTime: "09:00",
        endTime: "17:00",
      },
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (a, b) => {
    expect(
      await prisma.shift.count({ where: { organisationId: { in: [a.organisation.id, b.organisation.id] } } }),
    ).toBe(0);
  },
});

registerTenantIsolationCase({
  name: "PATCH /api/shifts/:id moving own shift to another tenant's location",
  build: async (a, b) => {
    const { shift } = await createShiftInOrg(a.organisation.id);
    const location = await prisma.location.create({ data: { organisationId: b.organisation.id, name: "B site" } });
    return {
      handler: patchRoute,
      method: "PATCH",
      path: `/api/shifts/${shift.id}`,
      params: { id: shift.id },
      body: { locationId: location.id },
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (a) => {
    const row = await prisma.shift.findFirstOrThrow({ where: { organisationId: a.organisation.id } });
    expect(row.locationId).toBeNull();
    expect(row.version).toBe(1);
  },
});

registerTenantIsolationCase({
  name: "POST /api/shifts/bulk CANCEL with another tenant's shift ids",
  build: async (_a, b) => {
    const { shift } = await createShiftInOrg(b.organisation.id);
    return {
      handler: bulkRoute,
      method: "POST",
      path: "/api/shifts/bulk",
      body: { action: "CANCEL", shiftIds: [shift.id] },
    };
  },
  // Bulk actions answer per item: the foreign id is reported NOT_FOUND and nothing changes.
  expectStatus: 200,
  verify: (_a, b) => expectShiftUnchanged(b.organisation.id),
});

registerTenantIsolationCase({
  name: "POST /api/shifts/bulk DELETE with another tenant's shift ids",
  build: async (_a, b) => {
    const { shift } = await createShiftInOrg(b.organisation.id);
    return {
      handler: bulkRoute,
      method: "POST",
      path: "/api/shifts/bulk",
      body: { action: "DELETE", shiftIds: [shift.id] },
    };
  },
  expectStatus: 200,
  verify: (_a, b) => expectShiftUnchanged(b.organisation.id),
});

registerTenantIsolationCase({
  name: "GET /api/shifts filtered by another tenant's employee",
  build: async (_a, b) => {
    const { employee } = await createShiftInOrg(b.organisation.id);
    return {
      handler: listRoute,
      path: "/api/shifts",
      query: { from: "2027-03-01T00:00:00Z", to: "2027-03-31T00:00:00Z", employeeId: employee.id },
    };
  },
  // The filter is honoured inside org A only, so the answer is an empty list (asserted in shifts.test.ts).
  expectStatus: 200,
});
