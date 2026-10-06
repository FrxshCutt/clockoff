import { prisma } from "@workmode/db";
import { expect } from "vitest";
import {
  DELETE as deleteDepartmentRoute,
  GET as getDepartmentRoute,
  PATCH as patchDepartmentRoute,
} from "@/app/api/departments/[id]/route";
import {
  DELETE as deleteLocationRoute,
  GET as getLocationRoute,
  PATCH as patchLocationRoute,
} from "@/app/api/locations/[id]/route";
import { DELETE as removeMemberRoute } from "@/app/api/teams/[id]/members/[employeeId]/route";
import { POST as addMembersRoute } from "@/app/api/teams/[id]/members/route";
import {
  DELETE as deleteTeamRoute,
  GET as getTeamRoute,
  PATCH as patchTeamRoute,
} from "@/app/api/teams/[id]/route";
import { GET as listTeamsRoute, POST as createTeamRoute } from "@/app/api/teams/route";
import { registerTenantIsolationCase } from "../../helpers/tenantIsolation";

/** Locations / departments / teams: org A's owner must never read or alter org B's structure. */

async function locationInOrg(organisationId: string) {
  return prisma.location.create({ data: { organisationId, name: "B site" } });
}
async function departmentInOrg(organisationId: string) {
  return prisma.department.create({ data: { organisationId, name: "B dept" } });
}
async function teamInOrg(organisationId: string) {
  return prisma.team.create({ data: { organisationId, name: "B team" } });
}
async function employeeInOrg(organisationId: string) {
  return prisma.employee.create({ data: { organisationId, firstName: "B", lastName: "Only" } });
}

// ── Locations ───────────────────────────────────────────────────────────────

registerTenantIsolationCase({
  name: "GET /api/locations/:id of another tenant",
  build: async (_a, b) => {
    const location = await locationInOrg(b.organisation.id);
    return { handler: getLocationRoute, path: `/api/locations/${location.id}`, params: { id: location.id } };
  },
  expectCode: "NOT_FOUND",
});

