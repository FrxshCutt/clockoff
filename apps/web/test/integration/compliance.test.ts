import { prisma } from "@workmode/db";
import {
  complianceEmployeesResponseSchema,
  complianceSummaryResponseSchema,
} from "@workmode/validation/compliance";
import { describe, expect, it } from "vitest";
import { GET as employeesRoute } from "@/app/api/compliance/employees/route";
import { GET as summaryRoute } from "@/app/api/compliance/summary/route";
import { callRoute, createTestDevice, createTestOrg, loginAs, type ErrorBody } from "../helpers";

const HOUR = 60 * 60 * 1000;

async function fixture() {
  const org = await createTestOrg({ firstLocationName: "Main bar" });
  const organisationId = org.organisation.id;
  const location = await prisma.location.findFirstOrThrow({ where: { organisationId } });
  const now = Date.now();
  const shift = (employeeId: string, startsAt: Date, endsAt: Date) =>
    prisma.shift.create({
      data: { organisationId, employeeId, startsAt, endsAt, timezone: "Europe/London", locationId: location.id },
    });

  // E1: connected, on shift, device confirms Work Mode → WORK_MODE_ACTIVE.
  const e1 = await createTestDevice(organisationId);
  await prisma.employee.update({
    where: { id: e1.employee.id },
    data: { firstName: "Ava", lastName: "Active", inviteStatus: "CONNECTED", primaryLocationId: location.id },
  });
  await prisma.device.update({
    where: { id: e1.device.id },
    data: { permissionState: "APPROVED", selectionState: "CONFIGURED", lastDeviceSyncAt: new Date(now) },
  });
  await shift(e1.employee.id, new Date(now - HOUR), new Date(now + 3 * HOUR));
  await prisma.employeeWorkState.create({
    data: { employeeId: e1.employee.id, state: "WORKING", source: "DEVICE_REPORT", reportedState: "WORKING", reportedAt: new Date(now) },
  });
  await shift(e1.employee.id, new Date(now + 5 * HOUR), new Date(now + 9 * HOUR));

  // E2: never invited, no device, shift in 2 hours.
  const e2 = await prisma.employee.create({
    data: { organisationId, firstName: "Ben", lastName: "Beginner", inviteStatus: "NOT_INVITED" },
  });
  await shift(e2.id, new Date(now + 2 * HOUR), new Date(now + 6 * HOUR));

  // E3: device with permission DENIED, on shift → PERMISSIONS_MISSING + needs attention.
  const e3 = await createTestDevice(organisationId);
  await prisma.employee.update({
    where: { id: e3.employee.id },
    data: { firstName: "Cal", lastName: "Careless", inviteStatus: "SETUP_INCOMPLETE" },
  });
  await prisma.device.update({
    where: { id: e3.device.id },
    data: { permissionState: "DENIED", selectionState: "CONFIGURED", lastDeviceSyncAt: new Date(now) },
  });
  await shift(e3.employee.id, new Date(now - HOUR), new Date(now + 3 * HOUR));

  // E4: deactivated → excluded everywhere.
  await prisma.employee.create({
    data: { organisationId, firstName: "Dee", lastName: "Departed", employmentStatus: "INACTIVE", inviteStatus: "DEACTIVATED" },
  });

  // Another tenant with an on-shift employee: never counted.
  const other = await createTestOrg();
  const o1 = await createTestDevice(other.organisation.id);
  await prisma.shift.create({
    data: {
      organisationId: other.organisation.id,
      employeeId: o1.employee.id,
      startsAt: new Date(now - HOUR),
      endsAt: new Date(now + HOUR),
      timezone: "Europe/London",
    },
  });

  const jar = await loginAs(org.owner, { organisationId });
  return { org, jar, location, e1, e2, e3 };
}

