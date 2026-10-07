import { prisma } from "@clockoff/db";
import {
  bulkEmployeeActionResponseSchema,
  employeeDetailResponseSchema,
  employeeResponseSchema,
  employeeStateResponseSchema,
  listEmployeesResponseSchema,
  type BulkEmployeeActionResponse,
  type EmployeeDetailResponse,
  type EmployeeResponse,
  type EmployeeStateResponse,
  type ListEmployeesResponse,
} from "@clockoff/validation/employees";
import type { ListActivityResponse } from "@clockoff/validation/activity";
import type { ListShiftsResponse } from "@clockoff/validation/shifts";
import { describe, expect, it } from "vitest";
import { GET as activityRoute } from "@/app/api/employees/[id]/activity/route";
import { POST as archiveRoute } from "@/app/api/employees/[id]/archive/route";
import { POST as assignBreakPolicyRoute } from "@/app/api/employees/[id]/assign-break-policy/route";
import { POST as assignLocationRoute } from "@/app/api/employees/[id]/assign-location/route";
import { POST as assignPolicyRoute } from "@/app/api/employees/[id]/assign-policy/route";
import { POST as assignTeamRoute } from "@/app/api/employees/[id]/assign-team/route";
import { POST as deactivateRoute } from "@/app/api/employees/[id]/deactivate/route";
import { POST as createInviteRoute } from "@/app/api/employees/[id]/invites/route";
import { POST as reactivateRoute } from "@/app/api/employees/[id]/reactivate/route";
import {
  DELETE as deleteRoute,
  GET as getRoute,
  PATCH as patchRoute,
} from "@/app/api/employees/[id]/route";
import { GET as shiftsRoute } from "@/app/api/employees/[id]/shifts/route";
import { GET as stateRoute } from "@/app/api/employees/[id]/state/route";
import { POST as bulkRoute } from "@/app/api/employees/bulk/route";
import { GET as listRoute, POST as createRoute } from "@/app/api/employees/route";
import { hashToken } from "@/lib/tokens";
import { recordActivity } from "@/server/activity/recordActivity";
import { issueMobileTokens } from "@/server/mobileAuth";
import { RATE_LIMITS, getRateLimiter, rateLimitKey } from "@/server/rateLimit";
import {
  callRoute,
  createTestDevice,
  createTestOrg,
  loginAs,
  testEmails,
  type CookieJar,
  type ErrorBody,
  type TestOrg,
} from "../helpers";

const HOUR = 60 * 60 * 1000;

const RESTRICTION_CONFIG = {
  categories: ["SOCIAL_MEDIA", "GAMES"],
  requireEmployeeAppSelection: true,
  alwaysAllowedNote: ["Phone, Messages and FaceTime"],
  shieldMessage: "Work Mode is on.",
  activationMode: "SCHEDULED",
  preShiftWarningMinutes: 10,
};

async function setup() {
  const org = await createTestOrg({ firstLocationName: "High Street" });
  const jar = await loginAs(org.owner, { organisationId: org.organisation.id });
  const location = await prisma.location.findFirstOrThrow({
    where: { organisationId: org.organisation.id },
  });
  return { org, jar, location };
}

