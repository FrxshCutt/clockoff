import { prisma } from "@workmode/db";
import { expect } from "vitest";
import { POST as defaultPolicyRoute } from "@/app/api/organisations/current/default-policy/route";
import { DELETE as endAssignmentRoute } from "@/app/api/policy-assignments/[id]/route";
import { POST as archiveRoute } from "@/app/api/policies/[id]/archive/route";
import {
  GET as listAssignmentsRoute,
  POST as assignRoute,
} from "@/app/api/policies/[id]/assignments/route";
import { POST as duplicateRoute } from "@/app/api/policies/[id]/duplicate/route";
import { POST as publishRoute } from "@/app/api/policies/[id]/publish/route";
import {
  DELETE as deletePolicyRoute,
  GET as getPolicyRoute,
  PATCH as patchPolicyRoute,
} from "@/app/api/policies/[id]/route";
import { GET as versionsRoute } from "@/app/api/policies/[id]/versions/route";
import { registerTenantIsolationCase } from "../../helpers/tenantIsolation";

/** Work Policy endpoints: org A's owner must never reach (or alter) org B's policies or assignments. */

const restrictionConfig = {
  categories: ["SOCIAL_MEDIA"],
  requireEmployeeAppSelection: true,
  alwaysAllowedNote: [],
  activationMode: "SCHEDULED",
  preShiftWarningMinutes: 10,
};

/** A published (ACTIVE, current version stamped) policy, written directly so the case is self-contained. */
export async function createPublishedPolicyInOrg(organisationId: string, name = "Tenant policy") {
  const policy = await prisma.policy.create({
    data: {
      organisationId,
      name,
      status: "ACTIVE",
      versions: {
        create: { versionNumber: 1, restrictionConfig, publishedAt: new Date() },
      },
    },
    include: { versions: true },
  });
  return prisma.policy.update({
    where: { id: policy.id },
    data: { currentVersionId: policy.versions[0]!.id },
  });
}

async function createEmployeeInOrg(organisationId: string) {
  return prisma.employee.create({ data: { organisationId, firstName: "B", lastName: "Only" } });
}

registerTenantIsolationCase({
  name: "GET /api/policies/:id of another tenant",
  build: async (_a, b) => {
    const policy = await createPublishedPolicyInOrg(b.organisation.id);
    return { handler: getPolicyRoute, path: `/api/policies/${policy.id}`, params: { id: policy.id } };
  },
  expectCode: "NOT_FOUND",
});

