import { prisma, type Prisma } from "@workmode/db";
import { AppError } from "@workmode/shared/errors";
import {
  breakPolicyRulesSchema,
  type BreakPolicy,
  type BreakPolicyAssignment,
  type BreakPolicyQuery,
  type BreakPolicyRules,
  type CreateBreakPolicyAssignmentInput,
  type CreateBreakPolicyInput,
  type ListBreakPoliciesResponse,
  type SetDefaultBreakPolicyInput,
  type UpdateBreakPolicyInput,
} from "@workmode/validation/breakPolicies";
import type { Organisation } from "@workmode/validation/organisation";
import { z } from "zod";
import { audit } from "@/server/audit/audit";
import { toOrganisationDto } from "@/server/organisations/mappers";
import { publishBreakPolicyChanged } from "@/server/policies/events";
import { countResolvedEmployees, employeesResolvingToBreakPolicy } from "@/server/policies/resolution";
import {
  activeEmployeeIds,
  assertScopeTargetExists,
  employeeIdsInScope,
  loadScopeNames,
  toInputJson,
  type ScopeRef,
} from "@/server/policies/scopes";
import type { ManagerContext } from "@/server/tenancy/context";
import {
  rulesOf,
  summariseBreakAssignment,
  toBreakPolicyAssignmentDto,
  toBreakPolicyDto,
} from "./breakPolicies.mappers";
import {
  breakPolicyAssignmentInclude,
  countOpenAssignmentsByBreakPolicy,
  findAssignmentsForBreakPolicy,
  findBreakAssignmentById,
  findBreakPolicies,
  findBreakPolicyById,
  findOpenAssignmentsForBreakPolicy,
  findOpenBreakAssignmentsForScope,
  type BreakPolicyRow,
} from "./breakPolicies.repository";

/**
 * Break Policies (§6.3): a single row holds the rules (no versions — breaks already in progress keep the
 * behaviour snapshot stored on their session). Rule changes, assignments and the organisation default
 * publish `BREAK_POLICY_CHANGED` so devices refresh their cached rules. Every mutation is audited.
 */

const RULE_KEYS = [
  "breaksEnabled",
  "maxBreaksPerShift",
  "maxBreakDurationMinutes",
  "maxTotalBreakMinutes",
  "minGapBetweenBreaksMinutes",
  "minMinutesAfterShiftStart",
  "employeeTriggeredAllowed",
  "scheduledBreaksAllowed",
  "restrictionBehaviour",
  "relaxedCategories",
] as const satisfies readonly (keyof BreakPolicyRules)[];

async function loadBreakPolicyOrThrow(organisationId: string, id: string): Promise<BreakPolicyRow> {
  const row = await findBreakPolicyById(organisationId, id);
  if (!row) throw new AppError("NOT_FOUND", "Break policy not found");
  return row;
}

function assertNotArchived(row: BreakPolicyRow): void {
  if (row.status === "ARCHIVED") {
    throw new AppError("POLICY_ARCHIVED", "This break policy is archived");
  }
}

function auditSnapshot(row: BreakPolicyRow) {
  return { name: row.name, description: row.description, status: row.status, ...rulesOf(row) };
}

function rulesToData(rules: BreakPolicyRules): Prisma.BreakPolicyUncheckedUpdateInput {
  return { ...rules, relaxedCategories: toInputJson(rules.relaxedCategories) };
}

async function withExtras(
  ctx: ManagerContext,
  rows: BreakPolicyRow[],
  now: Date,
): Promise<BreakPolicy[]> {
  const organisationId = ctx.organisation.id;
  const [organisation, assignmentCounts, employeeIds] = await Promise.all([
    prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { defaultBreakPolicyId: true },
    }),
    countOpenAssignmentsByBreakPolicy(
      organisationId,
      rows.map((r) => r.id),
      now,
    ),
    activeEmployeeIds(organisationId),
  ]);
  const { byBreakPolicyId } = await countResolvedEmployees(organisationId, employeeIds, now);
  return rows.map((row) =>
    toBreakPolicyDto(row, {
      isDefault: organisation?.defaultBreakPolicyId === row.id,
      assignmentCount: assignmentCounts.get(row.id) ?? 0,
      assignedEmployeeCount: byBreakPolicyId.get(row.id) ?? 0,
    }),
  );
}

