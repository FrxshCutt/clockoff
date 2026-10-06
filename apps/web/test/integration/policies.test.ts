import { prisma } from "@workmode/db";
import {
  listPoliciesResponseSchema,
  listPolicyAssignmentsResponseSchema,
  policyAssignmentResponseSchema,
  policyResponseSchema,
  policyVersionsResponseSchema,
  type ListPoliciesResponse,
  type ListPolicyAssignmentsResponse,
  type PolicyAssignmentResponse,
  type PolicyResponse,
  type PolicyVersionsResponse,
} from "@workmode/validation/policies";
import type { OrganisationResponse } from "@workmode/validation/organisation";
import { REALTIME_EVENT_TYPES as CONTRACT_EVENT_TYPES } from "@workmode/validation/realtime";
import { describe, expect, it } from "vitest";
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
import { GET as listPoliciesRoute, POST as createPolicyRoute } from "@/app/api/policies/route";
import {
  getEventBus,
  REALTIME_EVENT_TYPES as SERVER_EVENT_TYPES,
  type RealtimeEvent,
} from "@/server/events";
import {
  computePolicyVersionString,
  resolveEmployeePolicies,
  resolveForEmployees,
  toResolvedPolicyRefs,
} from "@/server/policies/policies.service";
import {
  affectedEmployeeIds,
  isOrganisationBridged,
  PUSH_BRIDGE_EVENT_TYPES,
} from "@/server/realtime/pushBridge";
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

const restrictionConfig = {
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
  return { org, jar };
}