registerTenantIsolationCase({
  name: "PATCH /api/policies/:id of another tenant",
  build: async (_a, b) => {
    const policy = await createPublishedPolicyInOrg(b.organisation.id, "Untouched");
    return {
      handler: patchPolicyRoute,
      method: "PATCH",
      path: `/api/policies/${policy.id}`,
      params: { id: policy.id },
      body: { name: "Hijacked" },
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (_a, b) => {
    expect(
      await prisma.policy.count({ where: { organisationId: b.organisation.id, name: "Untouched" } }),
    ).toBe(1);
  },
});

registerTenantIsolationCase({
  name: "DELETE /api/policies/:id of another tenant",
  build: async (_a, b) => {
    const policy = await createPublishedPolicyInOrg(b.organisation.id);
    return {
      handler: deletePolicyRoute,
      method: "DELETE",
      path: `/api/policies/${policy.id}`,
      params: { id: policy.id },
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (_a, b) => {
    expect(
      await prisma.policy.count({ where: { organisationId: b.organisation.id, deletedAt: null } }),
    ).toBe(1);
  },
});

registerTenantIsolationCase({
  name: "POST /api/policies/:id/publish of another tenant",
  build: async (_a, b) => {
    const policy = await prisma.policy.create({
      data: {
        organisationId: b.organisation.id,
        name: "Draft B",
        versions: { create: { versionNumber: 1, restrictionConfig } },
      },
    });
    return {
      handler: publishRoute,
      method: "POST",
      path: `/api/policies/${policy.id}/publish`,
      params: { id: policy.id },
      body: {},
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (_a, b) => {
    const row = await prisma.policy.findFirstOrThrow({
      where: { organisationId: b.organisation.id, name: "Draft B" },
    });
    expect(row.status).toBe("DRAFT");
    expect(row.currentVersionId).toBeNull();
  },
});

registerTenantIsolationCase({
  name: "POST /api/policies/:id/duplicate of another tenant",
  build: async (_a, b) => {
    const policy = await createPublishedPolicyInOrg(b.organisation.id);
    return {
      handler: duplicateRoute,
      method: "POST",
      path: `/api/policies/${policy.id}/duplicate`,
      params: { id: policy.id },
      body: {},
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (a) => {
    expect(await prisma.policy.count({ where: { organisationId: a.organisation.id } })).toBe(0);
  },
});

registerTenantIsolationCase({
  name: "POST /api/policies/:id/archive of another tenant",
  build: async (_a, b) => {
    const policy = await createPublishedPolicyInOrg(b.organisation.id);
    return {
      handler: archiveRoute,
      method: "POST",
      path: `/api/policies/${policy.id}/archive`,
      params: { id: policy.id },
      body: {},
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (_a, b) => {
    expect(
      await prisma.policy.count({ where: { organisationId: b.organisation.id, status: "ACTIVE" } }),
    ).toBe(1);
  },
});

registerTenantIsolationCase({
  name: "GET /api/policies/:id/versions of another tenant",
  build: async (_a, b) => {
    const policy = await createPublishedPolicyInOrg(b.organisation.id);
    return {
      handler: versionsRoute,
      path: `/api/policies/${policy.id}/versions`,
      params: { id: policy.id },
    };
  },
  expectCode: "NOT_FOUND",
});

registerTenantIsolationCase({
  name: "GET /api/policies/:id/assignments of another tenant",
  build: async (_a, b) => {
    const policy = await createPublishedPolicyInOrg(b.organisation.id);
    return {
      handler: listAssignmentsRoute,
      path: `/api/policies/${policy.id}/assignments`,
      params: { id: policy.id },
    };
  },
  expectCode: "NOT_FOUND",
});

registerTenantIsolationCase({
  name: "POST /api/policies/:id/assignments on another tenant's policy",
  build: async (a, b) => {
    const policy = await createPublishedPolicyInOrg(b.organisation.id);
    return {
      handler: assignRoute,
      method: "POST",
      path: `/api/policies/${policy.id}/assignments`,
      params: { id: policy.id },
      body: { scopeType: "ORGANISATION", scopeId: a.organisation.id },
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (a, b) => {
    expect(
      await prisma.policyAssignment.count({
        where: { organisationId: { in: [a.organisation.id, b.organisation.id] } },
      }),
    ).toBe(0);
  },
});

registerTenantIsolationCase({
  name: "POST /api/policies/:id/assignments with another tenant's employee as scope",
  build: async (a, b) => {
    const policy = await createPublishedPolicyInOrg(a.organisation.id, "A's own");
    const employee = await createEmployeeInOrg(b.organisation.id);
    return {
      handler: assignRoute,
      method: "POST",
      path: `/api/policies/${policy.id}/assignments`,
      params: { id: policy.id },
      body: { scopeType: "EMPLOYEE", scopeId: employee.id },
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (a, b) => {
    expect(
      await prisma.policyAssignment.count({
        where: { organisationId: { in: [a.organisation.id, b.organisation.id] } },
      }),
    ).toBe(0);
  },
});

registerTenantIsolationCase({
  name: "DELETE /api/policy-assignments/:id of another tenant",
  build: async (_a, b) => {
    const policy = await createPublishedPolicyInOrg(b.organisation.id);
    const assignment = await prisma.policyAssignment.create({
      data: {
        organisationId: b.organisation.id,
        policyId: policy.id,
        scopeType: "ORGANISATION",
        scopeId: b.organisation.id,
      },
    });
    return {
      handler: endAssignmentRoute,
      method: "DELETE",
      path: `/api/policy-assignments/${assignment.id}`,
      params: { id: assignment.id },
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (_a, b) => {
    const row = await prisma.policyAssignment.findFirstOrThrow({
      where: { organisationId: b.organisation.id },
    });
    expect(row.effectiveTo).toBeNull();
  },
});

registerTenantIsolationCase({
  name: "POST /api/organisations/current/default-policy with another tenant's policy",
  build: async (_a, b) => {
    const policy = await createPublishedPolicyInOrg(b.organisation.id);
    return {
      handler: defaultPolicyRoute,
      method: "POST",
      path: "/api/organisations/current/default-policy",
      body: { policyId: policy.id },
    };
  },
  expectCode: "NOT_FOUND",
  verify: async (a) => {
    const org = await prisma.organisation.findUniqueOrThrow({ where: { id: a.organisation.id } });
    expect(org.defaultPolicyId).toBeNull();
  },
});