async function createEmployee(jar: CookieJar, body: Record<string, unknown>) {
  const res = await callRoute<EmployeeResponse>(createRoute, {
    method: "POST",
    path: "/api/employees",
    jar,
    body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return employeeResponseSchema.parse(res.body).employee;
}

async function seedPublishedPolicy(organisationId: string, name: string) {
  const policy = await prisma.policy.create({ data: { organisationId, name, status: "ACTIVE" } });
  const version = await prisma.policyVersion.create({
    data: {
      policyId: policy.id,
      versionNumber: 1,
      restrictionConfig: RESTRICTION_CONFIG,
      publishedAt: new Date(),
    },
  });
  return prisma.policy.update({ where: { id: policy.id }, data: { currentVersionId: version.id } });
}

async function seedBreakPolicy(organisationId: string, name: string) {
  return prisma.breakPolicy.create({ data: { organisationId, name } });
}

async function seedShift(org: TestOrg, employeeId: string, startsAt: Date, endsAt: Date) {
  return prisma.shift.create({
    data: {
      organisationId: org.organisation.id,
      employeeId,
      startsAt,
      endsAt,
      timezone: org.organisation.timezone,
    },
  });
}

describe("POST /api/employees", () => {
  it("creates an employee with locations, teams and department, audited", async () => {
    const { org, jar, location } = await setup();
    const department = await prisma.department.create({
      data: { organisationId: org.organisation.id, name: "Front of house" },
    });
    const team = await prisma.team.create({
      data: { organisationId: org.organisation.id, name: "Morning crew", locationId: location.id },
    });
    const employee = await createEmployee(jar, {
      firstName: "Jane",
      lastName: "Smith",
      email: "Jane.Smith@Example.test",
      externalEmployeeId: "EMP-001",
      jobTitle: "Barista",
      departmentId: department.id,
      primaryLocationId: location.id,
      teamIds: [team.id],
    });
    expect(employee).toMatchObject({
      firstName: "Jane",
      lastName: "Smith",
      email: "jane.smith@example.test",
      externalEmployeeId: "EMP-001",
      jobTitle: "Barista",
      department: { id: department.id, name: "Front of house" },
      primaryLocation: { id: location.id, name: "High Street" },
      locations: [{ id: location.id, name: "High Street" }],
      teams: [{ id: team.id, name: "Morning crew" }],
      employmentStatus: "ACTIVE",
      inviteStatus: "NOT_INVITED",
      deviceStatus: null,
      policyOverride: null,
      resolvedPolicy: null,
      nextShift: null,
      lastSyncAt: null,
    });
    const audits = await prisma.auditLog.findMany({
      where: { organisationId: org.organisation.id, action: "employee.created" },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.entityId).toBe(employee.id);
    expect(audits[0]?.actorUserId).toBe(org.owner.id);
  });

  it("rejects a duplicate external id in the same organisation only", async () => {
    const { org, jar } = await setup();
    await createEmployee(jar, { firstName: "A", lastName: "One", externalEmployeeId: "X-1" });
    const dup = await callRoute<ErrorBody>(createRoute, {
      method: "POST",
      path: "/api/employees",
      jar,
      body: { firstName: "B", lastName: "Two", externalEmployeeId: "X-1" },
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("CONFLICT");
    expect(dup.body.error.details).toMatchObject({
      fieldErrors: { externalEmployeeId: [expect.any(String)] },
    });
    expect(await prisma.employee.count({ where: { organisationId: org.organisation.id } })).toBe(1);

    const other = await createTestOrg();
    const otherJar = await loginAs(other.owner, { organisationId: other.organisation.id });
    await createEmployee(otherJar, {
      firstName: "C",
      lastName: "Three",
      externalEmployeeId: "X-1",
    });
  });

  it("validates the body and the references", async () => {
    const { jar } = await setup();
    const missing = await callRoute<ErrorBody>(createRoute, {
      method: "POST",
      path: "/api/employees",
      jar,
      body: { lastName: "Smith" },
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("VALIDATION_ERROR");

    const unknownKey = await callRoute<ErrorBody>(createRoute, {
      method: "POST",
      path: "/api/employees",
      jar,
      body: { firstName: "J", lastName: "S", phoneNumber: "123" },
    });
    expect(unknownKey.status).toBe(400);

    const foreignLocation = await createTestOrg({ firstLocationName: "Elsewhere" });
    const elsewhere = await prisma.location.findFirstOrThrow({
      where: { organisationId: foreignLocation.organisation.id },
    });
    const badRef = await callRoute<ErrorBody>(createRoute, {
      method: "POST",
      path: "/api/employees",
      jar,
      body: { firstName: "J", lastName: "S", primaryLocationId: elsewhere.id },
    });
    expect(badRef.status).toBe(400);
    expect(badRef.body.error.details).toMatchObject({
      fieldErrors: { primaryLocationId: ["Unknown location"] },
    });
  });

  it("enforces the plan's active-employee limit on create and reactivate", async () => {
    const { org, jar } = await setup();
    await prisma.employee.createMany({
      data: Array.from({ length: 25 }, (_, i) => ({
        organisationId: org.organisation.id,
        firstName: "Seed",
        lastName: `Employee ${i}`,
      })),
    });
    const blocked = await callRoute<ErrorBody>(createRoute, {
      method: "POST",
      path: "/api/employees",
      jar,
      body: { firstName: "One", lastName: "Too many" },
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("CONFLICT");
    expect(blocked.body.error.details).toMatchObject({
      reason: "PLAN_LIMIT",
      metric: "employees",
      plan: "STARTER",
      limit: 25,
      current: 25,
    });
    expect(blocked.body.error.message).toContain("Starter");

    const victim = await prisma.employee.findFirstOrThrow({
      where: { organisationId: org.organisation.id },
    });
    const deactivated = await callRoute<EmployeeResponse>(deactivateRoute, {
      method: "POST",
      path: `/api/employees/${victim.id}/deactivate`,
      params: { id: victim.id },
      jar,
      body: {},
    });
    expect(deactivated.status).toBe(200);
    await createEmployee(jar, { firstName: "Now", lastName: "Fits" });

    const reactivate = await callRoute<ErrorBody>(reactivateRoute, {
      method: "POST",
      path: `/api/employees/${victim.id}/reactivate`,
      params: { id: victim.id },
      jar,
      body: {},
    });
    expect(reactivate.status).toBe(409);
    expect(reactivate.body.error.details).toMatchObject({ reason: "PLAN_LIMIT" });
  });

  it("creates EMPLOYEE-scope policy overrides and refuses draft / archived policies", async () => {
    const { org, jar } = await setup();
    const policy = await seedPublishedPolicy(org.organisation.id, "Floor policy");
    const breakPolicy = await seedBreakPolicy(org.organisation.id, "Standard breaks");
    const employee = await createEmployee(jar, {
      firstName: "Pol",
      lastName: "Icy",
      policyId: policy.id,
      breakPolicyId: breakPolicy.id,
    });
    expect(employee.policyOverride).toEqual({ id: policy.id, name: "Floor policy" });
    expect(employee.breakPolicyOverride).toEqual({ id: breakPolicy.id, name: "Standard breaks" });
    expect(employee.resolvedPolicy).toEqual({
      id: policy.id,
      name: "Floor policy",
      resolvedFrom: "EMPLOYEE",
    });
    expect(employee.resolvedBreakPolicy).toMatchObject({
      id: breakPolicy.id,
      resolvedFrom: "EMPLOYEE",
    });
    const assignments = await prisma.policyAssignment.findMany({
      where: { organisationId: org.organisation.id, scopeType: "EMPLOYEE", scopeId: employee.id },
    });
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.createdById).toBe(org.owner.id);

    const draft = await prisma.policy.create({
      data: { organisationId: org.organisation.id, name: "Draft", status: "DRAFT" },
    });
    const notPublished = await callRoute<ErrorBody>(createRoute, {
      method: "POST",
      path: "/api/employees",
      jar,
      body: { firstName: "D", lastName: "Raft", policyId: draft.id },
    });
    expect(notPublished.status).toBe(409);
    expect(notPublished.body.error.code).toBe("POLICY_NOT_PUBLISHED");

    await prisma.policy.update({ where: { id: policy.id }, data: { status: "ARCHIVED" } });
    const archived = await callRoute<ErrorBody>(createRoute, {
      method: "POST",
      path: "/api/employees",
      jar,
      body: { firstName: "A", lastName: "Rchived", policyId: policy.id },
    });
    expect(archived.status).toBe(409);
    expect(archived.body.error.code).toBe("POLICY_ARCHIVED");

    const foreign = await createTestOrg();
    const foreignPolicy = await seedPublishedPolicy(foreign.organisation.id, "Foreign");
    const crossTenant = await callRoute<ErrorBody>(createRoute, {
      method: "POST",
      path: "/api/employees",
      jar,
      body: { firstName: "X", lastName: "Tenant", policyId: foreignPolicy.id },
    });
    expect(crossTenant.status).toBe(400);
    expect(crossTenant.body.error.details).toMatchObject({
      fieldErrors: { policyId: [expect.any(String)] },
    });
  });

  it("requires a session and a CSRF token", async () => {
    const { jar } = await setup();
    const anonymous = await callRoute<ErrorBody>(listRoute, { path: "/api/employees" });
    expect(anonymous.status).toBe(401);
    const noCsrf = await callRoute<ErrorBody>(createRoute, {
      method: "POST",
      path: "/api/employees",
      jar,
      csrf: false,
      body: { firstName: "No", lastName: "Csrf" },
    });
    expect(noCsrf.status).toBe(403);
  });
});

describe("GET /api/employees", () => {
  it("lists, paginates, searches, filters and sorts", async () => {
    const { org, jar, location } = await setup();
    const second = await prisma.location.create({
      data: { organisationId: org.organisation.id, name: "Station Road" },
    });
    const department = await prisma.department.create({
      data: { organisationId: org.organisation.id, name: "Kitchen" },
    });
    const team = await prisma.team.create({
      data: { organisationId: org.organisation.id, name: "Night crew" },
    });
    const policy = await seedPublishedPolicy(org.organisation.id, "Kitchen policy");

    const alice = await createEmployee(jar, {
      firstName: "Alice",
      lastName: "Zephyr",
      email: "alice@example.test",
      jobTitle: "Chef",
      primaryLocationId: location.id,
      departmentId: department.id,
      teamIds: [team.id],
      policyId: policy.id,
    });
    const bob = await createEmployee(jar, {
      firstName: "Bob",
      lastName: "Anders",
      externalEmployeeId: "B-77",
      primaryLocationId: second.id,
    });
    const carol = await createEmployee(jar, {
      firstName: "Carol",
      lastName: "Mills",
      locationIds: [location.id],
    });
    // An archived employee is never listed.
    await prisma.employee.create({
      data: {
        organisationId: org.organisation.id,
        firstName: "Gone",
        lastName: "Archived",
        deletedAt: new Date(),
      },
    });

    const list = async (query: Record<string, string | number> = {}) => {
      const res = await callRoute<ListEmployeesResponse>(listRoute, {
        path: "/api/employees",
        jar,
        query,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return listEmployeesResponseSchema.parse(res.body);
    };

    const all = await list();
    expect(all.total).toBe(3);
    expect(all.items.map((e) => e.lastName)).toEqual(["Anders", "Mills", "Zephyr"]);

    const desc = await list({ sort: "-lastName" });
    expect(desc.items.map((e) => e.lastName)).toEqual(["Zephyr", "Mills", "Anders"]);

    const page = await list({ pageSize: 2, page: 2 });
    expect(page).toMatchObject({ page: 2, pageSize: 2, total: 3, totalPages: 2 });
    expect(page.items.map((e) => e.id)).toEqual([alice.id]);

    expect((await list({ search: "zeph" })).items.map((e) => e.id)).toEqual([alice.id]);
    expect((await list({ search: "ALICE@" })).items.map((e) => e.id)).toEqual([alice.id]);
    expect((await list({ search: "b-77" })).items.map((e) => e.id)).toEqual([bob.id]);
    expect((await list({ search: "chef" })).items.map((e) => e.id)).toEqual([alice.id]);

    expect((await list({ locationId: location.id })).items.map((e) => e.id).sort()).toEqual(
      [alice.id, carol.id].sort(),
    );
    expect((await list({ departmentId: department.id })).items.map((e) => e.id)).toEqual([
      alice.id,
    ]);
    expect((await list({ teamId: team.id })).items.map((e) => e.id)).toEqual([alice.id]);
    expect((await list({ policyId: policy.id })).items.map((e) => e.id)).toEqual([alice.id]);
    expect((await list({ inviteStatus: "INVITED,JOINED" })).total).toBe(0);
    expect((await list({ inviteStatus: "NOT_INVITED" })).total).toBe(3);

    const invalidSort = await callRoute<ErrorBody>(listRoute, {
      path: "/api/employees",
      jar,
      query: { sort: "email" },
    });
    expect(invalidSort.status).toBe(400);
  });

  it("derives device badges and filters on them after derivation", async () => {
    const { org, jar } = await setup();
    const { employee, device } = await createTestDevice(org.organisation.id);
    await prisma.device.update({
      where: { id: device.id },
      data: { lastDeviceSyncAt: new Date() },
    });
    await createEmployee(jar, { firstName: "No", lastName: "Device" });

    const res = await callRoute<ListEmployeesResponse>(listRoute, {
      path: "/api/employees",
      jar,
      query: { deviceStatus: "PERMISSIONS_MISSING" },
    });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({
      id: employee.id,
      deviceStatus: { badge: "PERMISSIONS_MISSING", severity: "warning" },
    });
    expect(res.body.items[0]?.lastSyncAt).not.toBeNull();

    const bySync = await callRoute<ListEmployeesResponse>(listRoute, {
      path: "/api/employees",
      jar,
      query: { sort: "-lastSyncAt" },
    });
    expect(bySync.body.items[0]?.id).toBe(employee.id);
    expect(bySync.body.items[1]?.lastSyncAt).toBeNull();
  });
});

describe("GET / PATCH / DELETE /api/employees/:id", () => {
  it("returns the detail with device, latest invite and work state", async () => {
    const { org, jar } = await setup();
    const { employee, device } = await createTestDevice(org.organisation.id);
    await prisma.device.update({
      where: { id: device.id },
      data: { pushTokenEncrypted: Buffer.from("secret") },
    });
    await prisma.employeeWorkState.create({ data: { employeeId: employee.id } });
    const res = await callRoute<EmployeeDetailResponse>(getRoute, {
      path: `/api/employees/${employee.id}`,
      params: { id: employee.id },
      jar,
    });
    expect(res.status).toBe(200);
    const detail = employeeDetailResponseSchema.parse(res.body).employee;
    expect(detail.device).toMatchObject({ id: device.id, hasPushToken: true, isActive: true });
    expect(JSON.stringify(res.body)).not.toContain("secret");
    expect(detail.latestInvite).toBeNull();
    expect(detail.workState).toMatchObject({ state: "OFF_SHIFT" });

    const missing = await callRoute<ErrorBody>(getRoute, {
      path: `/api/employees/${org.owner.id}`,
      params: { id: org.owner.id },
      jar,
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("EMPLOYEE_NOT_FOUND");

    const notUuid = await callRoute<ErrorBody>(getRoute, {
      path: "/api/employees/nope",
      params: { id: "nope" },
      jar,
    });
    expect(notUuid.status).toBe(400);
  });

  it("updates fields, clears with null, replaces sets and removes overrides", async () => {
    const { org, jar, location } = await setup();
    const policy = await seedPublishedPolicy(org.organisation.id, "P");
    const team = await prisma.team.create({
      data: { organisationId: org.organisation.id, name: "T" },
    });
    const other = await prisma.location.create({
      data: { organisationId: org.organisation.id, name: "Other" },
    });
    const created = await createEmployee(jar, {
      firstName: "Old",
      lastName: "Name",
      email: "old@example.test",
      primaryLocationId: location.id,
      policyId: policy.id,
    });
    const res = await callRoute<EmployeeResponse>(patchRoute, {
      method: "PATCH",
      path: `/api/employees/${created.id}`,
      params: { id: created.id },
      jar,
      body: {
        firstName: "New",
        email: null,
        jobTitle: "Supervisor",
        primaryLocationId: other.id,
        locationIds: [location.id],
        teamIds: [team.id],
        policyId: null,
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const updated = employeeResponseSchema.parse(res.body).employee;
    expect(updated).toMatchObject({
      firstName: "New",
      lastName: "Name",
      email: null,
      jobTitle: "Supervisor",
      primaryLocation: { id: other.id },
      policyOverride: null,
      resolvedPolicy: null,
    });
    expect(updated.locations.map((l) => l.id).sort()).toEqual([location.id, other.id].sort());
    expect(updated.teams.map((t) => t.id)).toEqual([team.id]);
    const live = await prisma.policyAssignment.findMany({
      where: { scopeType: "EMPLOYEE", scopeId: created.id, effectiveTo: null },
    });
    expect(live).toHaveLength(0);
    expect(
      await prisma.auditLog.count({
        where: {
          organisationId: org.organisation.id,
          action: "employee.updated",
          entityId: created.id,
        },
      }),
    ).toBe(1);

    const taken = await createEmployee(jar, {
      firstName: "T",
      lastName: "K",
      externalEmployeeId: "E-9",
    });
    void taken;
    const conflict = await callRoute<ErrorBody>(patchRoute, {
      method: "PATCH",
      path: `/api/employees/${created.id}`,
      params: { id: created.id },
      jar,
      body: { externalEmployeeId: "E-9" },
    });
    expect(conflict.status).toBe(409);
  });

  it("DELETE archives: 204, hidden from lists, devices and invites cut off", async () => {
    const { org, jar } = await setup();
    const { employee, device } = await createTestDevice(org.organisation.id);
    await issueMobileTokens(device);
    const res = await callRoute(deleteRoute, {
      method: "DELETE",
      path: `/api/employees/${employee.id}`,
      params: { id: employee.id },
      jar,
    });
    expect(res.status).toBe(204);
    const row = await prisma.employee.findUniqueOrThrow({ where: { id: employee.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row).toMatchObject({ employmentStatus: "INACTIVE", inviteStatus: "DEACTIVATED" });
    expect((await prisma.device.findUniqueOrThrow({ where: { id: device.id } })).isActive).toBe(
      false,
    );
    expect(
      await prisma.refreshToken.count({ where: { deviceId: device.id, revokedAt: null } }),
    ).toBe(0);
    const gone = await callRoute<ErrorBody>(getRoute, {
      path: `/api/employees/${employee.id}`,
      params: { id: employee.id },
      jar,
    });
    expect(gone.status).toBe(404);
    expect(
      await prisma.auditLog.count({
        where: { action: "employee.archived", entityId: employee.id },
      }),
    ).toBe(1);
  });
});

describe("lifecycle actions", () => {
  it("deactivate cuts phones off, ends a running break, keeps shifts; reactivate re-derives the lifecycle", async () => {
    const { org, jar } = await setup();
    const { employee, device } = await createTestDevice(org.organisation.id);
    const issued = await issueMobileTokens(device);
    const now = Date.now();
    const shift = await seedShift(org, employee.id, new Date(now - HOUR), new Date(now + 3 * HOUR));
    const breakSession = await prisma.breakSession.create({
      data: {
        organisationId: org.organisation.id,
        employeeId: employee.id,
        shiftId: shift.id,
        deviceId: device.id,
        startedAt: new Date(now - 5 * 60_000),
        plannedEndsAt: new Date(now + 10 * 60_000),
        clientBreakId: `brk-${employee.id}`,
      },
    });
    await prisma.employeeInvite.create({
      data: {
        organisationId: org.organisation.id,
        employeeId: employee.id,
        code: "ABCD22",
        tokenHash: `hash-${employee.id}`,
        status: "SENT",
        expiresAt: new Date(now + 24 * HOUR),
      },
    });

    const res = await callRoute<EmployeeResponse>(deactivateRoute, {
      method: "POST",
      path: `/api/employees/${employee.id}/deactivate`,
      params: { id: employee.id },
      jar,
      body: { reason: "Left the company" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.employee).toMatchObject({
      employmentStatus: "INACTIVE",
      inviteStatus: "DEACTIVATED",
      deviceStatus: null,
    });
    expect((await prisma.device.findUniqueOrThrow({ where: { id: device.id } })).isActive).toBe(
      false,
    );
    expect(
      (
        await prisma.refreshToken.findUniqueOrThrow({
          where: { tokenHash: hashToken(issued.refreshToken) },
        })
      ).revokedAt,
    ).not.toBeNull();
    expect(
      (await prisma.employeeUserLink.findUniqueOrThrow({ where: { employeeId: employee.id } }))
        .unlinkedAt,
    ).not.toBeNull();
    expect(
      await prisma.breakSession.findUniqueOrThrow({ where: { id: breakSession.id } }),
    ).toMatchObject({
      status: "ENDED",
      endReason: "MANAGER_ENDED",
    });
    expect(
      await prisma.employeeInvite.count({ where: { employeeId: employee.id, status: "REVOKED" } }),
    ).toBe(1);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } })).status).toBe(
      "SCHEDULED",
    );
    expect(
      await prisma.activityEvent.count({
        where: {
          employeeId: employee.id,
          type: "BREAK_ENDED",
          actorType: "MANAGER",
          actorUserId: org.owner.id,
        },
      }),
    ).toBe(1);
    const auditRow = await prisma.auditLog.findFirstOrThrow({
      where: { action: "employee.deactivated", entityId: employee.id },
    });
    expect(auditRow.after).toMatchObject({ reason: "Left the company", deactivatedDevices: 1 });

    // Idempotent.
    const again = await callRoute<EmployeeResponse>(deactivateRoute, {
      method: "POST",
      path: `/api/employees/${employee.id}/deactivate`,
      params: { id: employee.id },
      jar,
      body: {},
    });
    expect(again.status).toBe(200);

    const reactivated = await callRoute<EmployeeResponse>(reactivateRoute, {
      method: "POST",
      path: `/api/employees/${employee.id}/reactivate`,
      params: { id: employee.id },
      jar,
      body: {},
    });
    expect(reactivated.status).toBe(200);
    // The phone was unlinked and the invite revoked: the employee must join again.
    expect(reactivated.body.employee).toMatchObject({
      employmentStatus: "ACTIVE",
      inviteStatus: "NOT_INVITED",
    });
  });

  it("archive hides the employee; assign-* actions update scopes with audit rows", async () => {
    const { org, jar, location } = await setup();
    const policy = await seedPublishedPolicy(org.organisation.id, "Assigned");
    const breakPolicy = await seedBreakPolicy(org.organisation.id, "Assigned breaks");
    const team = await prisma.team.create({
      data: { organisationId: org.organisation.id, name: "Team" },
    });
    const other = await prisma.location.create({
      data: { organisationId: org.organisation.id, name: "Annex" },
    });
    const employee = await createEmployee(jar, { firstName: "Assign", lastName: "Me" });
    const post = async <T>(handler: typeof assignPolicyRoute, action: string, body: unknown) =>
      callRoute<T>(handler, {
        method: "POST",
        path: `/api/employees/${employee.id}/${action}`,
        params: { id: employee.id },
        jar,
        body,
      });

    const p = await post<EmployeeResponse>(assignPolicyRoute, "assign-policy", {
      policyId: policy.id,
    });
    expect(p.status).toBe(200);
    expect(p.body.employee.policyOverride).toEqual({ id: policy.id, name: "Assigned" });
    expect(p.body.employee.resolvedPolicy?.resolvedFrom).toBe("EMPLOYEE");

    const b = await post<EmployeeResponse>(assignBreakPolicyRoute, "assign-break-policy", {
      breakPolicyId: breakPolicy.id,
    });
    expect(b.status).toBe(200);
    expect(b.body.employee.breakPolicyOverride).toEqual({
      id: breakPolicy.id,
      name: "Assigned breaks",
    });

    const cleared = await post<EmployeeResponse>(assignPolicyRoute, "assign-policy", {
      policyId: null,
    });
    expect(cleared.body.employee.policyOverride).toBeNull();

    const l = await post<EmployeeResponse>(assignLocationRoute, "assign-location", {
      primaryLocationId: location.id,
      locationIds: [other.id],
    });
    expect(l.status).toBe(200);
    expect(l.body.employee.primaryLocation?.id).toBe(location.id);
    expect(l.body.employee.locations.map((x) => x.id).sort()).toEqual(
      [location.id, other.id].sort(),
    );
    const emptyLocation = await post<ErrorBody>(assignLocationRoute, "assign-location", {});
    expect(emptyLocation.status).toBe(400);

    const t = await post<EmployeeResponse>(assignTeamRoute, "assign-team", { teamIds: [team.id] });
    expect(t.body.employee.teams).toEqual([{ id: team.id, name: "Team" }]);

    const actions = await prisma.auditLog.findMany({
      where: { organisationId: org.organisation.id, entityId: employee.id },
      select: { action: true },
    });
    expect(actions.map((a) => a.action).sort()).toEqual(
      [
        "employee.created",
        "employee.policy_assigned",
        "employee.policy_assigned",
        "employee.break_policy_assigned",
        "employee.location_assigned",
        "employee.teams_assigned",
      ].sort(),
    );

    const archived = await post<EmployeeResponse>(archiveRoute, "archive", {});
    expect(archived.status).toBe(200);
    expect(archived.body.employee.employmentStatus).toBe("INACTIVE");
    const list = await callRoute<ListEmployeesResponse>(listRoute, { path: "/api/employees", jar });
    expect(list.body.items.map((e) => e.id)).not.toContain(employee.id);
  });
});

describe("POST /api/employees/bulk", () => {
  it("applies per employee and reports failures without aborting the batch", async () => {
    const { org, jar, location } = await setup();
    const a = await createEmployee(jar, { firstName: "Bulk", lastName: "A" });
    const b = await createEmployee(jar, { firstName: "Bulk", lastName: "B" });
    const foreign = await createTestOrg();
    const stranger = await prisma.employee.create({
      data: { organisationId: foreign.organisation.id, firstName: "Not", lastName: "Yours" },
    });

    const res = await callRoute<BulkEmployeeActionResponse>(bulkRoute, {
      method: "POST",
      path: "/api/employees/bulk",
      jar,
      body: {
        action: "ASSIGN_LOCATION",
        employeeIds: [a.id, b.id, stranger.id],
        payload: { primaryLocationId: location.id },
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const parsed = bulkEmployeeActionResponseSchema.parse(res.body);
    expect(parsed).toMatchObject({ action: "ASSIGN_LOCATION", processed: 3, succeeded: 2 });
    expect(parsed.failed).toEqual([
      { employeeId: stranger.id, code: "EMPLOYEE_NOT_FOUND", message: expect.any(String) },
    ]);
    expect(
      (await prisma.employee.findUniqueOrThrow({ where: { id: stranger.id } })).primaryLocationId,
    ).toBeNull();

    const invited = await callRoute<BulkEmployeeActionResponse>(bulkRoute, {
      method: "POST",
      path: "/api/employees/bulk",
      jar,
      body: { action: "INVITE", employeeIds: [a.id, b.id] },
    });
    expect(invited.body.succeeded).toBe(2);
    expect(
      await prisma.employeeInvite.count({ where: { organisationId: org.organisation.id } }),
    ).toBe(2);

    const deactivated = await callRoute<BulkEmployeeActionResponse>(bulkRoute, {
      method: "POST",
      path: "/api/employees/bulk",
      jar,
      body: { action: "DEACTIVATE", employeeIds: [a.id], payload: { reason: "Seasonal" } },
    });
    expect(deactivated.body.succeeded).toBe(1);
    expect(
      (await prisma.employee.findUniqueOrThrow({ where: { id: a.id } })).employmentStatus,
    ).toBe("INACTIVE");

    const invalid = await callRoute<ErrorBody>(bulkRoute, {
      method: "POST",
      path: "/api/employees/bulk",
      jar,
      body: { action: "ASSIGN_LOCATION", employeeIds: [], payload: { primaryLocationId: null } },
    });
    expect(invalid.status).toBe(400);
  });

  it("bulk EMAIL invites draw on the per-IP invite rate limit, so one request cannot send hundreds of emails", async () => {
    const { jar } = await setup();
    const c = await createEmployee(jar, {
      firstName: "Mail",
      lastName: "C",
      email: "bulk-c@example.test",
    });
    const d = await createEmployee(jar, {
      firstName: "Mail",
      lastName: "D",
      email: "bulk-d@example.test",
    });
    const ip = "203.0.113.77";
    const rule = RATE_LIMITS.employeeInvite;
    // Spend all but one hit of this address's budget (the limiter is fresh for every test).
    const limiter = getRateLimiter();
    for (let i = 0; i < rule.limit - 1; i++) {
      await limiter.hit(rateLimitKey(rule.key, ip), rule.limit, rule.windowSeconds);
    }

    const res = await callRoute<BulkEmployeeActionResponse>(bulkRoute, {
      method: "POST",
      path: "/api/employees/bulk",
      jar,
      ip,
      body: { action: "INVITE", employeeIds: [c.id, d.id], payload: { channel: "EMAIL" } },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ action: "INVITE", processed: 2, succeeded: 1 });
    expect(res.body.failed).toEqual([
      { employeeId: d.id, code: "RATE_LIMITED", message: expect.any(String) },
    ]);
    expect(testEmails().sent.map((m) => m.to)).toEqual(["bulk-c@example.test"]);
    expect(await prisma.employeeInvite.count({ where: { employeeId: d.id } })).toBe(0);

    // Same budget as the single-invite route from that address…
    const single = await callRoute<ErrorBody>(createInviteRoute, {
      method: "POST",
      path: `/api/employees/${d.id}/invites`,
      params: { id: d.id },
      jar,
      ip,
      body: { channel: "EMAIL" },
    });
    expect(single.status).toBe(429);
    expect(single.body.error.code).toBe("RATE_LIMITED");

    // …while LINK invites deliver nothing and are not throttled.
    const links = await callRoute<BulkEmployeeActionResponse>(bulkRoute, {
      method: "POST",
      path: "/api/employees/bulk",
      jar,
      ip,
      body: { action: "INVITE", employeeIds: [d.id] },
    });
    expect(links.status).toBe(200);
    expect(links.body).toMatchObject({ succeeded: 1, failed: [] });
    expect(testEmails().sent).toHaveLength(1);
  });
});

describe("state, shifts and activity", () => {
  it("GET /state computes the expected state live and lists the timeline", async () => {
    const { org, jar } = await setup();
    const breakPolicy = await seedBreakPolicy(org.organisation.id, "Default breaks");
    await prisma.organisation.update({
      where: { id: org.organisation.id },
      data: { defaultBreakPolicyId: breakPolicy.id },
    });
    const { employee, device } = await createTestDevice(org.organisation.id);
    await prisma.device.update({
      where: { id: device.id },
      data: {
        permissionState: "APPROVED",
        selectionState: "CONFIGURED",
        lastDeviceSyncAt: new Date(),
      },
    });
    await prisma.employee.update({
      where: { id: employee.id },
      data: { inviteStatus: "CONNECTED" },
    });
    const now = Date.now();
    const shift = await seedShift(org, employee.id, new Date(now - HOUR), new Date(now + 3 * HOUR));
    await recordActivity({
      organisationId: org.organisation.id,
      employeeId: employee.id,
      deviceId: device.id,
      actorType: "EMPLOYEE_DEVICE",
      type: "EMPLOYEE_JOINED",
      occurredAt: new Date(now - 2 * HOUR),
    });

    const res = await callRoute<EmployeeStateResponse>(stateRoute, {
      path: `/api/employees/${employee.id}/state`,
      params: { id: employee.id },
      jar,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const state = employeeStateResponseSchema.parse(res.body);
    expect(state.employee.id).toBe(employee.id);
    expect(state.expected.state).toBe("WORKING");
    expect(state.expected.activeShift?.id).toBe(shift.id);
    expect(state.activeShift?.id).toBe(shift.id);
    expect(state.activeBreak).toBeNull();
    expect(state.breakAllowance).toMatchObject({ breaksTaken: 0, breaksRemaining: 2 });
    expect(state.deviceStatus?.badge).toBe("WORKING");
    expect(state.reported).toEqual({ state: null, reportedAt: null });
    expect(state.diverged).toBe(false);
    expect(state.activeOverrides).toEqual([]);
    expect(state.timeline.map((e) => e.type)).toEqual(["EMPLOYEE_JOINED"]);
    expect(state.timeline[0]?.summary).toContain("joined");

    const badRange = await callRoute<ErrorBody>(stateRoute, {
      path: `/api/employees/${employee.id}/state`,
      params: { id: employee.id },
      jar,
      query: { from: "2026-10-06T10:00:00Z", to: "2026-10-06T09:00:00Z" },
    });
    expect(badRange.status).toBe(400);
  });

  it("GET /shifts and /activity are scoped to the employee and paginate", async () => {
    const { org, jar } = await setup();
    const a = await createEmployee(jar, { firstName: "Shift", lastName: "Worker" });
    const b = await createEmployee(jar, { firstName: "Other", lastName: "Worker" });
    const now = Date.now();
    const mine = await seedShift(org, a.id, new Date(now + HOUR), new Date(now + 5 * HOUR));
    await seedShift(org, b.id, new Date(now + HOUR), new Date(now + 5 * HOUR));

    const shifts = await callRoute<ListShiftsResponse>(shiftsRoute, {
      path: `/api/employees/${a.id}/shifts`,
      params: { id: a.id },
      jar,
    });
    expect(shifts.status, JSON.stringify(shifts.body)).toBe(200);
    expect(shifts.body.shifts.map((s) => s.id)).toEqual([mine.id]);
    expect(shifts.body.shifts[0]?.employee.id).toBe(a.id);

    for (let i = 0; i < 3; i++) {
      await recordActivity({
        organisationId: org.organisation.id,
        employeeId: a.id,
        actorType: "MANAGER",
        actorUserId: org.owner.id,
        type: i === 1 ? "SHIFT_UPDATED" : "SHIFT_CREATED",
        occurredAt: new Date(now - (3 - i) * 60_000),
        metadata: { shiftId: mine.id },
      });
    }
    await recordActivity({
      organisationId: org.organisation.id,
      employeeId: b.id,
      actorType: "SYSTEM",
      type: "SHIFT_CREATED",
    });

    const first = await callRoute<ListActivityResponse>(activityRoute, {
      path: `/api/employees/${a.id}/activity`,
      params: { id: a.id },
      jar,
      query: { limit: 2 },
    });
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.items[0]?.type).toBe("SHIFT_CREATED");
    expect(first.body.items[0]?.actor?.id).toBe(org.owner.id);
    expect(first.body.items[0]?.summary).toContain("(by ");
    expect(first.body.nextCursor).not.toBeNull();

    const second = await callRoute<ListActivityResponse>(activityRoute, {
      path: `/api/employees/${a.id}/activity`,
      params: { id: a.id },
      jar,
      query: { limit: 2, cursor: first.body.nextCursor! },
    });
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();

    const filtered = await callRoute<ListActivityResponse>(activityRoute, {
      path: `/api/employees/${a.id}/activity`,
      params: { id: a.id },
      jar,
      query: { type: "SHIFT_UPDATED" },
    });
    expect(filtered.body.items.map((e) => e.type)).toEqual(["SHIFT_UPDATED"]);

    const badCursor = await callRoute<ErrorBody>(activityRoute, {
      path: `/api/employees/${a.id}/activity`,
      params: { id: a.id },
      jar,
      query: { cursor: "nonsense" },
    });
    expect(badCursor.status).toBe(400);
  });
});
