import { prisma } from "@workmode/db";
import { expect } from "vitest";
import {
  GET as listAssignmentsRoute,
  POST as assignRoute,
} from "@/app/api/break-policies/[id]/assignments/route";
import {
  DELETE as deleteRoute,
  GET as getRoute,
  PATCH as patchRoute,
} from "@/app/api/break-policies/[id]/route";
import { DELETE as endAssignmentRoute } from "@/app/api/break-policy-assignments/[id]/route";
import { POST as defaultRoute } from "@/app/api/organisations/current/default-break-policy/route";
import { registerTenantIsolationCase } from "../../helpers/tenantIsolation";

/** Break Policy endpoints: org A's owner must never reach (or alter) org B's break policies. */

async function createBreakPolicyInOrg(organisationId: string, name = "Tenant breaks") {
  return prisma.breakPolicy.create({ data: { organisationId, name } });
}

registerTenantIsolationCase({
  name: "GET /api/break-policies/:id of another tenant",
  build: async (_a, b) => {
    const policy = await createBreakPolicyInOrg(b.organisation.id);
    return {
      handler: getRoute,
      path: `/api/break-policies/${policy.id}`,
      params: { id: policy.id },
    };
  },
  expectCode: "NOT_FOUND",
});

registerTenantIsolationCase({
  name: "PATCH /api/break-policies/:id of another tenant",
  build: async (_a, b) => {
    const policy = await createBreakPolicyInOrg(b.organisation.id, "Untouched breaks");
    return {
      handler: patchRoute,
      method: "PATCH",
      path: `/api/break-policies/${policy.id}`,
      params: { id: policy.id },
      body: { name: "Hijacked", maxBreaksPerShift: 9 },
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (_a, b) => {
    const row = await prisma.breakPolicy.findFirstOrThrow({
      where: { organisationId: b.organisation.id },
    });
    expect(row.name).toBe("Untouched breaks");
    expect(row.maxBreaksPerShift).toBe(2);
  },
});

registerTenantIsolationCase({
  name: "DELETE /api/break-policies/:id of another tenant",
  build: async (_a, b) => {
    const policy = await createBreakPolicyInOrg(b.organisation.id);
    return {
      handler: deleteRoute,
      method: "DELETE",
      path: `/api/break-policies/${policy.id}`,
      params: { id: policy.id },
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (_a, b) => {
    expect(
      await prisma.breakPolicy.count({
        where: { organisationId: b.organisation.id, deletedAt: null },
      }),
    ).toBe(1);
  },
});

registerTenantIsolationCase({
  name: "GET /api/break-policies/:id/assignments of another tenant",
  build: async (_a, b) => {
    const policy = await createBreakPolicyInOrg(b.organisation.id);
    return {
      handler: listAssignmentsRoute,
      path: `/api/break-policies/${policy.id}/assignments`,
      params: { id: policy.id },
    };
  },
  expectCode: "NOT_FOUND",
});

registerTenantIsolationCase({
  name: "POST /api/break-policies/:id/assignments on another tenant's break policy",
  build: async (a, b) => {
    const policy = await createBreakPolicyInOrg(b.organisation.id);
    return {
      handler: assignRoute,
      method: "POST",
      path: `/api/break-policies/${policy.id}/assignments`,
      params: { id: policy.id },
      body: { scopeType: "ORGANISATION", scopeId: a.organisation.id },
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (a, b) => {
    expect(
      await prisma.breakPolicyAssignment.count({
        where: { organisationId: { in: [a.organisation.id, b.organisation.id] } },
      }),
    ).toBe(0);
  },
});

registerTenantIsolationCase({
  name: "POST /api/break-policies/:id/assignments with another tenant's team as scope",
  build: async (a, b) => {
    const policy = await createBreakPolicyInOrg(a.organisation.id, "A's own breaks");
    const team = await prisma.team.create({
      data: { organisationId: b.organisation.id, name: "B team" },
    });
    return {
      handler: assignRoute,
      method: "POST",
      path: `/api/break-policies/${policy.id}/assignments`,
      params: { id: policy.id },
      body: { scopeType: "TEAM", scopeId: team.id },
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (a, b) => {
    expect(
      await prisma.breakPolicyAssignment.count({
        where: { organisationId: { in: [a.organisation.id, b.organisation.id] } },
      }),
    ).toBe(0);
  },
});

registerTenantIsolationCase({
  name: "DELETE /api/break-policy-assignments/:id of another tenant",
  build: async (_a, b) => {
    const policy = await createBreakPolicyInOrg(b.organisation.id);
    const assignment = await prisma.breakPolicyAssignment.create({
      data: {
        organisationId: b.organisation.id,
        breakPolicyId: policy.id,
        scopeType: "ORGANISATION",
        scopeId: b.organisation.id,
      },
    });
    return {
      handler: endAssignmentRoute,
      method: "DELETE",
      path: `/api/break-policy-assignments/${assignment.id}`,
      params: { id: assignment.id },
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (_a, b) => {
    const row = await prisma.breakPolicyAssignment.findFirstOrThrow({
      where: { organisationId: b.organisation.id },
    });
    expect(row.effectiveTo).toBeNull();
  },
});

registerTenantIsolationCase({
  name: "POST /api/organisations/current/default-break-policy with another tenant's break policy",
  build: async (_a, b) => {
    const policy = await createBreakPolicyInOrg(b.organisation.id);
    return {
      handler: defaultRoute,
      method: "POST",
      path: "/api/organisations/current/default-break-policy",
      body: { breakPolicyId: policy.id },
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (a) => {
    const org = await prisma.organisation.findUniqueOrThrow({ where: { id: a.organisation.id } });
    expect(org.defaultBreakPolicyId).toBeNull();
  },
});