describe("GET /api/compliance/summary", () => {
  it("derives the metric cards, upcoming shifts and integration status for the organisation only", async () => {
    const { jar, e1, e2 } = await fixture();
    const res = await callRoute(summaryRoute, { path: "/api/compliance/summary", jar });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const summary = complianceSummaryResponseSchema.parse(res.body);
    expect(summary.metrics).toEqual({
      totalEmployees: 3,
      connected: 1,
      awaitingSetup: 2,
      missingPermissions: 1,
      workingNow: 2,
      workModeActive: 1,
      onBreak: 0,
      needsAttention: 1,
    });
    expect(summary.upcomingShifts.map((s) => s.employee.id)).toEqual([e2.id, e1.employee.id]);
    expect(summary.upcomingShifts[0]!.ready).toBe(false);
    expect(summary.upcomingShifts[0]!.deviceStatus).toBeNull();
    expect(summary.upcomingShifts[1]!.ready).toBe(true);
    expect(summary.upcomingShifts[1]!.deviceStatus?.badge).toBe("WORK_MODE_ACTIVE");
    expect(summary.integrationStatus).toEqual([]);
  });
});

describe("GET /api/compliance/employees", () => {
  it("lists rows behind each metric with status details, filters and pagination", async () => {
    const { jar, e1, e3, location } = await fixture();

    const all = complianceEmployeesResponseSchema.parse(
      (await callRoute(employeesRoute, { path: "/api/compliance/employees", jar })).body,
    );
    expect(all.total).toBe(3);
    expect(all.items.map((r) => r.employee.lastName)).toEqual(["Active", "Beginner", "Careless"]);

    const attention = complianceEmployeesResponseSchema.parse(
      (await callRoute(employeesRoute, { path: "/api/compliance/employees", query: { filter: "NEEDS_ATTENTION" }, jar })).body,
    );
    expect(attention.items).toHaveLength(1);
    const row = attention.items[0]!;
    expect(row.employee.id).toBe(e3.employee.id);
    expect(row.deviceStatus?.badge).toBe("PERMISSIONS_MISSING");
    expect(row.permissionState).toBe("DENIED");
    expect(row.expectedState).toBe("PERMISSION_ERROR");
    expect(row.activeShift).not.toBeNull();
    expect(row.attentionReason).toContain("cannot be enforced");
    expect(row.lastSyncAt).not.toBeNull();

    const active = complianceEmployeesResponseSchema.parse(
      (await callRoute(employeesRoute, { path: "/api/compliance/employees", query: { filter: "WORK_MODE_ACTIVE" }, jar })).body,
    );
    expect(active.items.map((r) => r.employee.id)).toEqual([e1.employee.id]);
    expect(active.items[0]!.reportedState).toBe("WORKING");
    expect(active.items[0]!.deviceStatus?.badge).toBe("WORK_MODE_ACTIVE");

    const awaiting = complianceEmployeesResponseSchema.parse(
      (await callRoute(employeesRoute, { path: "/api/compliance/employees", query: { filter: "AWAITING_SETUP" }, jar })).body,
    );
    expect(awaiting.items.map((r) => r.employee.lastName)).toEqual(["Beginner", "Careless"]);

    const byLocation = complianceEmployeesResponseSchema.parse(
      (await callRoute(employeesRoute, { path: "/api/compliance/employees", query: { locationId: location.id }, jar })).body,
    );
    expect(byLocation.items.map((r) => r.employee.id)).toEqual([e1.employee.id]);

    const search = complianceEmployeesResponseSchema.parse(
      (await callRoute(employeesRoute, { path: "/api/compliance/employees", query: { search: "care" }, jar })).body,
    );
    expect(search.items.map((r) => r.employee.id)).toEqual([e3.employee.id]);

    const page = complianceEmployeesResponseSchema.parse(
      (await callRoute(employeesRoute, { path: "/api/compliance/employees", query: { pageSize: 1, page: 2 }, jar })).body,
    );
    expect(page.items.map((r) => r.employee.lastName)).toEqual(["Beginner"]);
    expect(page.totalPages).toBe(3);

    const bad = await callRoute<ErrorBody>(employeesRoute, {
      path: "/api/compliance/employees",
      query: { filter: "awaitingSetup" },
      jar,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_ERROR");

    const anonymous = await callRoute<ErrorBody>(employeesRoute, { path: "/api/compliance/employees" });
    expect(anonymous.status).toBe(401);
  });
});
