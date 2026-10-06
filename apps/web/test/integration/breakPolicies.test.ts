import { prisma } from "@workmode/db";
import {
  BREAK_POLICY_DEFAULTS,
  breakPolicyAssignmentResponseSchema,
  breakPolicyResponseSchema,
  listBreakPoliciesResponseSchema,
  listBreakPolicyAssignmentsResponseSchema,
  type BreakPolicyAssignmentResponse,
  type BreakPolicyResponse,
  type ListBreakPoliciesResponse,
  type ListBreakPolicyAssignmentsResponse,
} from "@workmode/validation/breakPolicies";
import type { OrganisationResponse } from "@workmode/validation/organisation";
import { describe, expect, it } from "vitest";
import {
  GET as listAssignmentsRoute,
  POST as assignRoute,
} from "@/app/api/break-policies/[id]/assignments/route";
import {
  DELETE as deleteRoute,
  GET as getRoute,
  PATCH as patchRoute,
} from "@/app/api/break-policies/[id]/route";
import { GET as listRoute, POST as createRoute } from "@/app/api/break-policies/route";
import { DELETE as endAssignmentRoute } from "@/app/api/break-policy-assignments/[id]/route";
import { POST as defaultRoute } from "@/app/api/organisations/current/default-break-policy/route";
import { getEventBus, type RealtimeEvent } from "@/server/events";
import { computePolicyVersionString, resolveEmployeePolicies } from "@/server/policies/policies.service";
import {
  addMember,
  callRoute,
  createTestOrg,
  createTestUser,
  loginAs,
  type CookieJar,
  type ErrorBody,
} from "../helpers";

async function setup() {
  const org = await createTestOrg({ firstLocationName: "Depot" });
  const jar = await loginAs(org.owner, { organisationId: org.organisation.id });
  return { org, jar };
}

