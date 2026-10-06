import { prisma, type Prisma } from "@workmode/db";
import { AppError } from "@workmode/shared/errors";
import { createDefaultRestrictionConfig } from "@workmode/shared/policy/restrictionConfig";
import type { Organisation } from "@workmode/validation/organisation";
import {
  BREAK_BEHAVIOUR_DEFAULT,
  type CreatePolicyAssignmentInput,
  type CreatePolicyInput,
  type DuplicatePolicyInput,
  type ListPoliciesResponse,
  type Policy,
  type PolicyAssignment,
  type PolicyQuery,
  type PolicyVersion,
  type PublishPolicyInput,
  type RestrictionConfig,
  type SetDefaultPolicyInput,
  type UpdatePolicyInput,
} from "@workmode/validation/policies";
import { publishActivity, recordActivity } from "@/server/activity/recordActivity";
import { audit } from "@/server/audit/audit";
import { toOrganisationDto } from "@/server/organisations/mappers";
import type { ManagerContext } from "@/server/tenancy/context";
import { publishPolicyChanged } from "./events";
import {
  readBreakBehaviourDefault,
  readRestrictionConfig,
  summariseAssignment,
  toPolicyAssignmentDto,
  toPolicyDto,
  toPolicyVersionDto,
} from "./policies.mappers";
import {
  countOpenAssignmentsByPolicy,
  findAssignmentById,
  findAssignmentsForPolicy,
  findOpenAssignmentsForPolicy,
  findOpenAssignmentsForScope,
  findPolicies,
  findPolicyById,
  findPolicyVersions,
  nextVersionNumber,
  policyAssignmentInclude,
  type PolicyRow,
} from "./policies.repository";
import { countResolvedEmployees, employeesResolvingToPolicy } from "./resolution";
import {
  activeEmployeeIds,
  assertScopeTargetExists,
  employeeIdsInScope,
  loadScopeNames,
  toInputJson,
  type ScopeRef,
} from "./scopes";

export {
  computePolicyVersionString,
  countResolvedEmployees,
  employeesResolvingToBreakPolicy,
  employeesResolvingToPolicy,
  resolveEmployeePolicies,
  resolveForEmployees,
  toResolvedPolicyRefs,
} from "./resolution";
export type {
  EmployeePolicyResolution,
  PolicyResolvedFrom,
  ResolvedBreakPolicy,
  ResolvedPolicyVersionSummary,
  ResolvedWorkPolicySummary,
} from "./resolution";

/**
 * Work Policies (§3, §6.1): a policy is a named container of immutable versions. Managers edit a DRAFT
 * version; publishing stamps `publishedAt`, makes it `currentVersion` and sets the policy ACTIVE. Devices
 * only ever receive published versions. Every mutation is audited; publishing records a `POLICY_UPDATED`
 * activity and every change devices must pick up publishes a `POLICY_CHANGED` bus event.
 */

const POLICY_NAME_MAX = 120;

/** A policy is in force only with a published current version (`publishedAt` set, status ACTIVE). */
function isPublished(policy: PolicyRow): boolean {
  return policy.status === "ACTIVE" && policy.currentVersion?.publishedAt != null;
}

/**
 * `OTHER_SELECTED` means "apps the employee picks on their phone" — it cannot work without the
 * employee's own selection, so the two fields must agree.
 */
function assertOtherSelectedRule(config: RestrictionConfig): void {
  if (config.categories.includes("OTHER_SELECTED") && !config.requireEmployeeAppSelection) {
    throw new AppError("VALIDATION_ERROR", "Invalid body", {
      details: {
        source: "body",
        formErrors: [],
        fieldErrors: {
          restrictionConfig: [
            "requireEmployeeAppSelection must be true when categories include OTHER_SELECTED",
          ],
        },
      },
    });
  }
}

async function loadPolicyOrThrow(organisationId: string, id: string): Promise<PolicyRow> {
  const policy = await findPolicyById(organisationId, id);
  if (!policy) throw new AppError("NOT_FOUND", "Policy not found");
  return policy;
}

function assertNotArchived(policy: PolicyRow): void {
  if (policy.status === "ARCHIVED") {
    throw new AppError("POLICY_ARCHIVED", "This policy is archived; duplicate it to make changes");
  }
}