async function reload(ctx: ManagerContext, id: string, now: Date): Promise<BreakPolicy> {
  const row = await loadBreakPolicyOrThrow(ctx.organisation.id, id);
  const [dto] = await withExtras(ctx, [row], now);
  if (!dto) throw new AppError("NOT_FOUND", "Break policy not found");
  return dto;
}

async function assertNotInUse(ctx: ManagerContext, row: BreakPolicyRow, now: Date): Promise<void> {
  const organisationId = ctx.organisation.id;
  const [open, organisation] = await Promise.all([
    findOpenAssignmentsForBreakPolicy(organisationId, row.id, now),
    prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { defaultBreakPolicyId: true },
    }),
  ]);
  const isDefault = organisation?.defaultBreakPolicyId === row.id;
  if (open.length === 0 && !isDefault) return;
  const names = await loadScopeNames(organisationId, open);
  const reason = isDefault
    ? "it is the organisation default break policy"
    : `it is assigned to ${open.length} ${open.length === 1 ? "scope" : "scopes"}`;
  throw new AppError(
    "POLICY_ASSIGNED",
    `This break policy cannot be deleted because ${reason}. Reassign those employees first.`,
    {
      details: {
        breakPolicyId: row.id,
        isDefault,
        assignmentCount: open.length,
        assignments: open.map((a) => summariseBreakAssignment(a, names)),
      },
    },
  );
}

/** Affected employees for a rules change: everyone whose resolved break policy is this one. */
async function affectedByBreakPolicy(organisationId: string, breakPolicyId: string, now: Date) {
  return employeesResolvingToBreakPolicy(
    organisationId,
    await activeEmployeeIds(organisationId),
    breakPolicyId,
    now,
  );
}

// ── Read ────────────────────────────────────────────────────────────────────

/** `GET /api/break-policies` (policies:read). Archived hidden unless asked for. */
export async function listBreakPolicies(
  ctx: ManagerContext,
  query: BreakPolicyQuery = {},
): Promise<ListBreakPoliciesResponse> {
  const now = new Date();
  const rows = await findBreakPolicies(ctx.organisation.id, {
    status: query.status,
    search: query.search,
    includeArchived: query.includeArchived,
  });
  return { breakPolicies: await withExtras(ctx, rows, now) };
}

/** `GET /api/break-policies/:id` (policies:read). */
export async function getBreakPolicy(ctx: ManagerContext, id: string): Promise<BreakPolicy> {
  return reload(ctx, id, new Date());
}

// ── Create / update / delete ────────────────────────────────────────────────

/** `POST /api/break-policies` (policies:write). Defaults applied by the schema. Audited. */
export async function createBreakPolicy(
  ctx: ManagerContext,
  input: CreateBreakPolicyInput,
): Promise<BreakPolicy> {
  const now = new Date();
  const organisationId = ctx.organisation.id;
  const { name, description, ...rules } = input;
  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.breakPolicy.create({
      data: {
        organisationId,
        name,
        description: description ?? null,
        status: "ACTIVE",
        ...rules,
        relaxedCategories: toInputJson(rules.relaxedCategories),
      },
    });
    await audit(
      ctx,
      {
        action: "break_policy.created",
        entityType: "BreakPolicy",
        entityId: row.id,
        after: auditSnapshot(row),
      },
      tx,
    );
    return row;
  });
  return reload(ctx, created.id, now);
}

/**
 * `PATCH /api/break-policies/:id` (policies:write). Partial: the merged rule set is re-validated with
 * `breakPolicyRulesSchema` (e.g. enabled breaks need `maxTotalBreakMinutes ≥ 1`, RELAX_CATEGORIES needs
 * at least one category). Rule changes notify devices; running breaks keep their stored behaviour.
 */
