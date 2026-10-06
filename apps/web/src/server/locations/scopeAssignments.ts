import { prisma, type Prisma } from "@workmode/db";
import type { AssignmentScopeType } from "@workmode/shared/enums";
import type { ScopeAssignment } from "@workmode/validation/locationsTeams";

/**
 * The Work Policy / Break Policy assignment currently in force for LOCATION and TEAM scopes, so the
 * Locations & Teams screens can show "Policy: Front of house" next to each row without a request per row.
 * "In force" follows the shared resolver: `effectiveFrom <= now` (or null) and `effectiveTo > now` (or
 * null); assignments to soft-deleted policies are ignored. One query per assignment table for any number
 * of scopes.
 */

type Db = Prisma.TransactionClient | typeof prisma;

export interface ScopeAssignments {
  policy: ScopeAssignment | null;
  breakPolicy: ScopeAssignment | null;
}

export interface GetActiveAssignmentsOptions {
  now?: Date;
  db?: Db;
}

function openWindowWhere(now: Date) {
  return {
    AND: [
      { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: now } }] },
      { OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
    ],
  };
}

interface AssignmentLike {
  id: string;
  scopeId: string;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  createdAt: Date;
}

function toScopeAssignment(
  row: AssignmentLike,
  policy: { id: string; name: string },
): ScopeAssignment {
  return {
    id: row.id,
    policy: { id: policy.id, name: policy.name },
    effectiveFrom: row.effectiveFrom?.toISOString() ?? null,
    effectiveTo: row.effectiveTo?.toISOString() ?? null,
  };
}

/**
 * Active assignments per scope id (ids without any are absent from the map). When several rows are open
 * for one scope (not expected: a partial unique index allows one open row per scope) the newest wins.
 */
export async function getActiveAssignmentsForScope(
  organisationId: string,
  scopeType: AssignmentScopeType,
  scopeIds: readonly string[],
  options: GetActiveAssignmentsOptions = {},
): Promise<Map<string, ScopeAssignments>> {
  const result = new Map<string, ScopeAssignments>();
  if (scopeIds.length === 0) return result;
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const where = {
    organisationId,
    scopeType,
    scopeId: { in: [...scopeIds] },
    ...openWindowWhere(now),
  };

  const [policyRows, breakRows] = await Promise.all([
    db.policyAssignment.findMany({
      where: { ...where, policy: { deletedAt: null } },
      include: { policy: { select: { id: true, name: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
    db.breakPolicyAssignment.findMany({
      where: { ...where, breakPolicy: { deletedAt: null } },
      include: { breakPolicy: { select: { id: true, name: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
  ]);

  const entry = (scopeId: string): ScopeAssignments => {
    let current = result.get(scopeId);
    if (!current) {
      current = { policy: null, breakPolicy: null };
      result.set(scopeId, current);
    }
    return current;
  };
  for (const row of policyRows) {
    const target = entry(row.scopeId);
    if (!target.policy) target.policy = toScopeAssignment(row, row.policy);
  }
  for (const row of breakRows) {
    const target = entry(row.scopeId);
    if (!target.breakPolicy) target.breakPolicy = toScopeAssignment(row, row.breakPolicy);
  }
  return result;
}

export interface EndedScopeAssignments {
  /** Work Policy ids whose assignment to the scope was ended. */
  policyIds: string[];
  /** Break Policy ids whose assignment to the scope was ended. */
  breakPolicyIds: string[];
}

/**
 * End (effectiveTo = now) every open assignment to a scope that is being deleted, so no assignment keeps
 * pointing at a location or team that no longer exists. Returns the affected policy ids so the caller can
 * publish the matching `POLICY_CHANGED` / `BREAK_POLICY_CHANGED` events after commit.
 */
export async function endAssignmentsForScope(
  tx: Prisma.TransactionClient,
  organisationId: string,
  scopeType: AssignmentScopeType,
  scopeId: string,
  now: Date,
): Promise<EndedScopeAssignments> {
  const openWhere = {
    organisationId,
    scopeType,
    scopeId,
    OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
  };
  const [policyRows, breakRows] = await Promise.all([
    tx.policyAssignment.findMany({ where: openWhere, select: { id: true, policyId: true } }),
    tx.breakPolicyAssignment.findMany({
      where: openWhere,
      select: { id: true, breakPolicyId: true },
    }),
  ]);
  if (policyRows.length > 0) {
    await tx.policyAssignment.updateMany({
      where: { id: { in: policyRows.map((r) => r.id) } },
      data: { effectiveTo: now },
    });
  }
  if (breakRows.length > 0) {
    await tx.breakPolicyAssignment.updateMany({
      where: { id: { in: breakRows.map((r) => r.id) } },
      data: { effectiveTo: now },
    });
  }
  return {
    policyIds: [...new Set(policyRows.map((r) => r.policyId))],
    breakPolicyIds: [...new Set(breakRows.map((r) => r.breakPolicyId))],
  };
}
