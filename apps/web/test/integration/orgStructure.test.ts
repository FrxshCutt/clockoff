import { prisma, type Plan } from "@workmode/db";
import type {
  DepartmentResponse,
  ListDepartmentsResponse,
  ListLocationsResponse,
  ListTeamsResponse,
  LocationResponse,
  TeamResponse,
} from "@workmode/validation/locationsTeams";
import { describe, expect, it } from "vitest";
import {
  DELETE as deleteDepartmentRoute,
  GET as getDepartmentRoute,
  PATCH as patchDepartmentRoute,
} from "@/app/api/departments/[id]/route";
import {
  GET as listDepartmentsRoute,
  POST as createDepartmentRoute,
} from "@/app/api/departments/route";
import {
  DELETE as deleteLocationRoute,
  GET as getLocationRoute,
  PATCH as patchLocationRoute,
} from "@/app/api/locations/[id]/route";
import { GET as listLocationsRoute, POST as createLocationRoute } from "@/app/api/locations/route";
import { DELETE as removeMemberRoute } from "@/app/api/teams/[id]/members/[employeeId]/route";
import { POST as addMembersRoute } from "@/app/api/teams/[id]/members/route";
import {
  DELETE as deleteTeamRoute,
  GET as getTeamRoute,
  PATCH as patchTeamRoute,
} from "@/app/api/teams/[id]/route";
import { GET as listTeamsRoute, POST as createTeamRoute } from "@/app/api/teams/route";
import { getEventBus, type RealtimeEvent } from "@/server/events";
import {
  addMember,
  callRoute,
  createTestOrg,
  createTestUser,
  loginAs,
  type CookieJar,
  type ErrorBody,
  type TestOrg,
} from "../helpers";

async function setup(plan: Plan = "BUSINESS") {
  const org = await createTestOrg();
  if (plan !== org.organisation.plan) {
    await prisma.organisation.update({ where: { id: org.organisation.id }, data: { plan } });
  }
  const jar = await loginAs(org.owner, { organisationId: org.organisation.id });
  return { org, jar };
}