function auditSnapshot(policy: PolicyRow) {
  return {
    name: policy.name,
    description: policy.description,
    status: policy.status,
    currentVersionId: policy.currentVersionId,
    draftVersionId: policy.draftVersion?.id ?? null,
  };
}

function versionSnapshot(version: {
  id: string;
  versionNumber: number;
  restrictionConfig: Prisma.JsonValue;
  breakBehaviourDefault: Prisma.JsonValue;
}) {
  return {
    versionId: version.id,
    versionNumber: version.versionNumber,
    restrictionConfig: version.restrictionConfig,
    breakBehaviourDefault: version.breakBehaviourDefault,
  };
}

/** `isDefault`, `assignmentCount` (open assignments) and `assignedEmployeeCount` (via resolution). */
async function withExtras(ctx: ManagerContext, rows: PolicyRow[], now: Date): Promise<Policy[]> {
  const organisationId = ctx.organisation.id;
  const [organisation, assignmentCounts, employeeIds] = await Promise.all([
    prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { defaultPolicyId: true },
    }),
    countOpenAssignmentsByPolicy(
      organisationId,
      rows.map((r) => r.id),
      now,
    ),
    activeEmployeeIds(organisationId),
  ]);
  const { byPolicyId } = await countResolvedEmployees(organisationId, employeeIds, now);
  return rows.map((row) =>
    toPolicyDto(row, {
      isDefault: organisation?.defaultPolicyId === row.id,
      assignmentCount: assignmentCounts.get(row.id) ?? 0,
      assignedEmployeeCount: byPolicyId.get(row.id) ?? 0,
    }),
  );
}

async function reload(ctx: ManagerContext, id: string, now: Date): Promise<Policy> {
  const row = await loadPolicyOrThrow(ctx.organisation.id, id);
  const [dto] = await withExtras(ctx, [row], now);
  if (!dto) throw new AppError("NOT_FOUND", "Policy not found");
  return dto;
}

/**
 * Archiving or deleting a policy that is still in use would silently weaken (or remove) restrictions for
 * the employees it covers, so both are refused with the assignments to reassign.
 */
async function assertNotInUse(
  ctx: ManagerContext,
  policy: PolicyRow,
  now: Date,
  action: "archive" | "delete",
): Promise<void> {
  const organisationId = ctx.organisation.id;
  const [open, organisation] = await Promise.all([
    findOpenAssignmentsForPolicy(organisationId, policy.id, now),
    prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { defaultPolicyId: true },
    }),
  ]);
  const isDefault = organisation?.defaultPolicyId === policy.id;
  if (open.length === 0 && !isDefault) return;
  const names = await loadScopeNames(organisationId, open);
  const verb = action === "archive" ? "archiving" : "deleting";
  const reason = isDefault
    ? "it is the organisation default policy"
    : `it is assigned to ${open.length} ${open.length === 1 ? "scope" : "scopes"}`;
  throw new AppError(
    "POLICY_ASSIGNED",
    `This policy cannot be ${action === "archive" ? "archived" : "deleted"} because ${reason}. Reassign those employees to another policy before ${verb} it.`,
    {
      details: {
        policyId: policy.id,
        isDefault,
        assignmentCount: open.length,
        assignments: open.map((a) => summariseAssignment(a, names)),
      },
    },
  );
}

// ── Read ────────────────────────────────────────────────────────────────────

/** `GET /api/policies` (policies:read). Archived policies are hidden unless asked for. */
export async function listPolicies(
  ctx: ManagerContext,
  query: PolicyQuery = {},
): Promise<ListPoliciesResponse> {
  const now = new Date();
  const rows = await findPolicies(ctx.organisation.id, {
    status: query.status,
    search: query.search,
    includeArchived: query.includeArchived,
  });
  return { policies: await withExtras(ctx, rows, now) };
}

/** `GET /api/policies/:id` (policies:read). */
export async function getPolicy(ctx: ManagerContext, id: string): Promise<Policy> {
  return reload(ctx, id, new Date());
}