export async function updateBreakPolicy(
  ctx: ManagerContext,
  id: string,
  input: UpdateBreakPolicyInput,
): Promise<BreakPolicy> {
  const now = new Date();
  const organisationId = ctx.organisation.id;
  const row = await loadBreakPolicyOrThrow(organisationId, id);
  assertNotArchived(row);

  const current = rulesOf(row);
  const merged: Record<string, unknown> = { ...current };
  let rulesChanged = false;
  for (const key of RULE_KEYS) {
    if (input[key] !== undefined) {
      merged[key] = input[key];
      rulesChanged = true;
    }
  }
  const parsed = breakPolicyRulesSchema.safeParse(merged);
  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "Invalid body", {
      details: { source: "body", ...z.flattenError(parsed.error) },
    });
  }
  const rules = parsed.data;

  await prisma.$transaction(async (tx) => {
    const data: Prisma.BreakPolicyUncheckedUpdateInput = { updatedAt: now };
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (rulesChanged) Object.assign(data, rulesToData(rules));
    const updated = await tx.breakPolicy.update({ where: { id: row.id }, data });
    await audit(
      ctx,
      {
        action: "break_policy.updated",
        entityType: "BreakPolicy",
        entityId: row.id,
        before: auditSnapshot(row),
        after: auditSnapshot(updated),
      },
      tx,
    );
  });

  if (rulesChanged) {
    publishBreakPolicyChanged({
      organisationId,
      breakPolicyId: row.id,
      reason: "RULES_CHANGED",
      affectedEmployeeIds: await affectedByBreakPolicy(organisationId, row.id, now),
    });
  }
  return reload(ctx, id, now);
}

/** `DELETE /api/break-policies/:id` (policies:write): soft delete; refused while assigned or default. */
export async function deleteBreakPolicy(ctx: ManagerContext, id: string): Promise<void> {
  const now = new Date();
  const row = await loadBreakPolicyOrThrow(ctx.organisation.id, id);
  await assertNotInUse(ctx, row, now);
  await prisma.$transaction(async (tx) => {
    await tx.breakPolicy.update({ where: { id: row.id }, data: { deletedAt: now } });
    await audit(
      ctx,
      {
        action: "break_policy.deleted",
        entityType: "BreakPolicy",
        entityId: row.id,
        before: auditSnapshot(row),
        after: { deletedAt: now.toISOString() },
      },
      tx,
    );
  });
}

// ── Assignments ─────────────────────────────────────────────────────────────

/** `GET /api/break-policies/:id/assignments` (policies:read), newest first. */
export async function listBreakPolicyAssignments(
  ctx: ManagerContext,
  id: string,
): Promise<BreakPolicyAssignment[]> {
  const now = new Date();
  await loadBreakPolicyOrThrow(ctx.organisation.id, id);
  const rows = await findAssignmentsForBreakPolicy(ctx.organisation.id, id);
  const names = await loadScopeNames(ctx.organisation.id, rows);
  return rows.map((row) => toBreakPolicyAssignmentDto(row, names, now));
}

/**
 * `POST /api/break-policies/:id/assignments` (policies:write). Same replace-per-scope semantics as Work
 * Policy assignments; the break policy must not be archived.
 */
export async function createBreakPolicyAssignment(
  ctx: ManagerContext,
  id: string,
  input: CreateBreakPolicyAssignmentInput,
): Promise<BreakPolicyAssignment> {
  const now = new Date();
  const organisationId = ctx.organisation.id;
  const row = await loadBreakPolicyOrThrow(organisationId, id);
  assertNotArchived(row);
  const scope: ScopeRef = { scopeType: input.scopeType, scopeId: input.scopeId };
  await assertScopeTargetExists(organisationId, scope);
  const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : null;
  const effectiveTo = input.effectiveTo ? new Date(input.effectiveTo) : null;
  const replaceAt = effectiveFrom ?? now;

  const created = await prisma.$transaction(async (tx) => {
    const open = await findOpenBreakAssignmentsForScope(organisationId, scope, now, tx);
    for (const previous of open) {
      const endAt =
        previous.effectiveTo && previous.effectiveTo.getTime() < replaceAt.getTime()
          ? previous.effectiveTo
          : replaceAt;
      if (previous.effectiveTo && previous.effectiveTo.getTime() === endAt.getTime()) continue;
      await tx.breakPolicyAssignment.update({
        where: { id: previous.id },
        data: { effectiveTo: endAt },
      });
      await audit(
        ctx,
        {
          action: "break_policy_assignment.ended",
          entityType: "BreakPolicyAssignment",
          entityId: previous.id,
          before: { ...summariseBreakAssignment(previous), breakPolicyId: previous.breakPolicyId },
          after: { effectiveTo: endAt.toISOString(), replacedBy: "new assignment" },
        },
        tx,
      );
    }
    const assignment = await tx.breakPolicyAssignment.create({
      data: {
        organisationId,
        breakPolicyId: row.id,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        effectiveFrom,
        effectiveTo,
        createdById: ctx.user.id,
      },
      include: breakPolicyAssignmentInclude,
    });
    await audit(
      ctx,
      {
        action: "break_policy_assignment.created",
        entityType: "BreakPolicyAssignment",
        entityId: assignment.id,
        after: {
          ...summariseBreakAssignment(assignment),
          breakPolicyId: row.id,
          replacedAssignmentIds: open.map((a) => a.id),
        },
      },
      tx,
    );
    return assignment;
  });

  publishBreakPolicyChanged({
    organisationId,
    breakPolicyId: row.id,
    reason: "ASSIGNED",
    affectedEmployeeIds: await employeeIdsInScope(organisationId, scope),
  });
  const names = await loadScopeNames(organisationId, [scope]);
  return toBreakPolicyAssignmentDto(created, names, now);
}