async function createBreakPolicy(jar: CookieJar, body: Record<string, unknown>) {
  const res = await callRoute<BreakPolicyResponse>(createRoute, {
    method: "POST",
    path: "/api/break-policies",
    jar,
    body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.breakPolicy;
}

async function assign(jar: CookieJar, id: string, body: Record<string, unknown>, expectStatus = 201) {
  const res = await callRoute<BreakPolicyAssignmentResponse & ErrorBody>(assignRoute, {
    method: "POST",
    path: `/api/break-policies/${id}/assignments`,
    params: { id },
    jar,
    body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(expectStatus);
  return res.body;
}

function collectEvents(organisationId: string) {
  const seen: RealtimeEvent[] = [];
  const unsubscribe = getEventBus().subscribe(organisationId, (e) => {
    if (e.type === "BREAK_POLICY_CHANGED") seen.push(e);
  });
  return { seen, unsubscribe };
}

describe("break policies", () => {
  it("creates with defaults, validates the contract and audits", async () => {
    const { org, jar } = await setup();
    const res = await callRoute<BreakPolicyResponse>(createRoute, {
      method: "POST",
      path: "/api/break-policies",
      jar,
      body: { name: "Standard breaks", description: "Two short breaks" },
    });
    expect(res.status).toBe(201);
    expect(breakPolicyResponseSchema.parse(res.body)).toBeTruthy();
    expect(res.body.breakPolicy).toMatchObject({
      name: "Standard breaks",
      description: "Two short breaks",
      status: "ACTIVE",
      isDefault: false,
      assignmentCount: 0,
      assignedEmployeeCount: 0,
      ...BREAK_POLICY_DEFAULTS,
    });
    expect(
      await prisma.auditLog.count({
        where: { organisationId: org.organisation.id, action: "break_policy.created" },
      }),
    ).toBe(1);

    const fetched = await callRoute<BreakPolicyResponse>(getRoute, {
      path: `/api/break-policies/${res.body.breakPolicy.id}`,
      params: { id: res.body.breakPolicy.id },
      jar,
    });
    expect(fetched.status).toBe(200);
    expect(fetched.body.breakPolicy.id).toBe(res.body.breakPolicy.id);
  });

  it("rejects inconsistent rules on create and on the merged PATCH", async () => {
    const { jar } = await setup();
    const relaxNothing = await callRoute<ErrorBody>(createRoute, {
      method: "POST",
      path: "/api/break-policies",
      jar,
      body: { name: "Bad", restrictionBehaviour: "RELAX_CATEGORIES", relaxedCategories: [] },
    });
    expect(relaxNothing.status).toBe(400);
    expect(relaxNothing.body.error.code).toBe("VALIDATION_ERROR");
    expect(relaxNothing.body.error.details).toMatchObject({
      fieldErrors: { relaxedCategories: expect.any(Array) },
    });

    const policy = await createBreakPolicy(jar, { name: "Strict" });
    const zeroMinutes = await callRoute<ErrorBody>(patchRoute, {
      method: "PATCH",
      path: `/api/break-policies/${policy.id}`,
      params: { id: policy.id },
      jar,
      body: { maxTotalBreakMinutes: 0 },
    });
    expect(zeroMinutes.status).toBe(400);
    expect(zeroMinutes.body.error.code).toBe("VALIDATION_ERROR");
    expect(zeroMinutes.body.error.details).toMatchObject({
      source: "body",
      fieldErrors: { maxTotalBreakMinutes: expect.any(Array) },
    });

    const tooLong = await callRoute<ErrorBody>(patchRoute, {
      method: "PATCH",
      path: `/api/break-policies/${policy.id}`,
      params: { id: policy.id },
      jar,
      body: { maxBreakDurationMinutes: 45 }, // > default total of 30
    });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.details).toMatchObject({
      fieldErrors: { maxBreakDurationMinutes: expect.any(Array) },
    });

    // Disabling breaks makes the zero-minute rule set valid again.
    const disabled = await callRoute<BreakPolicyResponse>(patchRoute, {
      method: "PATCH",
      path: `/api/break-policies/${policy.id}`,
      params: { id: policy.id },
      jar,
      body: { breaksEnabled: false, maxTotalBreakMinutes: 0 },
    });
    expect(disabled.status).toBe(200);
    expect(disabled.body.breakPolicy).toMatchObject({ breaksEnabled: false, maxTotalBreakMinutes: 0 });

    const unknown = await callRoute<ErrorBody>(patchRoute, {
      method: "PATCH",
      path: `/api/break-policies/${policy.id}`,
      params: { id: policy.id },
      jar,
      body: { nope: true },
    });
    expect(unknown.status).toBe(400);
  });

  it("PATCH merges rules, audits, and notifies the employees who resolve to the policy", async () => {
    const { org, jar } = await setup();
    const policy = await createBreakPolicy(jar, { name: "Floor" });
    const employee = await prisma.employee.create({
      data: { organisationId: org.organisation.id, firstName: "Ola", lastName: "Floor" },
    });
    await assign(jar, policy.id, { scopeType: "EMPLOYEE", scopeId: employee.id });
    const { seen, unsubscribe } = collectEvents(org.organisation.id);

    const renamed = await callRoute<BreakPolicyResponse>(patchRoute, {
      method: "PATCH",
      path: `/api/break-policies/${policy.id}`,
      params: { id: policy.id },
      jar,
      body: { name: "Floor breaks", description: "" },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.breakPolicy).toMatchObject({ name: "Floor breaks", description: null });
    expect(seen).toHaveLength(0); // no rule change → devices need not refresh

    const rules = await callRoute<BreakPolicyResponse>(patchRoute, {
      method: "PATCH",
      path: `/api/break-policies/${policy.id}`,
      params: { id: policy.id },
      jar,
      body: {
        maxBreaksPerShift: 3,
        maxTotalBreakMinutes: 45,
        restrictionBehaviour: "RELAX_CATEGORIES",
        relaxedCategories: ["GAMES", "GAMES"].slice(0, 1),
      },
    });
    expect(rules.status).toBe(200);
    expect(rules.body.breakPolicy).toMatchObject({
      maxBreaksPerShift: 3,
      maxTotalBreakMinutes: 45,
      maxBreakDurationMinutes: BREAK_POLICY_DEFAULTS.maxBreakDurationMinutes,
      restrictionBehaviour: "RELAX_CATEGORIES",
      relaxedCategories: ["GAMES"],
      assignmentCount: 1,
      assignedEmployeeCount: 1,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.payload).toMatchObject({
      breakPolicyId: policy.id,
      reason: "RULES_CHANGED",
      affectedEmployeeIds: [employee.id],
    });
    expect(
      await prisma.auditLog.count({
        where: { organisationId: org.organisation.id, action: "break_policy.updated" },
      }),
    ).toBe(2);

    const resolved = await resolveEmployeePolicies(org.organisation.id, employee.id);
    expect(resolved.breakPolicy?.id).toBe(policy.id);
    expect(resolved.breakPolicy?.rules).toMatchObject({
      maxBreaksPerShift: 3,
      relaxedCategories: ["GAMES"],
    });
    expect(resolved.breakPolicyResolvedFrom).toMatchObject({ via: "ASSIGNMENT", scopeType: "EMPLOYEE" });
    expect(computePolicyVersionString(resolved)).toBe(
      `none|${policy.id}:${resolved.breakPolicy!.updatedAt.getTime()}`,
    );
    unsubscribe();
  });

  it("assigns per scope (replacing), lists, ends, and blocks delete while in use", async () => {
    const { org, jar } = await setup();
    const strict = await createBreakPolicy(jar, { name: "Strict" });
    const relaxed = await createBreakPolicy(jar, { name: "Relaxed" });
    const team = await prisma.team.create({ data: { organisationId: org.organisation.id, name: "Kitchen" } });
    const otherOrg = await createTestOrg();
    const foreignTeam = await prisma.team.create({
      data: { organisationId: otherOrg.organisation.id, name: "Elsewhere" },
    });
    const { seen, unsubscribe } = collectEvents(org.organisation.id);

    const foreign = await assign(jar, strict.id, { scopeType: "TEAM", scopeId: foreignTeam.id }, 404);
    expect(foreign.error.code).toBe("NOT_FOUND");

    const first = await assign(jar, strict.id, { scopeType: "TEAM", scopeId: team.id });
    expect(breakPolicyAssignmentResponseSchema.parse(first)).toBeTruthy();
    expect(first.assignment).toMatchObject({
      breakPolicy: { id: strict.id, name: "Strict" },
      scope: { id: team.id, name: "Kitchen" },
      isActive: true,
    });
    expect(seen.at(-1)?.payload).toMatchObject({ breakPolicyId: strict.id, reason: "ASSIGNED" });

    const blocked = await callRoute<ErrorBody>(deleteRoute, {
      method: "DELETE",
      path: `/api/break-policies/${strict.id}`,
      params: { id: strict.id },
      jar,
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("POLICY_ASSIGNED");
    expect(blocked.body.error.details).toMatchObject({
      breakPolicyId: strict.id,
      assignmentCount: 1,
      assignments: [{ id: first.assignment.id, scopeName: "Kitchen" }],
    });

    const second = await assign(jar, relaxed.id, { scopeType: "TEAM", scopeId: team.id });
    const previous = await prisma.breakPolicyAssignment.findUniqueOrThrow({
      where: { id: first.assignment.id },
    });
    expect(previous.effectiveTo).not.toBeNull();
    expect(
      await prisma.breakPolicyAssignment.count({
        where: { scopeType: "TEAM", scopeId: team.id, effectiveTo: null },
      }),
    ).toBe(1);

    const listed = await callRoute<ListBreakPolicyAssignmentsResponse>(listAssignmentsRoute, {
      path: `/api/break-policies/${strict.id}/assignments`,
      params: { id: strict.id },
      jar,
    });
    expect(listBreakPolicyAssignmentsResponseSchema.parse(listed.body)).toBeTruthy();
    expect(listed.body.assignments.map((a) => [a.id, a.isActive])).toEqual([[first.assignment.id, false]]);

    // Strict is no longer in use → delete succeeds (soft).
    const deleted = await callRoute(deleteRoute, {
      method: "DELETE",
      path: `/api/break-policies/${strict.id}`,
      params: { id: strict.id },
      jar,
    });
    expect(deleted.status).toBe(204);
    const gone = await callRoute<ErrorBody>(getRoute, {
      path: `/api/break-policies/${strict.id}`,
      params: { id: strict.id },
      jar,
    });
    expect(gone.status).toBe(404);

    const ended = await callRoute(endAssignmentRoute, {
      method: "DELETE",
      path: `/api/break-policy-assignments/${second.assignment.id}`,
      params: { id: second.assignment.id },
      jar,
    });
    expect(ended.status).toBe(204);
    expect(seen.at(-1)?.payload).toMatchObject({ breakPolicyId: relaxed.id, reason: "UNASSIGNED" });
    const list = await callRoute<ListBreakPoliciesResponse>(listRoute, { path: "/api/break-policies", jar });
    expect(listBreakPoliciesResponseSchema.parse(list.body)).toBeTruthy();
    expect(list.body.breakPolicies.map((p) => [p.name, p.assignmentCount])).toEqual([["Relaxed", 0]]);
    unsubscribe();
  });

  it("sets and clears the organisation default break policy, which resolves for everyone", async () => {
    const { org, jar } = await setup();
    const policy = await createBreakPolicy(jar, { name: "House rules" });
    const employee = await prisma.employee.create({
      data: { organisationId: org.organisation.id, firstName: "Dee", lastName: "Fault" },
    });
    const { seen, unsubscribe } = collectEvents(org.organisation.id);

    const missing = await callRoute<ErrorBody>(defaultRoute, {
      method: "POST",
      path: "/api/organisations/current/default-break-policy",
      jar,
      body: { breakPolicyId: "00000000-0000-4000-8000-000000000000" },
    });
    expect(missing.status).toBe(404);

    const set = await callRoute<OrganisationResponse>(defaultRoute, {
      method: "POST",
      path: "/api/organisations/current/default-break-policy",
      jar,
      body: { breakPolicyId: policy.id },
    });
    expect(set.status).toBe(200);
    expect(set.body.organisation.defaultBreakPolicyId).toBe(policy.id);
    expect(seen.at(-1)?.payload).toMatchObject({
      breakPolicyId: policy.id,
      reason: "DEFAULT_CHANGED",
      affectedEmployeeIds: [employee.id],
    });

    const resolved = await resolveEmployeePolicies(org.organisation.id, employee.id);
    expect(resolved.breakPolicy?.id).toBe(policy.id);
    expect(resolved.breakPolicyResolvedFrom).toMatchObject({ via: "DEFAULT", scopeType: "ORGANISATION" });

    const fetched = await callRoute<BreakPolicyResponse>(getRoute, {
      path: `/api/break-policies/${policy.id}`,
      params: { id: policy.id },
      jar,
    });
    expect(fetched.body.breakPolicy).toMatchObject({ isDefault: true, assignedEmployeeCount: 1 });

    const deleteDefault = await callRoute<ErrorBody>(deleteRoute, {
      method: "DELETE",
      path: `/api/break-policies/${policy.id}`,
      params: { id: policy.id },
      jar,
    });
    expect(deleteDefault.status).toBe(409);
    expect(deleteDefault.body.error.details).toMatchObject({ isDefault: true });

    const cleared = await callRoute<OrganisationResponse>(defaultRoute, {
      method: "POST",
      path: "/api/organisations/current/default-break-policy",
      jar,
      body: { breakPolicyId: null },
    });
    expect(cleared.body.organisation.defaultBreakPolicyId).toBeNull();
    expect(
      await prisma.auditLog.count({
        where: {
          organisationId: org.organisation.id,
          action: "organisation.default_break_policy_changed",
        },
      }),
    ).toBe(2);
    unsubscribe();
  });

  it("lets MANAGER read but not write", async () => {
    const { org, jar: ownerJar } = await setup();
    await createBreakPolicy(ownerJar, { name: "Visible" });
    const { user: manager } = await createTestUser();
    await addMember(org.organisation.id, manager, "MANAGER");
    const jar = await loginAs(manager, { organisationId: org.organisation.id });
    const read = await callRoute<ListBreakPoliciesResponse>(listRoute, { path: "/api/break-policies", jar });
    expect(read.status).toBe(200);
    expect(read.body.breakPolicies).toHaveLength(1);
    const write = await callRoute<ErrorBody>(createRoute, {
      method: "POST",
      path: "/api/break-policies",
      jar,
      body: { name: "Nope" },
    });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe("FORBIDDEN");
  });
});