/** `GET /api/policies/:id/versions` (policies:read), newest first. */
export async function listPolicyVersions(ctx: ManagerContext, id: string): Promise<PolicyVersion[]> {
  await loadPolicyOrThrow(ctx.organisation.id, id);
  const versions = await findPolicyVersions(ctx.organisation.id, id);
  return versions.map(toPolicyVersionDto);
}

// ── Create / update / delete ────────────────────────────────────────────────

/** `POST /api/policies` (policies:write): DRAFT policy with draft version 1. Audited. */
export async function createPolicy(ctx: ManagerContext, input: CreatePolicyInput): Promise<Policy> {
  assertOtherSelectedRule(input.restrictionConfig);
  const now = new Date();
  const organisationId = ctx.organisation.id;
  const breakBehaviourDefault = input.breakBehaviourDefault ?? BREAK_BEHAVIOUR_DEFAULT;

  const created = await prisma.$transaction(async (tx) => {
    const policy = await tx.policy.create({
      data: {
        organisationId,
        name: input.name,
        description: input.description ?? null,
        status: "DRAFT",
      },
    });
    const version = await tx.policyVersion.create({
      data: {
        policyId: policy.id,
        versionNumber: 1,
        restrictionConfig: toInputJson(input.restrictionConfig),
        breakBehaviourDefault: toInputJson(breakBehaviourDefault),
        createdById: ctx.user.id,
      },
    });
    await audit(
      ctx,
      {
        action: "policy.created",
        entityType: "Policy",
        entityId: policy.id,
        after: {
          name: policy.name,
          description: policy.description,
          status: policy.status,
          ...versionSnapshot(version),
        },
      },
      tx,
    );
    return policy;
  });
  return reload(ctx, created.id, now);
}

/**
 * `PATCH /api/policies/:id` (policies:write). Name/description change in place. Config changes go into the
 * draft version: edited in place while one exists, otherwise a new draft (`versionNumber + 1`) is created
 * from the current version — devices keep the published version until the draft is published.
 */
export async function updatePolicy(
  ctx: ManagerContext,
  id: string,
  input: UpdatePolicyInput,
): Promise<Policy> {
  const now = new Date();
  const organisationId = ctx.organisation.id;
  const policy = await loadPolicyOrThrow(organisationId, id);
  assertNotArchived(policy);

  const wantsVersionChange =
    input.restrictionConfig !== undefined || input.breakBehaviourDefault !== undefined;
  const base = policy.draftVersion ?? policy.currentVersion ?? null;
  const restrictionConfig =
    input.restrictionConfig ??
    (base ? readRestrictionConfig(base.restrictionConfig, base.id) : createDefaultRestrictionConfig());
  const breakBehaviourDefault =
    input.breakBehaviourDefault ??
    (base ? readBreakBehaviourDefault(base.breakBehaviourDefault) : BREAK_BEHAVIOUR_DEFAULT);
  if (wantsVersionChange) assertOtherSelectedRule(restrictionConfig);

  await prisma.$transaction(async (tx) => {
    const data: Prisma.PolicyUpdateInput = { updatedAt: now };
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    const updated = await tx.policy.update({ where: { id: policy.id }, data });

    let version: { id: string; versionNumber: number; restrictionConfig: Prisma.JsonValue; breakBehaviourDefault: Prisma.JsonValue } | null = null;
    if (wantsVersionChange) {
      const versionData = {
        restrictionConfig: toInputJson(restrictionConfig),
        breakBehaviourDefault: toInputJson(breakBehaviourDefault),
      };
      version = policy.draftVersion
        ? await tx.policyVersion.update({ where: { id: policy.draftVersion.id }, data: versionData })
        : await tx.policyVersion.create({
            data: {
              policyId: policy.id,
              versionNumber: await nextVersionNumber(policy.id, tx),
              createdById: ctx.user.id,
              ...versionData,
            },
          });
    }

    await audit(
      ctx,
      {
        action: "policy.updated",
        entityType: "Policy",
        entityId: policy.id,
        before: {
          ...auditSnapshot(policy),
          ...(wantsVersionChange && base ? versionSnapshot(base) : {}),
        },
        after: {
          name: updated.name,
          description: updated.description,
          status: updated.status,
          currentVersionId: updated.currentVersionId,
          draftVersionId: version?.id ?? policy.draftVersion?.id ?? null,
          ...(version ? versionSnapshot(version) : {}),
        },
      },
      tx,
    );
  });
  return reload(ctx, id, now);
}