/** `DELETE /api/break-policy-assignments/:id` (policies:write): ends the assignment now. Idempotent. */
export async function endBreakPolicyAssignment(
  ctx: ManagerContext,
  assignmentId: string,
): Promise<void> {
  const now = new Date();
  const organisationId = ctx.organisation.id;
  const assignment = await findBreakAssignmentById(organisationId, assignmentId);
  if (!assignment) throw new AppError("NOT_FOUND", "Assignment not found");
  if (assignment.effectiveTo && assignment.effectiveTo.getTime() <= now.getTime()) return;

  await prisma.$transaction(async (tx) => {
    await tx.breakPolicyAssignment.update({
      where: { id: assignment.id },
      data: { effectiveTo: now },
    });
    await audit(
      ctx,
      {
        action: "break_policy_assignment.ended",
        entityType: "BreakPolicyAssignment",
        entityId: assignment.id,
        before: { ...summariseBreakAssignment(assignment), breakPolicyId: assignment.breakPolicyId },
        after: { effectiveTo: now.toISOString() },
      },
      tx,
    );
  });
  publishBreakPolicyChanged({
    organisationId,
    breakPolicyId: assignment.breakPolicyId,
    reason: "UNASSIGNED",
    affectedEmployeeIds: await employeeIdsInScope(organisationId, assignment),
  });
}

// ── Organisation default ────────────────────────────────────────────────────

/** `POST /api/organisations/current/default-break-policy` (policies:write); `null` clears it. */
export async function setDefaultBreakPolicy(
  ctx: ManagerContext,
  input: SetDefaultBreakPolicyInput,
): Promise<Organisation> {
  const organisationId = ctx.organisation.id;
  if (input.breakPolicyId !== null) {
    const row = await loadBreakPolicyOrThrow(organisationId, input.breakPolicyId);
    assertNotArchived(row);
  }

  const { before, after } = await prisma.$transaction(async (tx) => {
    const current = await tx.organisation.findUniqueOrThrow({
      where: { id: organisationId },
      select: { defaultBreakPolicyId: true },
    });
    const updated = await tx.organisation.update({
      where: { id: organisationId },
      data: { defaultBreakPolicyId: input.breakPolicyId },
    });
    if (current.defaultBreakPolicyId !== input.breakPolicyId) {
      await audit(
        ctx,
        {
          action: "organisation.default_break_policy_changed",
          entityType: "Organisation",
          entityId: organisationId,
          before: { defaultBreakPolicyId: current.defaultBreakPolicyId },
          after: { defaultBreakPolicyId: input.breakPolicyId },
        },
        tx,
      );
    }
    return { before: current.defaultBreakPolicyId, after: updated };
  });

  if (before !== input.breakPolicyId) {
    publishBreakPolicyChanged({
      organisationId,
      breakPolicyId: input.breakPolicyId,
      reason: "DEFAULT_CHANGED",
      affectedEmployeeIds: await activeEmployeeIds(organisationId),
    });
  }
  return toOrganisationDto(after);
}
