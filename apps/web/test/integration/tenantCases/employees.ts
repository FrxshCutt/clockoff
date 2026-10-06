import { randomUUID } from "node:crypto";
import { prisma } from "@workmode/db";
import { expect } from "vitest";
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
import { GET as instructionsRoute } from "@/app/api/invites/[id]/instructions/route";
import { POST as resendRoute } from "@/app/api/invites/[id]/resend/route";
import { POST as revokeRoute } from "@/app/api/invites/[id]/revoke/route";
import type { RouteHandler } from "@/server/http/apiHandler";
import type { TenantFixture } from "../../helpers/tenantIsolation";
import { registerTenantIsolationCase } from "../../helpers/tenantIsolation";

/**
 * Employees and employee invites: org A's owner must never read or change org B's people. Every by-id
 * route answers 404 (EMPLOYEE_NOT_FOUND / INVITE_INVALID), never 403, and B's rows stay untouched.
 */

async function seedEmployeeIn(
  b: TenantFixture,
  data: { employmentStatus?: "ACTIVE" | "INACTIVE" } = {},
) {
  return prisma.employee.create({
    data: {
      organisationId: b.organisation.id,
      firstName: "Belongs",
      lastName: "ToB",
      jobTitle: "Original",
      employmentStatus: data.employmentStatus ?? "ACTIVE",
    },
  });
}

/** B's only employee (each case gets fresh organisations). */
async function employeeOf(b: TenantFixture) {
  return prisma.employee.findFirstOrThrow({ where: { organisationId: b.organisation.id } });
}

async function expectEmployeeUntouched(b: TenantFixture): Promise<void> {
  const row = await employeeOf(b);
  expect(row).toMatchObject({
    jobTitle: "Original",
    primaryLocationId: null,
    deletedAt: null,
  });
  expect(await prisma.employeeTeam.count({ where: { employeeId: row.id } })).toBe(0);
  expect(await prisma.policyAssignment.count({ where: { scopeId: row.id } })).toBe(0);
  expect(await prisma.breakPolicyAssignment.count({ where: { scopeId: row.id } })).toBe(0);
  expect(await prisma.employeeInvite.count({ where: { employeeId: row.id } })).toBe(0);
  expect(await prisma.auditLog.count({ where: { organisationId: b.organisation.id, entityId: row.id } })).toBe(0);
}

const employeeReads: Array<{ name: string; handler: RouteHandler; suffix: string }> = [
  { name: "GET /api/employees/:id", handler: getRoute, suffix: "" },
  { name: "GET /api/employees/:id/state", handler: stateRoute, suffix: "/state" },
  { name: "GET /api/employees/:id/shifts", handler: shiftsRoute, suffix: "/shifts" },
  { name: "GET /api/employees/:id/activity", handler: activityRoute, suffix: "/activity" },
];

for (const read of employeeReads) {
  registerTenantIsolationCase({
    name: `${read.name} of another tenant`,
    build: async (_a, b) => {
      const employee = await seedEmployeeIn(b);
      return {
        handler: read.handler,
        path: `/api/employees/${employee.id}${read.suffix}`,
        params: { id: employee.id },
      };
    },
    expectCode: "EMPLOYEE_NOT_FOUND",
  });
}

