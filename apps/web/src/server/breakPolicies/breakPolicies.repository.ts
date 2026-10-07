import { prisma, type Prisma } from "@clockoff/db";
import type { PolicyStatus } from "@clockoff/shared/enums";
import type { ScopeRef } from "@/server/policies/scopes";

/** Break Policy queries, every one scoped by the caller's verified `organisationId`. */

type Db = Prisma.TransactionClient | typeof prisma;

export type BreakPolicyRow = Prisma.BreakPolicyGetPayload<object>;

export interface BreakPolicyListFilter {
  status?: readonly PolicyStatus[];
  search?: string;
  includeArchived?: boolean;
}

export async function findBreakPolicies(
  organisationId: string,
  filter: BreakPolicyListFilter = {},
  db: Db = prisma,
): Promise<BreakPolicyRow[]> {
  const where: Prisma.BreakPolicyWhereInput = { organisationId, deletedAt: null };
  if (filter.status && filter.status.length > 0) where.status = { in: [...filter.status] };
  else if (!filter.includeArchived) where.status = { not: "ARCHIVED" };
  if (filter.search) where.name = { contains: filter.search, mode: "insensitive" };
  return db.breakPolicy.findMany({ where, orderBy: [{ name: "asc" }, { createdAt: "asc" }] });
}

export async function findBreakPolicyById(
  organisationId: string,
  id: string,
  db: Db = prisma,
): Promise<BreakPolicyRow | null> {
  return db.breakPolicy.findFirst({ where: { id, organisationId, deletedAt: null } });
}

// ── Assignments ─────────────────────────────────────────────────────────────

export const breakPolicyAssignmentInclude = {
  breakPolicy: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.BreakPolicyAssignmentInclude;
export type BreakPolicyAssignmentRow = Prisma.BreakPolicyAssignmentGetPayload<{
  include: typeof breakPolicyAssignmentInclude;
}>;

export function openBreakAssignmentWhere(now: Date): Prisma.BreakPolicyAssignmentWhereInput {
  return { OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] };
}

export async function findAssignmentsForBreakPolicy(
  organisationId: string,
  breakPolicyId: string,
  db: Db = prisma,
): Promise<BreakPolicyAssignmentRow[]> {
  return db.breakPolicyAssignment.findMany({
    where: { organisationId, breakPolicyId },
    include: breakPolicyAssignmentInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

export async function findOpenAssignmentsForBreakPolicy(
  organisationId: string,
  breakPolicyId: string,
  now: Date,
  db: Db = prisma,
): Promise<BreakPolicyAssignmentRow[]> {
  return db.breakPolicyAssignment.findMany({
    where: { organisationId, breakPolicyId, ...openBreakAssignmentWhere(now) },
    include: breakPolicyAssignmentInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

export async function findBreakAssignmentById(
  organisationId: string,
  id: string,
  db: Db = prisma,
): Promise<BreakPolicyAssignmentRow | null> {
  return db.breakPolicyAssignment.findFirst({
    where: { id, organisationId },
    include: breakPolicyAssignmentInclude,
  });
}

export async function findOpenBreakAssignmentsForScope(
  organisationId: string,
  scope: ScopeRef,
  now: Date,
  db: Db = prisma,
): Promise<BreakPolicyAssignmentRow[]> {
  return db.breakPolicyAssignment.findMany({
    where: {
      organisationId,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      ...openBreakAssignmentWhere(now),
    },
    include: breakPolicyAssignmentInclude,
  });
}

export async function countOpenAssignmentsByBreakPolicy(
  organisationId: string,
  breakPolicyIds: readonly string[],
  now: Date,
  db: Db = prisma,
): Promise<Map<string, number>> {
  if (breakPolicyIds.length === 0) return new Map();
  const groups = await db.breakPolicyAssignment.groupBy({
    by: ["breakPolicyId"],
    where: {
      organisationId,
      breakPolicyId: { in: [...breakPolicyIds] },
      ...openBreakAssignmentWhere(now),
    },
    _count: { _all: true },
  });
  return new Map(groups.map((g) => [g.breakPolicyId, g._count._all]));
}