async function createPolicy(jar: CookieJar, name: string, overrides: Record<string, unknown> = {}) {
  const res = await callRoute<PolicyResponse>(createPolicyRoute, {
    method: "POST",
    path: "/api/policies",
    jar,
    body: { name, restrictionConfig, ...overrides },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.policy;
}

async function publish(jar: CookieJar, id: string, changeNote?: string) {
  const res = await callRoute<PolicyResponse>(publishRoute, {
    method: "POST",
    path: `/api/policies/${id}/publish`,
    params: { id },
    jar,
    body: changeNote ? { changeNote } : {},
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.policy;
}

async function createPublishedPolicy(jar: CookieJar, name: string) {
  const draft = await createPolicy(jar, name);
  return publish(jar, draft.id);
}

async function assign(
  jar: CookieJar,
  policyId: string,
  body: Record<string, unknown>,
  expectStatus = 201,
) {
  const res = await callRoute<PolicyAssignmentResponse & ErrorBody>(assignRoute, {
    method: "POST",
    path: `/api/policies/${policyId}/assignments`,
    params: { id: policyId },
    jar,
    body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(expectStatus);
  return res.body;
}

async function createEmployee(org: TestOrg, overrides: { primaryLocationId?: string } = {}) {
  return prisma.employee.create({
    data: {
      organisationId: org.organisation.id,
      firstName: "Sam",
      lastName: `Worker ${Math.random().toString(36).slice(2, 6)}`,
      ...overrides,
    },
  });
}

function collectEvents(organisationId: string, type: string) {
  const seen: RealtimeEvent[] = [];
  const unsubscribe = getEventBus().subscribe(organisationId, (e) => {
    if (e.type === type) seen.push(e);
  });
  return { seen, unsubscribe };
}

describe("work policies: create / read / update", () => {
  it("creates a DRAFT policy with an unpublished version 1 and audits it", async () => {
    const { org, jar } = await setup();
    const res = await callRoute<PolicyResponse>(createPolicyRoute, {
      method: "POST",
      path: "/api/policies",
      jar,
      body: { name: "Front of house", description: "Tills and floor", restrictionConfig },
    });
    expect(res.status).toBe(201);
    expect(policyResponseSchema.parse(res.body)).toBeTruthy();
    const { policy } = res.body;
    expect(policy).toMatchObject({
      name: "Front of house",
      description: "Tills and floor",
      status: "DRAFT",
      currentVersion: null,
      isDefault: false,
      assignmentCount: 0,
      assignedEmployeeCount: 0,
    });
    expect(policy.draftVersion).toMatchObject({
      versionNumber: 1,
      publishedAt: null,
      restrictionConfig,
      breakBehaviourDefault: { restrictionBehaviour: "RELAX_ALL", relaxedCategories: [] },
      createdBy: { id: org.owner.id, name: org.owner.name },
    });
    const auditRow = await prisma.auditLog.findFirst({
      where: { organisationId: org.organisation.id, action: "policy.created", entityId: policy.id },
    });
    expect(auditRow?.actorUserId).toBe(org.owner.id);

    const fetched = await callRoute<PolicyResponse>(getPolicyRoute, {
      path: `/api/policies/${policy.id}`,
      params: { id: policy.id },
      jar,
    });
    expect(fetched.status).toBe(200);
    expect(fetched.body.policy.id).toBe(policy.id);
  });

  it("rejects OTHER_SELECTED without requireEmployeeAppSelection, bad bodies and unknown ids", async () => {
    const { jar } = await setup();
    const otherSelected = await callRoute<ErrorBody>(createPolicyRoute, {
      method: "POST",
      path: "/api/policies",
      jar,
      body: {
        name: "Needs selection",
        restrictionConfig: {
          ...restrictionConfig,
          categories: ["SOCIAL_MEDIA", "OTHER_SELECTED"],
          requireEmployeeAppSelection: false,
        },
      },
    });
    expect(otherSelected.status).toBe(400);
    expect(otherSelected.body.error.code).toBe("VALIDATION_ERROR");
    expect(otherSelected.body.error.details).toMatchObject({
      fieldErrors: { restrictionConfig: expect.any(Array) },
    });

    const invalid = await callRoute<ErrorBody>(createPolicyRoute, {
      method: "POST",
      path: "/api/policies",
      jar,
      body: { name: "", restrictionConfig: { ...restrictionConfig, categories: [] }, extra: 1 },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("VALIDATION_ERROR");

    const missing = await callRoute<ErrorBody>(getPolicyRoute, {
      path: "/api/policies/00000000-0000-4000-8000-000000000000",
      params: { id: "00000000-0000-4000-8000-000000000000" },
      jar,
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("NOT_FOUND");

    const badId = await callRoute<ErrorBody>(getPolicyRoute, {
      path: "/api/policies/not-a-uuid",
      params: { id: "not-a-uuid" },
      jar,
    });
    expect(badId.status).toBe(400);
  });

  it("publishes the draft: ACTIVE, current version stamped, activity + realtime event; nothing left to publish", async () => {
    const { org, jar } = await setup();
    const employee = await createEmployee(org);
    const draft = await createPolicy(jar, "Kitchen");
    const { seen, unsubscribe } = collectEvents(org.organisation.id, "POLICY_CHANGED");

    // Not published yet: cannot become the default or be assigned.
    const defaultTooEarly = await callRoute<ErrorBody>(defaultPolicyRoute, {
      method: "POST",
      path: "/api/organisations/current/default-policy",
      jar,
      body: { policyId: draft.id },
    });
    expect(defaultTooEarly.status).toBe(409);
    expect(defaultTooEarly.body.error.code).toBe("POLICY_NOT_PUBLISHED");
    const assignTooEarly = await assign(
      jar,
      draft.id,
      { scopeType: "EMPLOYEE", scopeId: employee.id },
      409,
    );
    expect(assignTooEarly.error.code).toBe("POLICY_NOT_PUBLISHED");

    const published = await publish(jar, draft.id, "Initial rollout");
    expect(published.status).toBe("ACTIVE");
    expect(published.draftVersion).toBeNull();
    expect(published.currentVersion).toMatchObject({
      versionNumber: 1,
      changeNote: "Initial rollout",
    });
    expect(published.currentVersion?.publishedAt).toBeTruthy();
    expect(policyResponseSchema.parse({ policy: published })).toBeTruthy();

    const row = await prisma.policy.findUniqueOrThrow({ where: { id: draft.id } });
    expect(row.currentVersionId).toBe(published.currentVersion?.id);
    const activity = await prisma.activityEvent.findFirst({
      where: { organisationId: org.organisation.id, type: "POLICY_UPDATED" },
    });
    expect(activity).toMatchObject({
      actorType: "MANAGER",
      actorUserId: org.owner.id,
      metadata: { policyId: draft.id, versionNumber: 1 },
    });
    expect(
      await prisma.auditLog.count({
        where: { organisationId: org.organisation.id, action: "policy.published" },
      }),
    ).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.payload).toMatchObject({
      policyId: draft.id,
      reason: "PUBLISHED",
      versionNumber: 1,
      affectedEmployeeIds: [],
    });
    unsubscribe();

    const again = await callRoute<ErrorBody>(publishRoute, {
      method: "POST",
      path: `/api/policies/${draft.id}/publish`,
      params: { id: draft.id },
      jar,
      body: {},
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("CONFLICT");
  });

  it("PATCH after publish creates draft v2, edits it in place, publishing v2 makes it current", async () => {
    const { org, jar } = await setup();
    const published = await createPublishedPolicy(jar, "Baristas");

    const v2 = await callRoute<PolicyResponse>(patchPolicyRoute, {
      method: "PATCH",
      path: `/api/policies/${published.id}`,
      params: { id: published.id },
      jar,
      body: { restrictionConfig: { ...restrictionConfig, preShiftWarningMinutes: 30 } },
    });
    expect(v2.status).toBe(200);
    expect(v2.body.policy.status).toBe("ACTIVE");
    expect(v2.body.policy.currentVersion?.versionNumber).toBe(1);
    expect(v2.body.policy.currentVersion?.restrictionConfig.preShiftWarningMinutes).toBe(10);
    expect(v2.body.policy.draftVersion).toMatchObject({
      versionNumber: 2,
      publishedAt: null,
      restrictionConfig: { preShiftWarningMinutes: 30 },
    });

    // A second config edit lands in the same draft (no v3), merging the untouched break behaviour.
    const edited = await callRoute<PolicyResponse>(patchPolicyRoute, {
      method: "PATCH",
      path: `/api/policies/${published.id}`,
      params: { id: published.id },
      jar,
      body: {
        name: "Baristas (updated)",
        breakBehaviourDefault: {
          restrictionBehaviour: "RELAX_CATEGORIES",
          relaxedCategories: ["GAMES"],
        },
      },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.policy.name).toBe("Baristas (updated)");
    expect(edited.body.policy.draftVersion).toMatchObject({
      id: v2.body.policy.draftVersion?.id,
      versionNumber: 2,
      restrictionConfig: { preShiftWarningMinutes: 30 },
      breakBehaviourDefault: {
        restrictionBehaviour: "RELAX_CATEGORIES",
        relaxedCategories: ["GAMES"],
      },
    });
    expect(await prisma.policyVersion.count({ where: { policyId: published.id } })).toBe(2);

    const publishedV2 = await publish(jar, published.id);
    expect(publishedV2.currentVersion?.versionNumber).toBe(2);
    expect(publishedV2.draftVersion).toBeNull();

    const versions = await callRoute<PolicyVersionsResponse>(versionsRoute, {
      path: `/api/policies/${published.id}/versions`,
      params: { id: published.id },
      jar,
    });
    expect(versions.status).toBe(200);
    expect(policyVersionsResponseSchema.parse(versions.body)).toBeTruthy();
    expect(versions.body.versions.map((v) => v.versionNumber)).toEqual([2, 1]);
    expect(versions.body.versions.every((v) => v.publishedAt !== null)).toBe(true);
    expect(
      await prisma.auditLog.count({
        where: { organisationId: org.organisation.id, action: "policy.updated" },
      }),
    ).toBe(2);
  });

  it("PATCH on an unpublished draft edits version 1 in place; name-only PATCH creates no version", async () => {
    const { jar } = await setup();
    const draft = await createPolicy(jar, "Night shift");
    const renamed = await callRoute<PolicyResponse>(patchPolicyRoute, {
      method: "PATCH",
      path: `/api/policies/${draft.id}`,
      params: { id: draft.id },
      jar,
      body: { name: "Nights", description: null },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.policy).toMatchObject({
      name: "Nights",
      description: null,
      status: "DRAFT",
    });
    const config = await callRoute<PolicyResponse>(patchPolicyRoute, {
      method: "PATCH",
      path: `/api/policies/${draft.id}`,
      params: { id: draft.id },
      jar,
      body: { restrictionConfig: { ...restrictionConfig, categories: ["DATING"] } },
    });
    expect(config.status).toBe(200);
    expect(config.body.policy.draftVersion).toMatchObject({
      id: draft.draftVersion?.id,
      versionNumber: 1,
      restrictionConfig: { categories: ["DATING"] },
    });
    expect(await prisma.policyVersion.count({ where: { policyId: draft.id } })).toBe(1);
  });

  it("duplicates into a new DRAFT '<name> (copy)' from the latest version", async () => {
    const { jar } = await setup();
    const source = await createPublishedPolicy(jar, "Warehouse");
    await callRoute(patchPolicyRoute, {
      method: "PATCH",
      path: `/api/policies/${source.id}`,
      params: { id: source.id },
      jar,
      body: { restrictionConfig: { ...restrictionConfig, shieldMessage: "Draft edit" } },
    });
    const copy = await callRoute<PolicyResponse>(duplicateRoute, {
      method: "POST",
      path: `/api/policies/${source.id}/duplicate`,
      params: { id: source.id },
      jar,
      body: {},
    });
    expect(copy.status).toBe(201);
    expect(copy.body.policy).toMatchObject({
      name: "Warehouse (copy)",
      status: "DRAFT",
      currentVersion: null,
    });
    expect(copy.body.policy.id).not.toBe(source.id);
    expect(copy.body.policy.draftVersion).toMatchObject({
      versionNumber: 1,
      restrictionConfig: { shieldMessage: "Draft edit" },
    });
    const named = await callRoute<PolicyResponse>(duplicateRoute, {
      method: "POST",
      path: `/api/policies/${source.id}/duplicate`,
      params: { id: source.id },
      jar,
      body: { name: "Warehouse nights" },
    });
    expect(named.body.policy.name).toBe("Warehouse nights");
  });

  it("lists with filters, hides archived by default and validates the response contract", async () => {
    const { jar } = await setup();
    const a = await createPublishedPolicy(jar, "Alpha");
    await createPolicy(jar, "Beta draft");
    const archived = await createPublishedPolicy(jar, "Gamma old");
    const arch = await callRoute<PolicyResponse>(archiveRoute, {
      method: "POST",
      path: `/api/policies/${archived.id}/archive`,
      params: { id: archived.id },
      jar,
      body: {},
    });
    expect(arch.status).toBe(200);
    expect(arch.body.policy.status).toBe("ARCHIVED");

    const list = await callRoute<ListPoliciesResponse>(listPoliciesRoute, {
      path: "/api/policies",
      jar,
    });
    expect(list.status).toBe(200);
    expect(listPoliciesResponseSchema.parse(list.body)).toBeTruthy();
    expect(list.body.policies.map((p) => p.name)).toEqual(["Alpha", "Beta draft"]);

    const withArchived = await callRoute<ListPoliciesResponse>(listPoliciesRoute, {
      path: "/api/policies",
      query: { includeArchived: "true" },
      jar,
    });
    expect(withArchived.body.policies.map((p) => p.name)).toEqual([
      "Alpha",
      "Beta draft",
      "Gamma old",
    ]);

    const drafts = await callRoute<ListPoliciesResponse>(listPoliciesRoute, {
      path: "/api/policies",
      query: { status: "DRAFT" },
      jar,
    });
    expect(drafts.body.policies.map((p) => p.id)).toEqual(expect.not.arrayContaining([a.id]));
    expect(drafts.body.policies).toHaveLength(1);

    const search = await callRoute<ListPoliciesResponse>(listPoliciesRoute, {
      path: "/api/policies",
      query: { search: "alp" },
      jar,
    });
    expect(search.body.policies.map((p) => p.id)).toEqual([a.id]);
  });

  it("lets MANAGER read but not write (FORBIDDEN)", async () => {
    const { org, jar: ownerJar } = await setup();
    const policy = await createPublishedPolicy(ownerJar, "Readable");
    const { user: manager } = await createTestUser();
    await addMember(org.organisation.id, manager, "MANAGER");
    const jar = await loginAs(manager, { organisationId: org.organisation.id });

    const read = await callRoute<ListPoliciesResponse>(listPoliciesRoute, {
      path: "/api/policies",
      jar,
    });
    expect(read.status).toBe(200);
    expect(read.body.policies.map((p) => p.id)).toEqual([policy.id]);

    const write = await callRoute<ErrorBody>(createPolicyRoute, {
      method: "POST",
      path: "/api/policies",
      jar,
      body: { name: "Nope", restrictionConfig },
    });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe("FORBIDDEN");

    const noCsrf = await callRoute<ErrorBody>(createPolicyRoute, {
      method: "POST",
      path: "/api/policies",
      jar: ownerJar,
      csrf: false,
      body: { name: "Nope", restrictionConfig },
    });
    expect(noCsrf.status).toBe(403);
  });
});

describe("policy assignments", () => {
  it("validates the scope target, replaces the open assignment per scope, lists and ends assignments", async () => {
    const { org, jar } = await setup();
    const policy = await createPublishedPolicy(jar, "Shop floor");
    const other = await createPublishedPolicy(jar, "Shop floor v2");
    const employee = await createEmployee(org);
    const otherOrg = await createTestOrg();
    const foreignEmployee = await createEmployee(otherOrg);
    const { seen, unsubscribe } = collectEvents(org.organisation.id, "POLICY_CHANGED");

    const foreign = await assign(
      jar,
      policy.id,
      { scopeType: "EMPLOYEE", scopeId: foreignEmployee.id },
      404,
    );
    expect(foreign.error.code).toBe("NOT_FOUND");
    const wrongOrg = await assign(
      jar,
      policy.id,
      { scopeType: "ORGANISATION", scopeId: otherOrg.organisation.id },
      404,
    );
    expect(wrongOrg.error.code).toBe("NOT_FOUND");
    const inverted = await assign(
      jar,
      policy.id,
      {
        scopeType: "EMPLOYEE",
        scopeId: employee.id,
        effectiveFrom: "2026-10-10T09:00:00Z",
        effectiveTo: "2026-10-09T09:00:00Z",
      },
      400,
    );
    expect(inverted.error.code).toBe("VALIDATION_ERROR");

    const first = await assign(jar, policy.id, { scopeType: "EMPLOYEE", scopeId: employee.id });
    expect(policyAssignmentResponseSchema.parse(first)).toBeTruthy();
    expect(first.assignment).toMatchObject({
      policy: { id: policy.id, name: "Shop floor" },
      scopeType: "EMPLOYEE",
      scopeId: employee.id,
      scope: { id: employee.id, name: `${employee.firstName} ${employee.lastName}` },
      effectiveFrom: null,
      effectiveTo: null,
      isActive: true,
      createdBy: { id: org.owner.id, name: org.owner.name },
    });
    expect(seen.at(-1)?.payload).toMatchObject({
      policyId: policy.id,
      reason: "ASSIGNED",
      affectedEmployeeIds: [employee.id],
    });

    const afterFirst = await callRoute<PolicyResponse>(getPolicyRoute, {
      path: `/api/policies/${policy.id}`,
      params: { id: policy.id },
      jar,
    });
    expect(afterFirst.body.policy).toMatchObject({ assignmentCount: 1, assignedEmployeeCount: 1 });

    // Same scope, another policy: the first assignment is ended at the new one's start.
    const second = await assign(jar, other.id, { scopeType: "EMPLOYEE", scopeId: employee.id });
    const previous = await prisma.policyAssignment.findUniqueOrThrow({
      where: { id: first.assignment.id },
    });
    expect(previous.effectiveTo).not.toBeNull();
    expect(previous.effectiveTo!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(
      await prisma.policyAssignment.count({
        where: { scopeType: "EMPLOYEE", scopeId: employee.id, effectiveTo: null },
      }),
    ).toBe(1);

    const listed = await callRoute<ListPolicyAssignmentsResponse>(listAssignmentsRoute, {
      path: `/api/policies/${policy.id}/assignments`,
      params: { id: policy.id },
      jar,
    });
    expect(listed.status).toBe(200);
    expect(listPolicyAssignmentsResponseSchema.parse(listed.body)).toBeTruthy();
    expect(listed.body.assignments).toHaveLength(1);
    expect(listed.body.assignments[0]).toMatchObject({ id: first.assignment.id, isActive: false });

    const orgScope = await assign(jar, policy.id, {
      scopeType: "ORGANISATION",
      scopeId: org.organisation.id,
    });
    expect(orgScope.assignment.scope).toBeNull();
    expect(seen.at(-1)?.payload).toMatchObject({
      reason: "ASSIGNED",
      affectedEmployeeIds: [employee.id],
    });

    const ended = await callRoute(endAssignmentRoute, {
      method: "DELETE",
      path: `/api/policy-assignments/${second.assignment.id}`,
      params: { id: second.assignment.id },
      jar,
    });
    expect(ended.status).toBe(204);
    const endedRow = await prisma.policyAssignment.findUniqueOrThrow({
      where: { id: second.assignment.id },
    });
    expect(endedRow.effectiveTo).not.toBeNull();
    expect(seen.at(-1)?.payload).toMatchObject({
      policyId: other.id,
      reason: "UNASSIGNED",
      affectedEmployeeIds: [employee.id],
    });
    const again = await callRoute(endAssignmentRoute, {
      method: "DELETE",
      path: `/api/policy-assignments/${second.assignment.id}`,
      params: { id: second.assignment.id },
      jar,
    });
    expect(again.status).toBe(204);
    expect(
      await prisma.auditLog.count({
        where: { organisationId: org.organisation.id, action: "policy_assignment.created" },
      }),
    ).toBe(3);
    unsubscribe();
  });

  it("a scheduled assignment ends the previous one at its start, not immediately", async () => {
    const { org, jar } = await setup();
    const current = await createPublishedPolicy(jar, "Current");
    const next = await createPublishedPolicy(jar, "Next month");
    const team = await prisma.team.create({
      data: { organisationId: org.organisation.id, name: "Bar" },
    });
    const first = await assign(jar, current.id, { scopeType: "TEAM", scopeId: team.id });
    const startsAt = new Date(Date.now() + 7 * 86_400_000);
    const scheduled = await assign(jar, next.id, {
      scopeType: "TEAM",
      scopeId: team.id,
      effectiveFrom: startsAt.toISOString(),
    });
    expect(scheduled.assignment.isActive).toBe(false);
    const previous = await prisma.policyAssignment.findUniqueOrThrow({
      where: { id: first.assignment.id },
    });
    expect(previous.effectiveTo?.toISOString()).toBe(startsAt.toISOString());
    expect(scheduled.assignment.scope).toEqual({ id: team.id, name: "Bar" });
  });

  it("rejects an assignment whose window has already ended and leaves the scope's current one untouched", async () => {
    const { org, jar } = await setup();
    const policy = await createPublishedPolicy(jar, "Current");
    const other = await createPublishedPolicy(jar, "Dead on arrival");
    const employee = await createEmployee(org);
    const current = await assign(jar, policy.id, { scopeType: "EMPLOYEE", scopeId: employee.id });

    // The schema only checks effectiveTo > effectiveFrom; a window that is entirely in the past would
    // otherwise end the current assignment and leave the employee with nothing.
    const past = await assign(
      jar,
      other.id,
      {
        scopeType: "EMPLOYEE",
        scopeId: employee.id,
        effectiveFrom: new Date(Date.now() - 120_000).toISOString(),
        effectiveTo: new Date(Date.now() - 60_000).toISOString(),
      },
      400,
    );
    expect(past.error.code).toBe("VALIDATION_ERROR");
    expect(past.error.details).toMatchObject({
      source: "body",
      fieldErrors: { effectiveTo: expect.any(Array) },
    });
    const row = await prisma.policyAssignment.findUniqueOrThrow({
      where: { id: current.assignment.id },
    });
    expect(row.effectiveTo).toBeNull();
    expect(await prisma.policyAssignment.count({ where: { policyId: other.id } })).toBe(0);
  });
});

describe("archive and delete", () => {
  it("refuses to archive or delete a policy that is assigned or the default, with the assignments to fix", async () => {
    const { org, jar } = await setup();
    const policy = await createPublishedPolicy(jar, "In use");
    const employee = await createEmployee(org);
    const { assignment } = await assign(jar, policy.id, {
      scopeType: "EMPLOYEE",
      scopeId: employee.id,
    });

    const blocked = await callRoute<ErrorBody>(archiveRoute, {
      method: "POST",
      path: `/api/policies/${policy.id}/archive`,
      params: { id: policy.id },
      jar,
      body: {},
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("POLICY_ASSIGNED");
    expect(blocked.body.error.details).toMatchObject({
      policyId: policy.id,
      isDefault: false,
      assignmentCount: 1,
      assignments: [
        {
          id: assignment.id,
          scopeType: "EMPLOYEE",
          scopeId: employee.id,
          scopeName: `${employee.firstName} ${employee.lastName}`,
        },
      ],
    });
    const deleteBlocked = await callRoute<ErrorBody>(deletePolicyRoute, {
      method: "DELETE",
      path: `/api/policies/${policy.id}`,
      params: { id: policy.id },
      jar,
    });
    expect(deleteBlocked.status).toBe(409);
    expect(deleteBlocked.body.error.code).toBe("POLICY_ASSIGNED");

    await callRoute(endAssignmentRoute, {
      method: "DELETE",
      path: `/api/policy-assignments/${assignment.id}`,
      params: { id: assignment.id },
      jar,
    });
    const setDefault = await callRoute<OrganisationResponse>(defaultPolicyRoute, {
      method: "POST",
      path: "/api/organisations/current/default-policy",
      jar,
      body: { policyId: policy.id },
    });
    expect(setDefault.status).toBe(200);
    const defaultBlocked = await callRoute<ErrorBody>(archiveRoute, {
      method: "POST",
      path: `/api/policies/${policy.id}/archive`,
      params: { id: policy.id },
      jar,
      body: {},
    });
    expect(defaultBlocked.status).toBe(409);
    expect(defaultBlocked.body.error.details).toMatchObject({
      isDefault: true,
      assignmentCount: 0,
    });

    await callRoute(defaultPolicyRoute, {
      method: "POST",
      path: "/api/organisations/current/default-policy",
      jar,
      body: { policyId: null },
    });
    const archived = await callRoute<PolicyResponse>(archiveRoute, {
      method: "POST",
      path: `/api/policies/${policy.id}/archive`,
      params: { id: policy.id },
      jar,
      body: {},
    });
    expect(archived.status).toBe(200);
    expect(archived.body.policy.status).toBe("ARCHIVED");

    const patchArchived = await callRoute<ErrorBody>(patchPolicyRoute, {
      method: "PATCH",
      path: `/api/policies/${policy.id}`,
      params: { id: policy.id },
      jar,
      body: { name: "Renamed" },
    });
    expect(patchArchived.status).toBe(409);
    expect(patchArchived.body.error.code).toBe("POLICY_ARCHIVED");
    const assignArchived = await assign(
      jar,
      policy.id,
      { scopeType: "EMPLOYEE", scopeId: employee.id },
      409,
    );
    expect(assignArchived.error.code).toBe("POLICY_ARCHIVED");
    const defaultArchived = await callRoute<ErrorBody>(defaultPolicyRoute, {
      method: "POST",
      path: "/api/organisations/current/default-policy",
      jar,
      body: { policyId: policy.id },
    });
    expect(defaultArchived.body.error.code).toBe("POLICY_ARCHIVED");

    const deleted = await callRoute(deletePolicyRoute, {
      method: "DELETE",
      path: `/api/policies/${policy.id}`,
      params: { id: policy.id },
      jar,
    });
    expect(deleted.status).toBe(204);
    const gone = await callRoute<ErrorBody>(getPolicyRoute, {
      path: `/api/policies/${policy.id}`,
      params: { id: policy.id },
      jar,
    });
    expect(gone.status).toBe(404);
    const row = await prisma.policy.findUniqueOrThrow({ where: { id: policy.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(
      await prisma.auditLog.count({
        where: { organisationId: org.organisation.id, action: "policy.deleted" },
      }),
    ).toBe(1);
  });
});

describe("organisation default policy", () => {
  it("sets and clears the default, marks isDefault and notifies every active employee", async () => {
    const { org, jar } = await setup();
    const policy = await createPublishedPolicy(jar, "Default");
    const employee = await createEmployee(org);
    await createEmployee(org).then((e) =>
      prisma.employee.update({ where: { id: e.id }, data: { employmentStatus: "INACTIVE" } }),
    );
    const { seen, unsubscribe } = collectEvents(org.organisation.id, "POLICY_CHANGED");

    const set = await callRoute<OrganisationResponse>(defaultPolicyRoute, {
      method: "POST",
      path: "/api/organisations/current/default-policy",
      jar,
      body: { policyId: policy.id },
    });
    expect(set.status).toBe(200);
    expect(set.body.organisation.defaultPolicyId).toBe(policy.id);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.payload).toMatchObject({
      policyId: policy.id,
      reason: "DEFAULT_CHANGED",
      affectedEmployeeIds: [employee.id],
    });

    const fetched = await callRoute<PolicyResponse>(getPolicyRoute, {
      path: `/api/policies/${policy.id}`,
      params: { id: policy.id },
      jar,
    });
    expect(fetched.body.policy).toMatchObject({ isDefault: true, assignedEmployeeCount: 1 });

    // Setting the same default again is a no-op (no audit, no event).
    await callRoute(defaultPolicyRoute, {
      method: "POST",
      path: "/api/organisations/current/default-policy",
      jar,
      body: { policyId: policy.id },
    });
    expect(seen).toHaveLength(1);

    const cleared = await callRoute<OrganisationResponse>(defaultPolicyRoute, {
      method: "POST",
      path: "/api/organisations/current/default-policy",
      jar,
      body: { policyId: null },
    });
    expect(cleared.body.organisation.defaultPolicyId).toBeNull();
    expect(seen).toHaveLength(2);
    expect(
      await prisma.auditLog.count({
        where: {
          organisationId: org.organisation.id,
          action: "organisation.default_policy_changed",
        },
      }),
    ).toBe(2);
    unsubscribe();
  });
});

describe("resolution service", () => {
  it("applies employee > team (newest) > location > organisation assignment > organisation default", async () => {
    const { org, jar } = await setup();
    const location = await prisma.location.findFirstOrThrow({
      where: { organisationId: org.organisation.id },
    });
    const teamA = await prisma.team.create({
      data: { organisationId: org.organisation.id, name: "Team A" },
    });
    const teamB = await prisma.team.create({
      data: { organisationId: org.organisation.id, name: "Team B" },
    });
    const employee = await createEmployee(org, { primaryLocationId: location.id });
    await prisma.employeeTeam.createMany({
      data: [
        { employeeId: employee.id, teamId: teamA.id },
        { employeeId: employee.id, teamId: teamB.id },
      ],
    });
    const pDefault = await createPublishedPolicy(jar, "P default");
    const pOrg = await createPublishedPolicy(jar, "P org");
    const pLoc = await createPublishedPolicy(jar, "P location");
    const pTeamA = await createPublishedPolicy(jar, "P team A");
    const pTeamB = await createPublishedPolicy(jar, "P team B");
    const pEmp = await createPublishedPolicy(jar, "P employee");

    const nothing = await resolveEmployeePolicies(org.organisation.id, employee.id);
    expect(nothing.policy).toBeNull();
    expect(nothing.policyResolvedFrom).toBeNull();
    expect(nothing.breakPolicy).toBeNull();
    expect(computePolicyVersionString(nothing)).toBe("none|none");

    await callRoute(defaultPolicyRoute, {
      method: "POST",
      path: "/api/organisations/current/default-policy",
      jar,
      body: { policyId: pDefault.id },
    });
    const viaDefault = await resolveEmployeePolicies(org.organisation.id, employee.id);
    expect(viaDefault.policy?.id).toBe(pDefault.id);
    expect(viaDefault.policy?.currentVersion).toMatchObject({
      versionNumber: 1,
      restrictionConfig,
    });
    expect(viaDefault.policyResolvedFrom).toMatchObject({
      via: "DEFAULT",
      scopeType: "ORGANISATION",
      scopeId: org.organisation.id,
      scopeName: org.organisation.name,
    });
    expect(viaDefault.warnings).toEqual([]);
    expect(computePolicyVersionString(viaDefault)).toBe(`${pDefault.id}:1|none`);
    expect(toResolvedPolicyRefs(viaDefault).policy).toEqual({
      id: pDefault.id,
      name: "P default",
      resolvedFrom: "DEFAULT",
    });

    await assign(jar, pOrg.id, { scopeType: "ORGANISATION", scopeId: org.organisation.id });
    const viaOrg = await resolveEmployeePolicies(org.organisation.id, employee.id);
    expect(viaOrg.policy?.id).toBe(pOrg.id);
    expect(viaOrg.policyResolvedFrom).toMatchObject({
      via: "ASSIGNMENT",
      scopeType: "ORGANISATION",
    });

    await assign(jar, pLoc.id, { scopeType: "LOCATION", scopeId: location.id });
    const viaLocation = await resolveEmployeePolicies(org.organisation.id, employee.id);
    expect(viaLocation.policy?.id).toBe(pLoc.id);
    expect(viaLocation.policyResolvedFrom).toMatchObject({
      via: "ASSIGNMENT",
      scopeType: "LOCATION",
      scopeId: location.id,
      scopeName: "High Street",
    });

    const teamAAssignment = await assign(jar, pTeamA.id, { scopeType: "TEAM", scopeId: teamA.id });
    const teamBAssignment = await assign(jar, pTeamB.id, { scopeType: "TEAM", scopeId: teamB.id });
    // Make the ordering unambiguous regardless of clock resolution: Team B's assignment is the newest.
    await prisma.policyAssignment.update({
      where: { id: teamAAssignment.assignment.id },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });
    const viaTeam = await resolveEmployeePolicies(org.organisation.id, employee.id);
    expect(viaTeam.policy?.id).toBe(pTeamB.id);
    expect(viaTeam.policyResolvedFrom).toMatchObject({
      via: "ASSIGNMENT",
      scopeType: "TEAM",
      scopeId: teamB.id,
      scopeName: "Team B",
      assignmentId: teamBAssignment.assignment.id,
    });
    expect(viaTeam.warnings.map((w) => w.code)).toEqual(["AMBIGUOUS_TEAM_ASSIGNMENT"]);
    // Ambiguity is reported, never written as an activity by the API path.
    expect(
      await prisma.activityEvent.count({
        where: { organisationId: org.organisation.id, type: "POLICY_RESOLUTION_WARNING" },
      }),
    ).toBe(0);

    await assign(jar, pEmp.id, { scopeType: "EMPLOYEE", scopeId: employee.id });
    const viaEmployee = await resolveEmployeePolicies(org.organisation.id, employee.id);
    expect(viaEmployee.policy?.id).toBe(pEmp.id);
    expect(viaEmployee.policyResolvedFrom).toMatchObject({
      via: "ASSIGNMENT",
      scopeType: "EMPLOYEE",
    });
    expect(viaEmployee.warnings).toEqual([]);

    // Batched resolution agrees, and the list reflects who resolves to what.
    const second = await createEmployee(org);
    const batch = await resolveForEmployees(org.organisation.id, [employee.id, second.id]);
    expect(batch.get(employee.id)?.policy?.id).toBe(pEmp.id);
    expect(batch.get(second.id)?.policy?.id).toBe(pOrg.id);
    const list = await callRoute<ListPoliciesResponse>(listPoliciesRoute, {
      path: "/api/policies",
      jar,
    });
    const counts = Object.fromEntries(
      list.body.policies.map((p) => [p.name, p.assignedEmployeeCount]),
    );
    expect(counts).toMatchObject({ "P employee": 1, "P org": 1, "P default": 0, "P team B": 0 });
  });

  it("does not resolve another tenant's employee", async () => {
    const { org } = await setup();
    const other = await createTestOrg();
    const foreign = await createEmployee(other);
    await expect(resolveEmployeePolicies(org.organisation.id, foreign.id)).rejects.toMatchObject({
      code: "EMPLOYEE_NOT_FOUND",
    });
    expect((await resolveForEmployees(org.organisation.id, [foreign.id])).size).toBe(0);
  });

  it("ignores scheduled and ended windows, skips archived and foreign policies with a warning, and reports duplicate rows", async () => {
    const { org, jar } = await setup();
    const organisationId = org.organisation.id;
    const employee = await createEmployee(org);
    const team = await prisma.team.create({ data: { organisationId, name: "Grill" } });
    await prisma.employeeTeam.create({ data: { employeeId: employee.id, teamId: team.id } });
    const pDefault = await createPublishedPolicy(jar, "Default");
    const pLater = await createPublishedPolicy(jar, "Later");
    const pRetired = await createPublishedPolicy(jar, "Retired");
    await callRoute(defaultPolicyRoute, {
      method: "POST",
      path: "/api/organisations/current/default-policy",
      jar,
      body: { policyId: pDefault.id },
    });

    // A scheduled assignment is inactive until its start: the default applies now, the scheduled policy
    // from its start (`now` is a parameter, so previews are free).
    const startsAt = new Date(Date.now() + 86_400_000);
    const scheduled = await assign(jar, pLater.id, {
      scopeType: "EMPLOYEE",
      scopeId: employee.id,
      effectiveFrom: startsAt.toISOString(),
    });
    const beforeStart = await resolveEmployeePolicies(organisationId, employee.id);
    expect(beforeStart.policy?.id).toBe(pDefault.id);
    expect(beforeStart.warnings).toEqual([]);
    const atStart = await resolveEmployeePolicies(organisationId, employee.id, startsAt);
    expect(atStart.policy?.id).toBe(pLater.id);
    expect(atStart.policyResolvedFrom).toMatchObject({
      via: "ASSIGNMENT",
      scopeType: "EMPLOYEE",
      assignmentId: scheduled.assignment.id,
    });

    // Ending it before it starts cancels it, even when evaluated at the planned start.
    await callRoute(endAssignmentRoute, {
      method: "DELETE",
      path: `/api/policy-assignments/${scheduled.assignment.id}`,
      params: { id: scheduled.assignment.id },
      jar,
    });
    expect((await resolveEmployeePolicies(organisationId, employee.id, startsAt)).policy?.id).toBe(
      pDefault.id,
    );

    // A policy archived behind the API's back (it refuses while assigned) is skipped with a warning and
    // resolution falls through to the next level.
    const retired = await assign(jar, pRetired.id, { scopeType: "TEAM", scopeId: team.id });
    await prisma.policy.update({ where: { id: pRetired.id }, data: { status: "ARCHIVED" } });
    const skipped = await resolveEmployeePolicies(organisationId, employee.id);
    expect(skipped.policy?.id).toBe(pDefault.id);
    expect(skipped.warnings.map((w) => w.code)).toEqual(["INACTIVE_POLICY_SKIPPED"]);
    expect(skipped.warnings[0]?.details).toMatchObject({
      policyId: pRetired.id,
      scopeType: "TEAM",
      assignmentId: retired.assignment.id,
    });
    await callRoute(endAssignmentRoute, {
      method: "DELETE",
      path: `/api/policy-assignments/${retired.assignment.id}`,
      params: { id: retired.assignment.id },
      jar,
    });

    // A row pointing at another organisation's policy (a tenancy bug written directly — the API returns
    // 404 for it) is never applied.
    const otherOrg = await createTestOrg();
    const otherJar = await loginAs(otherOrg.owner, { organisationId: otherOrg.organisation.id });
    const foreignPolicy = await createPublishedPolicy(otherJar, "Foreign");
    const foreignRow = await prisma.policyAssignment.create({
      data: { organisationId, policyId: foreignPolicy.id, scopeType: "TEAM", scopeId: team.id },
    });
    const mismatch = await resolveEmployeePolicies(organisationId, employee.id);
    expect(mismatch.policy?.id).toBe(pDefault.id);
    expect(mismatch.warnings.map((w) => w.code)).toEqual(["POLICY_ORGANISATION_MISMATCH"]);
    expect(mismatch.warnings[0]?.details).toMatchObject({
      policyId: foreignPolicy.id,
      assignmentId: foreignRow.id,
    });
    await prisma.policyAssignment.delete({ where: { id: foreignRow.id } });

    // Two overlapping rows for one scope (the DB only forbids two open-ended ones): the newest wins and
    // the warning names both so the stale row can be cleaned up.
    const pDup = await createPublishedPolicy(jar, "Duplicate");
    const older = await prisma.policyAssignment.create({
      data: {
        organisationId,
        policyId: pDefault.id,
        scopeType: "TEAM",
        scopeId: team.id,
        effectiveTo: new Date(Date.now() + 3_600_000),
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    const newer = await prisma.policyAssignment.create({
      data: { organisationId, policyId: pDup.id, scopeType: "TEAM", scopeId: team.id },
    });
    const duplicate = await resolveEmployeePolicies(organisationId, employee.id);
    expect(duplicate.policy?.id).toBe(pDup.id);
    expect(duplicate.policyResolvedFrom).toMatchObject({ assignmentId: newer.id });
    expect(duplicate.warnings.map((w) => w.code)).toEqual(["DUPLICATE_SCOPE_ASSIGNMENT"]);
    expect(duplicate.warnings[0]?.details).toMatchObject({
      scopeType: "TEAM",
      scopeId: team.id,
      winnerAssignmentId: newer.id,
      assignmentIds: [newer.id, older.id],
    });
  });

  it("leaves soft-deleted employees out of resolution", async () => {
    const { org, jar } = await setup();
    const policy = await createPublishedPolicy(jar, "Default");
    await callRoute(defaultPolicyRoute, {
      method: "POST",
      path: "/api/organisations/current/default-policy",
      jar,
      body: { policyId: policy.id },
    });
    const gone = await createEmployee(org);
    await prisma.employee.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    expect((await resolveForEmployees(org.organisation.id, [gone.id])).size).toBe(0);
    await expect(resolveEmployeePolicies(org.organisation.id, gone.id)).rejects.toMatchObject({
      code: "EMPLOYEE_NOT_FOUND",
    });
  });
});

describe("realtime contract", () => {
  it("publishes POLICY_CHANGED as a documented kind the dashboard subscribes to and the push bridge understands", async () => {
    // The server and validation copies of REALTIME_EVENT_TYPES must stay identical (the dashboard's SSE
    // client only listens for the kinds in the validation copy).
    expect([...SERVER_EVENT_TYPES]).toEqual([...CONTRACT_EVENT_TYPES]);
    expect(CONTRACT_EVENT_TYPES).toEqual(
      expect.arrayContaining(["POLICY_CHANGED", "BREAK_POLICY_CHANGED"]),
    );
    expect(PUSH_BRIDGE_EVENT_TYPES).toEqual(
      expect.arrayContaining(["POLICY_CHANGED", "BREAK_POLICY_CHANGED"]),
    );

    const { org, jar } = await setup();
    const employee = await createEmployee(org);
    const policy = await createPublishedPolicy(jar, "Bridged");
    const { seen, unsubscribe } = collectEvents(org.organisation.id, "POLICY_CHANGED");
    await assign(jar, policy.id, { scopeType: "EMPLOYEE", scopeId: employee.id });
    unsubscribe();
    expect(seen).toHaveLength(1);
    expect(affectedEmployeeIds(seen[0]!)).toEqual([employee.id]);
    // Publishing bridges the organisation first, so the silent push also fires from this process.
    expect(isOrganisationBridged(org.organisation.id)).toBe(true);
  });
});