/** `DELETE /api/policies/:id` (policies:write): soft delete; refused while assigned or default. */
export async function deletePolicy(ctx: ManagerContext, id: string): Promise<void> {
  const now = new Date();
  const policy = await loadPolicyOrThrow(ctx.organisation.id, id);
  await assertNotInUse(ctx, policy, now, "delete");
  await prisma.$transaction(async (tx) => {
    await tx.policy.update({ where: { id: policy.id }, data: { deletedAt: now } });
    await audit(
      ctx,
      {
        action: "policy.deleted",
        entityType: "Policy",
        entityId: policy.id,
        before: auditSnapshot(policy),
        after: { deletedAt: now.toISOString() },
      },
      tx,
    );
  });
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * `POST /api/policies/:id/publish` (policies:write): stamps the draft version, makes it current and the
 * policy ACTIVE. `CONFLICT` when there is nothing to publish. Records `POLICY_UPDATED` and tells devices.
 */
export async function publishPolicy(
  ctx: ManagerContext,
  id: string,
  input: PublishPolicyInput = {},
): Promise<Policy> {
  const now = new Date();
  const organisationId = ctx.organisation.id;
  const policy = await loadPolicyOrThrow(organisationId, id);
  assertNotArchived(policy);
  const draft = policy.draftVersion;
  if (!draft) {
    throw new AppError("CONFLICT", "Nothing to publish: this policy has no unpublished changes");
  }
  const changeNote = input.changeNote?.trim() ? input.changeNote.trim() : null;

  const activity = await prisma.$transaction(async (tx) => {
    const stamped = await tx.policyVersion.updateMany({
      where: { id: draft.id, publishedAt: null },
      data: { publishedAt: now, changeNote },
    });
    if (stamped.count !== 1) {
      throw new AppError("CONFLICT", "This version was already published");
    }
    const updated = await tx.policy.update({
      where: { id: policy.id },
      data: { currentVersionId: draft.id, status: "ACTIVE" },
    });
    await audit(
      ctx,
      {
        action: "policy.published",
        entityType: "Policy",
        entityId: policy.id,
        before: auditSnapshot(policy),
        after: {
          status: updated.status,
          currentVersionId: updated.currentVersionId,
          versionNumber: draft.versionNumber,
          changeNote,
          publishedAt: now.toISOString(),
        },
      },
      tx,
    );
    const { event } = await recordActivity(
      {
        organisationId,
        actorType: "MANAGER",
        actorUserId: ctx.user.id,
        type: "POLICY_UPDATED",
        occurredAt: now,
        metadata: { policyId: policy.id, versionId: draft.id, versionNumber: draft.versionNumber },
      },
      { db: tx, publish: false },
    );
    return event;
  });
  publishActivity(activity);

  const affected = await employeesResolvingToPolicy(
    organisationId,
    await activeEmployeeIds(organisationId),
    policy.id,
    now,
  );
  publishPolicyChanged({
    organisationId,
    policyId: policy.id,
    reason: "PUBLISHED",
    affectedEmployeeIds: affected,
    versionId: draft.id,
    versionNumber: draft.versionNumber,
  });
  return reload(ctx, id, now);
}

/** `POST /api/policies/:id/duplicate` (policies:write): new DRAFT `<name> (copy)` from the latest version. */
export async function duplicatePolicy(
  ctx: ManagerContext,
  id: string,
  input: DuplicatePolicyInput = {},
): Promise<Policy> {
  const now = new Date();
  const organisationId = ctx.organisation.id;
  const source = await loadPolicyOrThrow(organisationId, id);
  const latest = source.draftVersion ?? source.currentVersion ?? null;
  const restrictionConfig = latest
    ? readRestrictionConfig(latest.restrictionConfig, latest.id)
    : createDefaultRestrictionConfig();
  const breakBehaviourDefault = latest
    ? readBreakBehaviourDefault(latest.breakBehaviourDefault)
    : BREAK_BEHAVIOUR_DEFAULT;
  const name = input.name ?? `${source.name} (copy)`.slice(0, POLICY_NAME_MAX);

  const created = await prisma.$transaction(async (tx) => {
    const policy = await tx.policy.create({
      data: { organisationId, name, description: source.description, status: "DRAFT" },
    });
    const version = await tx.policyVersion.create({
      data: {
        policyId: policy.id,
        versionNumber: 1,
        restrictionConfig: toInputJson(restrictionConfig),
        breakBehaviourDefault: toInputJson(breakBehaviourDefault),
        createdById: ctx.user.id,
      },
    });
    await audit(
      ctx,
      {
        action: "policy.duplicated",
        entityType: "Policy",
        entityId: policy.id,
        after: {
          sourcePolicyId: source.id,
          sourceVersionId: latest?.id ?? null,
          name: policy.name,
          ...versionSnapshot(version),
        },
      },
      tx,
    );
    return policy;
  });
  return reload(ctx, created.id, now);
}

/** `POST /api/policies/:id/archive` (policies:write): refused while assigned or default. Idempotent. */
export async function archivePolicy(ctx: ManagerContext, id: string): Promise<Policy> {
  const now = new Date();
  const policy = await loadPolicyOrThrow(ctx.organisation.id, id);
  if (policy.status === "ARCHIVED") return reload(ctx, id, now);
  await assertNotInUse(ctx, policy, now, "archive");
  await prisma.$transaction(async (tx) => {
    await tx.policy.update({ where: { id: policy.id }, data: { status: "ARCHIVED" } });
    await audit(
      ctx,
      {
        action: "policy.archived",
        entityType: "Policy",
        entityId: policy.id,
        before: auditSnapshot(policy),
        after: { status: "ARCHIVED" },
      },
      tx,
    );
  });
  return reload(ctx, id, now);
}

// ── Assignments ─────────────────────────────────────────────────────────────

/** `GET /api/policies/:id/assignments` (policies:read): every assignment of the policy, newest first. */
export async function listPolicyAssignments(
  ctx: ManagerContext,
  id: string,
): Promise<PolicyAssignment[]> {
  const now = new Date();
  await loadPolicyOrThrow(ctx.organisation.id, id);
  const rows = await findAssignmentsForPolicy(ctx.organisation.id, id);
  const names = await loadScopeNames(ctx.organisation.id, rows);
  return rows.map((row) => toPolicyAssignmentDto(row, names, now));
}

/**
 * `POST /api/policies/:id/assignments` (policies:write). The policy must be published; the scope target
 * must exist in the organisation (ORGANISATION → the organisation itself). Any assignment still open for
 * that scope is ended at the new one's start (`effectiveFrom ?? now`) in the same transaction, so there is
 * exactly one assignment per scope at any instant (the partial unique index only guards open-ended rows).
 */
export async function createPolicyAssignment(
  ctx: ManagerContext,
  id: string,
  input: CreatePolicyAssignmentInput,
): Promise<PolicyAssignment> {
  const now = new Date();
  const organisationId = ctx.organisation.id;
  const policy = await loadPolicyOrThrow(organisationId, id);
  assertNotArchived(policy);
  if (!isPublished(policy)) {
    throw new AppError(
      "POLICY_NOT_PUBLISHED",
      "Publish this policy before assigning it; devices only receive published versions",
    );
  }
  const scope: ScopeRef = { scopeType: input.scopeType, scopeId: input.scopeId };
  await assertScopeTargetExists(organisationId, scope);
  const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : null;
  const effectiveTo = input.effectiveTo ? new Date(input.effectiveTo) : null;
  const replaceAt = effectiveFrom ?? now;

  const created = await prisma.$transaction(async (tx) => {
    const open = await findOpenAssignmentsForScope(organisationId, scope, now, tx);
    for (const previous of open) {
      const endAt =
        previous.effectiveTo && previous.effectiveTo.getTime() < replaceAt.getTime()
          ? previous.effectiveTo
          : replaceAt;
      if (previous.effectiveTo && previous.effectiveTo.getTime() === endAt.getTime()) continue;
      await tx.policyAssignment.update({ where: { id: previous.id }, data: { effectiveTo: endAt } });
      await audit(
        ctx,
        {
          action: "policy_assignment.ended",
          entityType: "PolicyAssignment",
          entityId: previous.id,
          before: { ...summariseAssignment(previous), policyId: previous.policyId },
          after: { effectiveTo: endAt.toISOString(), replacedBy: "new assignment" },
        },
        tx,
      );
    }
    const row = await tx.policyAssignment.create({
      data: {
        organisationId,
        policyId: policy.id,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        effectiveFrom,
        effectiveTo,
        createdById: ctx.user.id,
      },
      include: policyAssignmentInclude,
    });
    await audit(
      ctx,
      {
        action: "policy_assignment.created",
        entityType: "PolicyAssignment",
        entityId: row.id,
        after: {
          ...summariseAssignment(row),
          policyId: policy.id,
          replacedAssignmentIds: open.map((a) => a.id),
        },
      },
      tx,
    );
    return row;
  });

  publishPolicyChanged({
    organisationId,
    policyId: policy.id,
    reason: "ASSIGNED",
    affectedEmployeeIds: await employeeIdsInScope(organisationId, scope),
  });
  const names = await loadScopeNames(organisationId, [scope]);
  return toPolicyAssignmentDto(created, names, now);
}

/** `DELETE /api/policy-assignments/:id` (policies:write): ends the assignment now. Idempotent. */
export async function endPolicyAssignment(ctx: ManagerContext, assignmentId: string): Promise<void> {
  const now = new Date();
  const organisationId = ctx.organisation.id;
  const assignment = await findAssignmentById(organisationId, assignmentId);
  if (!assignment) throw new AppError("NOT_FOUND", "Assignment not found");
  if (assignment.effectiveTo && assignment.effectiveTo.getTime() <= now.getTime()) return;

  await prisma.$transaction(async (tx) => {
    await tx.policyAssignment.update({ where: { id: assignment.id }, data: { effectiveTo: now } });
    await audit(
      ctx,
      {
        action: "policy_assignment.ended",
        entityType: "PolicyAssignment",
        entityId: assignment.id,
        before: { ...summariseAssignment(assignment), policyId: assignment.policyId },
        after: { effectiveTo: now.toISOString() },
      },
      tx,
    );
  });
  publishPolicyChanged({
    organisationId,
    policyId: assignment.policyId,
    reason: "UNASSIGNED",
    affectedEmployeeIds: await employeeIdsInScope(organisationId, assignment),
  });
}

// ── Organisation default ────────────────────────────────────────────────────

/**
 * `POST /api/organisations/current/default-policy` (policies:write): `policyId` must be a published policy
 * of this organisation; `null` clears the default. Everyone without a more specific assignment is affected.
 */
export async function setDefaultPolicy(
  ctx: ManagerContext,
  input: SetDefaultPolicyInput,
): Promise<Organisation> {
  const organisationId = ctx.organisation.id;
  if (input.policyId !== null) {
    const policy = await loadPolicyOrThrow(organisationId, input.policyId);
    assertNotArchived(policy);
    if (!isPublished(policy)) {
      throw new AppError(
        "POLICY_NOT_PUBLISHED",
        "Publish this policy before making it the organisation default",
      );
    }
  }

  const { before, after } = await prisma.$transaction(async (tx) => {
    const current = await tx.organisation.findUniqueOrThrow({
      where: { id: organisationId },
      select: { defaultPolicyId: true },
    });
    const updated = await tx.organisation.update({
      where: { id: organisationId },
      data: { defaultPolicyId: input.policyId },
    });
    if (current.defaultPolicyId !== input.policyId) {
      await audit(
        ctx,
        {
          action: "organisation.default_policy_changed",
          entityType: "Organisation",
          entityId: organisationId,
          before: { defaultPolicyId: current.defaultPolicyId },
          after: { defaultPolicyId: input.policyId },
        },
        tx,
      );
    }
    return { before: current.defaultPolicyId, after: updated };
  });

  if (before !== input.policyId) {
    publishPolicyChanged({
      organisationId,
      policyId: input.policyId,
      reason: "DEFAULT_CHANGED",
      affectedEmployeeIds: await activeEmployeeIds(organisationId),
    });
  }
  return toOrganisationDto(after);
}