async function createLocation(jar: CookieJar, body: Record<string, unknown>, expectStatus = 201) {
  const res = await callRoute<LocationResponse & ErrorBody>(createLocationRoute, {
    method: "POST",
    path: "/api/locations",
    jar,
    body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(expectStatus);
  return res.body;
}

async function createEmployee(
  org: TestOrg,
  data: {
    primaryLocationId?: string;
    departmentId?: string;
    employmentStatus?: "ACTIVE" | "INACTIVE";
  } = {},
) {
  return prisma.employee.create({
    data: {
      organisationId: org.organisation.id,
      firstName: "Sam",
      lastName: `Worker ${Math.random().toString(36).slice(2, 6)}`,
      ...data,
    },
  });
}

async function createPolicy(org: TestOrg, name: string) {
  return prisma.policy.create({
    data: { organisationId: org.organisation.id, name, status: "ACTIVE" },
  });
}

async function createBreakPolicy(org: TestOrg, name: string) {
  return prisma.breakPolicy.create({ data: { organisationId: org.organisation.id, name } });
}

// ── Locations ───────────────────────────────────────────────────────────────

describe("locations", () => {
  it("creates, lists (sorted by name, with counts and assignments) and reads a location", async () => {
    const { org, jar } = await setup();
    const zebra = await createLocation(jar, { name: "Zebra Street", timezone: "Europe/Paris" });
    expect(zebra.location).toMatchObject({
      name: "Zebra Street",
      timezone: "Europe/Paris",
      address: null,
      employeeCount: 0,
      teamCount: 0,
      policyAssignment: null,
      breakPolicyAssignment: null,
    });
    const apple = await createLocation(jar, { name: "Apple Lane", address: "1 Apple Lane" });

    // Two employees at Apple Lane (one primary, one via an additional link, one both → distinct = 2),
    // one team there, and an active Work Policy + Break Policy assignment for the location scope.
    const primary = await createEmployee(org, { primaryLocationId: apple.location.id });
    const linked = await createEmployee(org);
    await prisma.employeeLocation.createMany({
      data: [
        { employeeId: linked.id, locationId: apple.location.id },
        { employeeId: primary.id, locationId: apple.location.id },
      ],
    });
    await prisma.team.create({
      data: {
        organisationId: org.organisation.id,
        name: "Baristas",
        locationId: apple.location.id,
      },
    });
    const policy = await createPolicy(org, "Front of house");
    const breakPolicy = await createBreakPolicy(org, "Standard breaks");
    await prisma.policyAssignment.create({
      data: {
        organisationId: org.organisation.id,
        policyId: policy.id,
        scopeType: "LOCATION",
        scopeId: apple.location.id,
      },
    });
    await prisma.breakPolicyAssignment.create({
      data: {
        organisationId: org.organisation.id,
        breakPolicyId: breakPolicy.id,
        scopeType: "LOCATION",
        scopeId: apple.location.id,
        effectiveTo: new Date(Date.now() - 60_000), // ended → must not show
      },
    });

    const list = await callRoute<ListLocationsResponse>(listLocationsRoute, {
      path: "/api/locations",
      jar,
    });
    expect(list.status).toBe(200);
    expect(list.body.locations.map((l) => l.name)).toEqual(["Apple Lane", "Zebra Street"]);
    expect(list.body.locations[0]).toMatchObject({
      employeeCount: 2,
      teamCount: 1,
      policyAssignment: { policy: { id: policy.id, name: "Front of house" }, effectiveTo: null },
      breakPolicyAssignment: null,
    });

    const one = await callRoute<LocationResponse>(getLocationRoute, {
      path: `/api/locations/${apple.location.id}`,
      params: { id: apple.location.id },
      jar,
    });
    expect(one.status).toBe(200);
    expect(one.body.location).toMatchObject({
      id: apple.location.id,
      employeeCount: 2,
      teamCount: 1,
    });

    const auditRow = await prisma.auditLog.findFirst({
      where: {
        organisationId: org.organisation.id,
        action: "location.created",
        entityId: zebra.location.id,
      },
    });
    expect(auditRow?.after).toMatchObject({ name: "Zebra Street", timezone: "Europe/Paris" });
  });

  it("rejects duplicate names (case-insensitive), invalid timezones and unknown fields", async () => {
    const { jar } = await setup();
    await createLocation(jar, { name: "High Street" });
    const dup = await createLocation(jar, { name: "high street" }, 409);
    expect(dup.error.code).toBe("CONFLICT");
    expect(dup.error.details).toMatchObject({ field: "name" });

    const badTz = await createLocation(jar, { name: "Mars", timezone: "Mars/Olympus" }, 400);
    expect(badTz.error.code).toBe("VALIDATION_ERROR");

    const extra = await createLocation(jar, { name: "Extra", foo: 1 }, 400);
    expect(extra.error.code).toBe("VALIDATION_ERROR");
  });

  it("enforces the plan's location limit (STARTER: 1)", async () => {
    const { org, jar } = await setup("STARTER");
    await createLocation(jar, { name: "Only one" });
    const blocked = await createLocation(jar, { name: "Second" }, 409);
    expect(blocked.error.code).toBe("CONFLICT");
    expect(blocked.error.details).toMatchObject({
      reason: "PLAN_LIMIT_REACHED",
      metric: "locations",
      limit: 1,
      current: 1,
    });
    expect(await prisma.location.count({ where: { organisationId: org.organisation.id } })).toBe(1);
  });

  it("PATCH renames, clears the timezone / address and audits; a taken name conflicts", async () => {
    const { org, jar } = await setup();
    const a = await createLocation(jar, {
      name: "Alpha",
      timezone: "Europe/Berlin",
      address: "A 1",
    });
    await createLocation(jar, { name: "Beta" });

    const patched = await callRoute<LocationResponse>(patchLocationRoute, {
      method: "PATCH",
      path: `/api/locations/${a.location.id}`,
      params: { id: a.location.id },
      jar,
      body: { name: "Alpha Renamed", timezone: null, address: "" },
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.location).toMatchObject({
      name: "Alpha Renamed",
      timezone: null,
      address: null,
    });

    const conflict = await callRoute<ErrorBody>(patchLocationRoute, {
      method: "PATCH",
      path: `/api/locations/${a.location.id}`,
      params: { id: a.location.id },
      jar,
      body: { name: "BETA" },
    });
    expect(conflict.status).toBe(409);

    const auditRow = await prisma.auditLog.findFirst({
      where: {
        organisationId: org.organisation.id,
        action: "location.updated",
        entityId: a.location.id,
      },
    });
    expect(auditRow?.before).toMatchObject({ name: "Alpha", timezone: "Europe/Berlin" });
    expect(auditRow?.after).toMatchObject({ name: "Alpha Renamed", timezone: null, address: null });
  });

  it("refuses to delete a location with scheduled shifts, then soft-deletes and detaches everything", async () => {
    const { org, jar } = await setup();
    const { location } = await createLocation(jar, { name: "Closing Down" });
    const employee = await createEmployee(org, { primaryLocationId: location.id });
    const other = await createEmployee(org);
    await prisma.employeeLocation.create({
      data: { employeeId: other.id, locationId: location.id },
    });
    const team = await prisma.team.create({
      data: { organisationId: org.organisation.id, name: "Closers", locationId: location.id },
    });
    const policy = await createPolicy(org, "Site policy");
    const assignment = await prisma.policyAssignment.create({
      data: {
        organisationId: org.organisation.id,
        policyId: policy.id,
        scopeType: "LOCATION",
        scopeId: location.id,
      },
    });
    const soon = new Date(Date.now() + 24 * 3600_000);
    const shift = await prisma.shift.create({
      data: {
        organisationId: org.organisation.id,
        employeeId: employee.id,
        locationId: location.id,
        startsAt: soon,
        endsAt: new Date(soon.getTime() + 8 * 3600_000),
        timezone: "Europe/London",
      },
    });
    const pastShift = await prisma.shift.create({
      data: {
        organisationId: org.organisation.id,
        employeeId: employee.id,
        locationId: location.id,
        startsAt: new Date(Date.now() - 48 * 3600_000),
        endsAt: new Date(Date.now() - 40 * 3600_000),
        timezone: "Europe/London",
        status: "COMPLETED",
      },
    });

    const blocked = await callRoute<ErrorBody>(deleteLocationRoute, {
      method: "DELETE",
      path: `/api/locations/${location.id}`,
      params: { id: location.id },
      jar,
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("CONFLICT");
    expect(blocked.body.error.details).toMatchObject({
      reason: "UPCOMING_SHIFTS",
      upcomingShiftCount: 1,
    });

    await prisma.shift.update({ where: { id: shift.id }, data: { status: "CANCELLED" } });

    const events: RealtimeEvent[] = [];
    getEventBus().subscribe(org.organisation.id, (event) => events.push(event));

    const deleted = await callRoute(deleteLocationRoute, {
      method: "DELETE",
      path: `/api/locations/${location.id}`,
      params: { id: location.id },
      jar,
    });
    expect(deleted.status).toBe(204);

    const row = await prisma.location.findUniqueOrThrow({ where: { id: location.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(
      (await prisma.employee.findUniqueOrThrow({ where: { id: employee.id } })).primaryLocationId,
    ).toBeNull();
    expect(await prisma.employeeLocation.count({ where: { locationId: location.id } })).toBe(0);
    expect((await prisma.team.findUniqueOrThrow({ where: { id: team.id } })).locationId).toBeNull();
    expect(
      (await prisma.shift.findUniqueOrThrow({ where: { id: pastShift.id } })).locationId,
    ).toBeNull();
    expect(
      (await prisma.policyAssignment.findUniqueOrThrow({ where: { id: assignment.id } }))
        .effectiveTo,
    ).not.toBeNull();

    const policyEvent = events.find((e) => e.type === "POLICY_CHANGED");
    expect(policyEvent?.payload).toMatchObject({ policyId: policy.id, reason: "UNASSIGNED" });
    expect(policyEvent?.payload.affectedEmployeeIds).toEqual(
      expect.arrayContaining([employee.id, other.id]),
    );

    const gone = await callRoute<ErrorBody>(getLocationRoute, {
      path: `/api/locations/${location.id}`,
      params: { id: location.id },
      jar,
    });
    expect(gone.status).toBe(404);
    const list = await callRoute<ListLocationsResponse>(listLocationsRoute, {
      path: "/api/locations",
      jar,
    });
    expect(list.body.locations.map((l) => l.id)).not.toContain(location.id);

    const auditRow = await prisma.auditLog.findFirst({
      where: {
        organisationId: org.organisation.id,
        action: "location.deleted",
        entityId: location.id,
      },
    });
    expect(auditRow?.after).toMatchObject({
      employeesDetached: 1,
      employeeLinksRemoved: 1,
      teamsDetached: 1,
      shiftsDetached: 2,
      policyAssignmentsEnded: 1,
    });
  });

  it("structure mutations need org:manage (ADMIN yes, MANAGER no); MANAGER still reads and manages team members", async () => {
    const { org } = await setup();
    const { user: manager } = await createTestUser();
    await addMember(org.organisation.id, manager, "MANAGER");
    const managerJar = await loginAs(manager, { organisationId: org.organisation.id });
    const { user: admin } = await createTestUser();
    await addMember(org.organisation.id, admin, "ADMIN");
    const adminJar = await loginAs(admin, { organisationId: org.organisation.id });

    const { location } = await createLocation(adminJar, { name: "Admin made" });
    const forbiddenCreate = await createLocation(managerJar, { name: "Manager made" }, 403);
    expect(forbiddenCreate.error.code).toBe("FORBIDDEN");
    const forbiddenPatch = await callRoute<ErrorBody>(patchLocationRoute, {
      method: "PATCH",
      path: `/api/locations/${location.id}`,
      params: { id: location.id },
      jar: managerJar,
      body: { name: "Hijacked" },
    });
    expect(forbiddenPatch.status).toBe(403);
    const forbiddenDelete = await callRoute<ErrorBody>(deleteLocationRoute, {
      method: "DELETE",
      path: `/api/locations/${location.id}`,
      params: { id: location.id },
      jar: managerJar,
    });
    expect(forbiddenDelete.status).toBe(403);
    const forbiddenDepartment = await callRoute<ErrorBody>(createDepartmentRoute, {
      method: "POST",
      path: "/api/departments",
      jar: managerJar,
      body: { name: "Kitchen" },
    });
    expect(forbiddenDepartment.status).toBe(403);
    const forbiddenTeam = await callRoute<ErrorBody>(createTeamRoute, {
      method: "POST",
      path: "/api/teams",
      jar: managerJar,
      body: { name: "Crew" },
    });
    expect(forbiddenTeam.status).toBe(403);
    expect(await prisma.location.count({ where: { organisationId: org.organisation.id } })).toBe(1);
    expect((await prisma.location.findUniqueOrThrow({ where: { id: location.id } })).name).toBe(
      "Admin made",
    );
    expect(await prisma.department.count({ where: { organisationId: org.organisation.id } })).toBe(
      0,
    );
    expect(await prisma.team.count({ where: { organisationId: org.organisation.id } })).toBe(0);

    // Reads are open to every manager; team membership is employees:write.
    const list = await callRoute<ListLocationsResponse>(listLocationsRoute, {
      path: "/api/locations",
      jar: managerJar,
    });
    expect(list.status).toBe(200);
    expect(list.body.locations.map((l) => l.name)).toEqual(["Admin made"]);
    const team = await prisma.team.create({
      data: { organisationId: org.organisation.id, name: "Crew" },
    });
    const employee = await createEmployee(org);
    const added = await callRoute<TeamResponse>(addMembersRoute, {
      method: "POST",
      path: `/api/teams/${team.id}/members`,
      params: { id: team.id },
      jar: managerJar,
      body: { employeeIds: [employee.id] },
    });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    expect(added.body.team.memberCount).toBe(1);

    const anonymous = await callRoute<ErrorBody>(listLocationsRoute, { path: "/api/locations" });
    expect(anonymous.status).toBe(401);
  });
});

// ── Departments ─────────────────────────────────────────────────────────────

describe("departments", () => {
  it("creates, lists with employee counts, renames, and rejects duplicate names", async () => {
    const { org, jar } = await setup();
    const created = await callRoute<DepartmentResponse>(createDepartmentRoute, {
      method: "POST",
      path: "/api/departments",
      jar,
      body: { name: "Kitchen" },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.department).toMatchObject({ name: "Kitchen", employeeCount: 0 });

    const dup = await callRoute<ErrorBody>(createDepartmentRoute, {
      method: "POST",
      path: "/api/departments",
      jar,
      body: { name: "kitchen" },
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("CONFLICT");

    await createEmployee(org, { departmentId: created.body.department.id });
    const archived = await createEmployee(org, { departmentId: created.body.department.id });
    await prisma.employee.update({ where: { id: archived.id }, data: { deletedAt: new Date() } });

    const list = await callRoute<ListDepartmentsResponse>(listDepartmentsRoute, {
      path: "/api/departments",
      jar,
    });
    expect(list.body.departments).toEqual([
      expect.objectContaining({ id: created.body.department.id, employeeCount: 1 }),
    ]);

    const renamed = await callRoute<DepartmentResponse>(patchDepartmentRoute, {
      method: "PATCH",
      path: `/api/departments/${created.body.department.id}`,
      params: { id: created.body.department.id },
      jar,
      body: { name: "Back of house" },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.department.name).toBe("Back of house");

    const one = await callRoute<DepartmentResponse>(getDepartmentRoute, {
      path: `/api/departments/${created.body.department.id}`,
      params: { id: created.body.department.id },
      jar,
    });
    expect(one.body.department).toMatchObject({ name: "Back of house", employeeCount: 1 });

    expect(
      await prisma.auditLog.count({
        where: {
          organisationId: org.organisation.id,
          action: { in: ["department.created", "department.updated"] },
        },
      }),
    ).toBe(2);
  });

  it("deletes a department and leaves its employees without one", async () => {
    const { org, jar } = await setup();
    const department = await prisma.department.create({
      data: { organisationId: org.organisation.id, name: "Floor" },
    });
    const employee = await createEmployee(org, { departmentId: department.id });

    const res = await callRoute(deleteDepartmentRoute, {
      method: "DELETE",
      path: `/api/departments/${department.id}`,
      params: { id: department.id },
      jar,
    });
    expect(res.status).toBe(204);
    expect(await prisma.department.count({ where: { id: department.id } })).toBe(0);
    expect(
      (await prisma.employee.findUniqueOrThrow({ where: { id: employee.id } })).departmentId,
    ).toBeNull();

    const gone = await callRoute<ErrorBody>(getDepartmentRoute, {
      path: `/api/departments/${department.id}`,
      params: { id: department.id },
      jar,
    });
    expect(gone.status).toBe(404);
    const auditRow = await prisma.auditLog.findFirst({
      where: { organisationId: org.organisation.id, action: "department.deleted" },
    });
    expect(auditRow?.after).toMatchObject({ employeesDetached: 1 });
  });
});

// ── Teams ───────────────────────────────────────────────────────────────────

describe("teams", () => {
  it("creates a team at a location with members, lists by location and shows assignments", async () => {
    const { org, jar } = await setup();
    const { location } = await createLocation(jar, { name: "Harbour" });
    const e1 = await createEmployee(org);
    const e2 = await createEmployee(org);

    const created = await callRoute<TeamResponse>(createTeamRoute, {
      method: "POST",
      path: "/api/teams",
      jar,
      body: { name: "Deck crew", locationId: location.id, employeeIds: [e1.id, e2.id] },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.team).toMatchObject({
      name: "Deck crew",
      location: { id: location.id, name: "Harbour" },
      memberCount: 2,
      policyAssignment: null,
    });
    await callRoute<TeamResponse>(createTeamRoute, {
      method: "POST",
      path: "/api/teams",
      jar,
      body: { name: "Office" },
    });

    const breakPolicy = await createBreakPolicy(org, "Deck breaks");
    await prisma.breakPolicyAssignment.create({
      data: {
        organisationId: org.organisation.id,
        breakPolicyId: breakPolicy.id,
        scopeType: "TEAM",
        scopeId: created.body.team.id,
      },
    });

    const byLocation = await callRoute<ListTeamsResponse>(listTeamsRoute, {
      path: "/api/teams",
      query: { locationId: location.id },
      jar,
    });
    expect(byLocation.status).toBe(200);
    expect(byLocation.body.teams).toHaveLength(1);
    expect(byLocation.body.teams[0]).toMatchObject({
      id: created.body.team.id,
      memberCount: 2,
      breakPolicyAssignment: { policy: { id: breakPolicy.id, name: "Deck breaks" } },
    });
    const all = await callRoute<ListTeamsResponse>(listTeamsRoute, { path: "/api/teams", jar });
    expect(all.body.teams.map((t) => t.name)).toEqual(["Deck crew", "Office"]);

    // A location id from another organisation filters inside this organisation only → nothing.
    const other = await createTestOrg();
    const foreign = await prisma.location.create({
      data: { organisationId: other.organisation.id, name: "Foreign" },
    });
    await prisma.team.create({
      data: { organisationId: other.organisation.id, name: "Foreign crew", locationId: foreign.id },
    });
    const filtered = await callRoute<ListTeamsResponse>(listTeamsRoute, {
      path: "/api/teams",
      query: { locationId: foreign.id },
      jar,
    });
    expect(filtered.status).toBe(200);
    expect(filtered.body.teams).toEqual([]);
  });

  it("rejects unknown employees (EMPLOYEE_NOT_FOUND) and unknown locations (NOT_FOUND)", async () => {
    const { org, jar } = await setup();
    const e1 = await createEmployee(org);
    const ghost = "00000000-0000-4000-8000-000000000001";
    const badEmployee = await callRoute<ErrorBody>(createTeamRoute, {
      method: "POST",
      path: "/api/teams",
      jar,
      body: { name: "Ghosts", employeeIds: [e1.id, ghost] },
    });
    expect(badEmployee.status).toBe(404);
    expect(badEmployee.body.error.code).toBe("EMPLOYEE_NOT_FOUND");
    expect(badEmployee.body.error.details).toEqual({ employeeIds: [ghost] });
    expect(await prisma.team.count({ where: { organisationId: org.organisation.id } })).toBe(0);

    const badLocation = await callRoute<ErrorBody>(createTeamRoute, {
      method: "POST",
      path: "/api/teams",
      jar,
      body: { name: "Nowhere", locationId: ghost },
    });
    expect(badLocation.status).toBe(404);
    expect(badLocation.body.error.code).toBe("NOT_FOUND");
  });

  it("never confirms archived employees or soft-deleted locations", async () => {
    const { org, jar } = await setup();
    const archived = await createEmployee(org);
    await prisma.employee.update({ where: { id: archived.id }, data: { deletedAt: new Date() } });
    const team = await prisma.team.create({
      data: { organisationId: org.organisation.id, name: "Till" },
    });

    const members = await callRoute<ErrorBody>(addMembersRoute, {
      method: "POST",
      path: `/api/teams/${team.id}/members`,
      params: { id: team.id },
      jar,
      body: { employeeIds: [archived.id] },
    });
    expect(members.status).toBe(404);
    expect(members.body.error.code).toBe("EMPLOYEE_NOT_FOUND");
    expect(await prisma.employeeTeam.count({ where: { teamId: team.id } })).toBe(0);

    const closed = await prisma.location.create({
      data: { organisationId: org.organisation.id, name: "Closed", deletedAt: new Date() },
    });
    const moved = await callRoute<ErrorBody>(patchTeamRoute, {
      method: "PATCH",
      path: `/api/teams/${team.id}`,
      params: { id: team.id },
      jar,
      body: { locationId: closed.id },
    });
    expect(moved.status).toBe(404);
    expect(moved.body.error.code).toBe("NOT_FOUND");
    expect((await prisma.team.findUniqueOrThrow({ where: { id: team.id } })).locationId).toBeNull();
  });

  it("adds members idempotently, replaces the set on request and removes one member", async () => {
    const { org, jar } = await setup();
    const [e1, e2, e3] = await Promise.all([
      createEmployee(org),
      createEmployee(org),
      createEmployee(org),
    ]);
    const team = await prisma.team.create({
      data: { organisationId: org.organisation.id, name: "Till" },
    });
    await prisma.employeeTeam.create({ data: { teamId: team.id, employeeId: e1.id } });

    const added = await callRoute<TeamResponse>(addMembersRoute, {
      method: "POST",
      path: `/api/teams/${team.id}/members`,
      params: { id: team.id },
      jar,
      body: { employeeIds: [e1.id, e2.id] },
    });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    expect(added.body.team.memberCount).toBe(2);

    const replaced = await callRoute<TeamResponse>(addMembersRoute, {
      method: "POST",
      path: `/api/teams/${team.id}/members`,
      params: { id: team.id },
      jar,
      body: { employeeIds: [e3.id], replace: true },
    });
    expect(replaced.status).toBe(200);
    expect(replaced.body.team.memberCount).toBe(1);
    expect(await prisma.employeeTeam.findMany({ where: { teamId: team.id } })).toEqual([
      expect.objectContaining({ employeeId: e3.id }),
    ]);

    const removed = await callRoute(removeMemberRoute, {
      method: "DELETE",
      path: `/api/teams/${team.id}/members/${e3.id}`,
      params: { id: team.id, employeeId: e3.id },
      jar,
    });
    expect(removed.status).toBe(204);
    const again = await callRoute<ErrorBody>(removeMemberRoute, {
      method: "DELETE",
      path: `/api/teams/${team.id}/members/${e3.id}`,
      params: { id: team.id, employeeId: e3.id },
      jar,
    });
    expect(again.status).toBe(404);

    const empty = await callRoute<ErrorBody>(addMembersRoute, {
      method: "POST",
      path: `/api/teams/${team.id}/members`,
      params: { id: team.id },
      jar,
      body: { employeeIds: [] },
    });
    expect(empty.status).toBe(400);

    const actions = await prisma.auditLog.findMany({
      where: { organisationId: org.organisation.id, entityType: "Team", entityId: team.id },
      select: { action: true },
    });
    expect(actions.map((a) => a.action).sort()).toEqual([
      "team.member_removed",
      "team.members_added",
      "team.members_replaced",
    ]);
  });

  it("PATCH detaches the location, DELETE ends the team's assignments and publishes the change", async () => {
    const { org, jar } = await setup();
    const { location } = await createLocation(jar, { name: "Pier" });
    const team = await prisma.team.create({
      data: { organisationId: org.organisation.id, name: "Pier crew", locationId: location.id },
    });
    const member = await createEmployee(org);
    await prisma.employeeTeam.create({ data: { teamId: team.id, employeeId: member.id } });
    const policy = await createPolicy(org, "Pier policy");
    const assignment = await prisma.policyAssignment.create({
      data: {
        organisationId: org.organisation.id,
        policyId: policy.id,
        scopeType: "TEAM",
        scopeId: team.id,
      },
    });

    const detached = await callRoute<TeamResponse>(patchTeamRoute, {
      method: "PATCH",
      path: `/api/teams/${team.id}`,
      params: { id: team.id },
      jar,
      body: { locationId: null, name: "Pier crew 2" },
    });
    expect(detached.status, JSON.stringify(detached.body)).toBe(200);
    expect(detached.body.team).toMatchObject({
      name: "Pier crew 2",
      location: null,
      policyAssignment: { id: assignment.id, policy: { id: policy.id } },
    });

    const one = await callRoute<TeamResponse>(getTeamRoute, {
      path: `/api/teams/${team.id}`,
      params: { id: team.id },
      jar,
    });
    expect(one.body.team.memberCount).toBe(1);

    const events: RealtimeEvent[] = [];
    getEventBus().subscribe(org.organisation.id, (event) => events.push(event));
    const deleted = await callRoute(deleteTeamRoute, {
      method: "DELETE",
      path: `/api/teams/${team.id}`,
      params: { id: team.id },
      jar,
    });
    expect(deleted.status).toBe(204);
    expect(await prisma.team.count({ where: { id: team.id } })).toBe(0);
    expect(
      (await prisma.policyAssignment.findUniqueOrThrow({ where: { id: assignment.id } }))
        .effectiveTo,
    ).not.toBeNull();
    expect(events.find((e) => e.type === "POLICY_CHANGED")?.payload).toMatchObject({
      policyId: policy.id,
      reason: "UNASSIGNED",
      affectedEmployeeIds: [member.id],
    });
    const gone = await callRoute<ErrorBody>(getTeamRoute, {
      path: `/api/teams/${team.id}`,
      params: { id: team.id },
      jar,
    });
    expect(gone.status).toBe(404);
  });
});