registerTenantIsolationCase({
  name: "PATCH /api/locations/:id of another tenant",
  build: async (_a, b) => {
    const location = await locationInOrg(b.organisation.id);
    return {
      handler: patchLocationRoute,
      method: "PATCH",
      path: `/api/locations/${location.id}`,
      params: { id: location.id },
      body: { name: "Hijacked" },
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (_a, b) => {
    const row = await prisma.location.findFirstOrThrow({ where: { organisationId: b.organisation.id, name: "B site" } });
    expect(row.name).toBe("B site");
  },
});

registerTenantIsolationCase({
  name: "DELETE /api/locations/:id of another tenant",
  build: async (_a, b) => {
    const location = await locationInOrg(b.organisation.id);
    return {
      handler: deleteLocationRoute,
      method: "DELETE",
      path: `/api/locations/${location.id}`,
      params: { id: location.id },
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (_a, b) => {
    const row = await prisma.location.findFirstOrThrow({ where: { organisationId: b.organisation.id, name: "B site" } });
    expect(row.deletedAt).toBeNull();
  },
});

// ── Departments ─────────────────────────────────────────────────────────────

registerTenantIsolationCase({
  name: "GET /api/departments/:id of another tenant",
  build: async (_a, b) => {
    const department = await departmentInOrg(b.organisation.id);
    return {
      handler: getDepartmentRoute,
      path: `/api/departments/${department.id}`,
      params: { id: department.id },
    };
  },
  expectCode: "NOT_FOUND",
});

registerTenantIsolationCase({
  name: "PATCH /api/departments/:id of another tenant",
  build: async (_a, b) => {
    const department = await departmentInOrg(b.organisation.id);
    return {
      handler: patchDepartmentRoute,
      method: "PATCH",
      path: `/api/departments/${department.id}`,
      params: { id: department.id },
      body: { name: "Hijacked" },
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (_a, b) => {
    expect(await prisma.department.count({ where: { organisationId: b.organisation.id, name: "B dept" } })).toBe(1);
  },
});

registerTenantIsolationCase({
  name: "DELETE /api/departments/:id of another tenant",
  build: async (_a, b) => {
    const department = await departmentInOrg(b.organisation.id);
    return {
      handler: deleteDepartmentRoute,
      method: "DELETE",
      path: `/api/departments/${department.id}`,
      params: { id: department.id },
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (_a, b) => {
    expect(await prisma.department.count({ where: { organisationId: b.organisation.id } })).toBe(1);
  },
});

// ── Teams ───────────────────────────────────────────────────────────────────

registerTenantIsolationCase({
  name: "GET /api/teams/:id of another tenant",
  build: async (_a, b) => {
    const team = await teamInOrg(b.organisation.id);
    return { handler: getTeamRoute, path: `/api/teams/${team.id}`, params: { id: team.id } };
  },
  expectCode: "NOT_FOUND",
});

registerTenantIsolationCase({
  name: "PATCH /api/teams/:id of another tenant",
  build: async (_a, b) => {
    const team = await teamInOrg(b.organisation.id);
    return {
      handler: patchTeamRoute,
      method: "PATCH",
      path: `/api/teams/${team.id}`,
      params: { id: team.id },
      body: { name: "Hijacked" },
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (_a, b) => {
    expect(await prisma.team.count({ where: { organisationId: b.organisation.id, name: "B team" } })).toBe(1);
  },
});

registerTenantIsolationCase({
  name: "DELETE /api/teams/:id of another tenant",
  build: async (_a, b) => {
    const team = await teamInOrg(b.organisation.id);
    return { handler: deleteTeamRoute, method: "DELETE", path: `/api/teams/${team.id}`, params: { id: team.id } };
  },
  expectCode: "NOT_FOUND",
  verify: async (_a, b) => {
    expect(await prisma.team.count({ where: { organisationId: b.organisation.id } })).toBe(1);
  },
});

registerTenantIsolationCase({
  name: "POST /api/teams/:id/members on another tenant's team",
  build: async (a, b) => {
    const team = await teamInOrg(b.organisation.id);
    const employee = await employeeInOrg(a.organisation.id);
    return {
      handler: addMembersRoute,
      method: "POST",
      path: `/api/teams/${team.id}/members`,
      params: { id: team.id },
      body: { employeeIds: [employee.id] },
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (_a, b) => {
    expect(await prisma.employeeTeam.count({ where: { team: { organisationId: b.organisation.id } } })).toBe(0);
  },
});

registerTenantIsolationCase({
  name: "POST /api/teams/:id/members with another tenant's employee",
  build: async (a, b) => {
    const team = await teamInOrg(a.organisation.id);
    const employee = await employeeInOrg(b.organisation.id);
    return {
      handler: addMembersRoute,
      method: "POST",
      path: `/api/teams/${team.id}/members`,
      params: { id: team.id },
      body: { employeeIds: [employee.id] },
    };
  },
  expectCode: "EMPLOYEE_NOT_FOUND",
  verify: async (a) => {
    expect(await prisma.employeeTeam.count({ where: { team: { organisationId: a.organisation.id } } })).toBe(0);
  },
});

registerTenantIsolationCase({
  name: "POST /api/teams with another tenant's location",
  build: async (_a, b) => {
    const location = await locationInOrg(b.organisation.id);
    return {
      handler: createTeamRoute,
      method: "POST",
      path: "/api/teams",
      body: { name: "Borrowed site", locationId: location.id },
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (a) => {
    expect(await prisma.team.count({ where: { organisationId: a.organisation.id } })).toBe(0);
  },
});

registerTenantIsolationCase({
  name: "DELETE /api/teams/:id/members/:employeeId of another tenant",
  build: async (_a, b) => {
    const team = await teamInOrg(b.organisation.id);
    const employee = await employeeInOrg(b.organisation.id);
    await prisma.employeeTeam.create({ data: { teamId: team.id, employeeId: employee.id } });
    return {
      handler: removeMemberRoute,
      method: "DELETE",
      path: `/api/teams/${team.id}/members/${employee.id}`,
      params: { id: team.id, employeeId: employee.id },
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (_a, b) => {
    expect(await prisma.employeeTeam.count({ where: { team: { organisationId: b.organisation.id } } })).toBe(1);
  },
});

registerTenantIsolationCase({
  name: "GET /api/teams filtered by another tenant's location",
  build: async (_a, b) => {
    const location = await locationInOrg(b.organisation.id);
    await prisma.team.create({
      data: { organisationId: b.organisation.id, name: "B team at site", locationId: location.id },
    });
    return { handler: listTeamsRoute, path: "/api/teams", query: { locationId: location.id } };
  },
  // The filter is honoured inside org A only, so the answer is an empty list (asserted in orgStructure.test.ts).
  expectStatus: 200,
});
