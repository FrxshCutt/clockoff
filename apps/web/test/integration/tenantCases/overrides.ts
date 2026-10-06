import { prisma } from "@workmode/db";
import { expect } from "vitest";
import { POST as revokeRoute } from "@/app/api/overrides/[id]/revoke/route";
import { POST as createRoute } from "@/app/api/overrides/route";
import { registerTenantIsolationCase } from "../../helpers/tenantIsolation";

/** Overrides: org A's owner must never revoke, or create against, org B's rows. */

async function employeeInOrg(organisationId: string) {
  return prisma.employee.create({ data: { organisationId, firstName: "B", lastName: "Employee" } });
}

/** Overrides of the two fixture organisations only (other matrix cases leave their own rows behind). */
async function countOverrides(...organisationIds: string[]): Promise<number> {
  return prisma.managerOverride.count({ where: { organisationId: { in: organisationIds } } });
}

registerTenantIsolationCase({
  name: "POST /api/overrides/:id/revoke of another tenant",
  build: async (_a, b) => {
    const employee = await employeeInOrg(b.organisation.id);
    const override = await prisma.managerOverride.create({
      data: {
        organisationId: b.organisation.id,
        employeeId: employee.id,
        type: "EXEMPT_TEMPORARILY",
        reason: "Tenant B override",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return {
      handler: revokeRoute,
      method: "POST",
      path: `/api/overrides/${override.id}/revoke`,
      params: { id: override.id },
      body: {},
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (_a, b) => {
    const row = await prisma.managerOverride.findFirstOrThrow({ where: { organisationId: b.organisation.id } });
    expect(row.revokedAt).toBeNull();
  },
});

registerTenantIsolationCase({
  name: "POST /api/overrides for another tenant's employee",
  build: async (_a, b) => {
    const employee = await employeeInOrg(b.organisation.id);
    return {
      handler: createRoute,
      method: "POST",
      path: "/api/overrides",
      body: { employeeId: employee.id, type: "EXEMPT_TEMPORARILY", reason: "Cross-tenant attempt" },
    };
  },
  expectCode: "EMPLOYEE_NOT_FOUND",
  verify: async (a, b) => {
    expect(await countOverrides(a.organisation.id, b.organisation.id)).toBe(0);
  },
});

registerTenantIsolationCase({
  name: "POST /api/overrides (TEMPORARY_EXCEPTION) referencing another tenant's break policy",
  build: async (a, b) => {
    const employee = await employeeInOrg(a.organisation.id);
    const breakPolicy = await prisma.breakPolicy.create({
      data: { organisationId: b.organisation.id, name: "Tenant B breaks" },
    });
    return {
      handler: createRoute,
      method: "POST",
      path: "/api/overrides",
      body: {
        employeeId: employee.id,
        type: "TEMPORARY_EXCEPTION",
        reason: "Cross-tenant break policy",
        payload: { breakPolicyId: breakPolicy.id },
      },
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (a, b) => {
    expect(await countOverrides(a.organisation.id, b.organisation.id)).toBe(0);
  },
});