const employeeWrites: Array<{
  name: string;
  handler: RouteHandler;
  method: "POST" | "PATCH" | "DELETE";
  suffix: string;
  body?: unknown;
  employmentStatus?: "ACTIVE" | "INACTIVE";
}> = [
  { name: "PATCH /api/employees/:id", handler: patchRoute, method: "PATCH", suffix: "", body: { jobTitle: "Hijacked" } },
  { name: "DELETE /api/employees/:id", handler: deleteRoute, method: "DELETE", suffix: "" },
  { name: "POST /api/employees/:id/deactivate", handler: deactivateRoute, method: "POST", suffix: "/deactivate", body: { reason: "cross-tenant" } },
  { name: "POST /api/employees/:id/reactivate", handler: reactivateRoute, method: "POST", suffix: "/reactivate", body: {}, employmentStatus: "INACTIVE" },
  { name: "POST /api/employees/:id/archive", handler: archiveRoute, method: "POST", suffix: "/archive", body: {} },
  { name: "POST /api/employees/:id/assign-policy", handler: assignPolicyRoute, method: "POST", suffix: "/assign-policy", body: { policyId: null } },
  { name: "POST /api/employees/:id/assign-break-policy", handler: assignBreakPolicyRoute, method: "POST", suffix: "/assign-break-policy", body: { breakPolicyId: null } },
  { name: "POST /api/employees/:id/assign-location", handler: assignLocationRoute, method: "POST", suffix: "/assign-location", body: { primaryLocationId: null } },
  { name: "POST /api/employees/:id/assign-team", handler: assignTeamRoute, method: "POST", suffix: "/assign-team", body: { teamIds: [] } },
  { name: "POST /api/employees/:id/invites", handler: createInviteRoute, method: "POST", suffix: "/invites", body: { channel: "LINK" } },
];

for (const write of employeeWrites) {
  registerTenantIsolationCase({
    name: `${write.name} of another tenant`,
    build: async (_a, b) => {
      const employee = await seedEmployeeIn(b, { employmentStatus: write.employmentStatus });
      return {
        handler: write.handler,
        method: write.method,
        path: `/api/employees/${employee.id}${write.suffix}`,
        params: { id: employee.id },
        ...(write.body !== undefined ? { body: write.body } : {}),
      };
    },
    expectCode: "EMPLOYEE_NOT_FOUND",
    verify: async (_a, b) => {
      await expectEmployeeUntouched(b);
      expect((await employeeOf(b)).employmentStatus).toBe(write.employmentStatus ?? "ACTIVE");
    },
  });
}

// ── Employee invites ────────────────────────────────────────────────────────

async function seedInviteIn(b: TenantFixture) {
  const employee = await seedEmployeeIn(b);
  const invite = await prisma.employeeInvite.create({
    data: {
      organisationId: b.organisation.id,
      employeeId: employee.id,
      code: `TNT${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      tokenHash: `hash-${randomUUID()}`,
      channel: "LINK",
      status: "SENT",
      sentAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  return { employee, invite };
}

async function expectInviteUntouched(b: TenantFixture): Promise<void> {
  const invite = await prisma.employeeInvite.findFirstOrThrow({
    where: { organisationId: b.organisation.id },
  });
  expect(invite.status).toBe("SENT");
  expect(invite.revokedAt).toBeNull();
  expect(invite.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  expect(
    await prisma.auditLog.count({ where: { organisationId: b.organisation.id, entityId: invite.id } }),
  ).toBe(0);
}

registerTenantIsolationCase({
  name: "GET /api/invites/:id/instructions of another tenant",
  build: async (_a, b) => {
    const { invite } = await seedInviteIn(b);
    return {
      handler: instructionsRoute,
      path: `/api/invites/${invite.id}/instructions`,
      params: { id: invite.id },
    };
  },
  expectCode: "INVITE_INVALID",
});

registerTenantIsolationCase({
  name: "POST /api/invites/:id/resend of another tenant",
  build: async (_a, b) => {
    const { invite } = await seedInviteIn(b);
    return {
      handler: resendRoute,
      method: "POST",
      path: `/api/invites/${invite.id}/resend`,
      params: { id: invite.id },
      body: {},
    };
  },
  expectCode: "INVITE_INVALID",
  verify: async (_a, b) => expectInviteUntouched(b),
});

registerTenantIsolationCase({
  name: "POST /api/invites/:id/revoke of another tenant",
  build: async (_a, b) => {
    const { invite } = await seedInviteIn(b);
    return {
      handler: revokeRoute,
      method: "POST",
      path: `/api/invites/${invite.id}/revoke`,
      params: { id: invite.id },
      body: {},
    };
  },
  expectCode: "INVITE_INVALID",
  verify: async (_a, b) => expectInviteUntouched(b),
});
