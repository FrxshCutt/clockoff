import { prisma, type Prisma } from "@workmode/db";
import type { PolicyStatus } from "@workmode/shared/enums";
import type { ScopeRef } from "./scopes";

/**
 * Work Policy queries. Every function takes the `organisationId` explicitly (from the caller's verified
 * membership) and filters on it, so a row of another tenant can never be returned.
 */

type Db = Prisma.TransactionClient | typeof prisma;

export const userRefSelect = { id: true, name: true } as const;

export const policyVersionInclude = {
  createdBy: { select: userRefSelect },
} satisfies Prisma.PolicyVersionInclude;
export type PolicyVersionRow = Prisma.PolicyVersionGetPayload<{
  include: typeof policyVersionInclude;
}>;

/**
 * A policy with its published `currentVersion` and the newest unpublished version (at most one exists:
 * PATCH edits it in place, publish promotes it). Prisma cannot alias relations, so the filtered
 * `versions` include is renamed to `draftVersion` by `withDraft`.
 */
const policyPrismaInclude = {
  currentVersion: { include: policyVersionInclude },
  versions: {
    where: { publishedAt: null },
    orderBy: { versionNumber: "desc" as const },
    take: 1,
    include: policyVersionInclude,
  },
} satisfies Prisma.PolicyInclude;
type PolicyPrismaRow = Prisma.PolicyGetPayload<{ include: typeof policyPrismaInclude }>;
export type PolicyRow = Omit<PolicyPrismaRow, "versions"> & { draftVersion: PolicyVersionRow | null };

function withDraft(row: PolicyPrismaRow): PolicyRow {
  const { versions, ...rest } = row;
  return { ...rest, draftVersion: versions[0] ?? null };
}

export interface PolicyListFilter {
  status?: readonly PolicyStatus[];
  search?: string;
  includeArchived?: boolean;
}

export async function findPolicies(
  organisationId: string,
  filter: PolicyListFilter = {},
  db: Db = prisma,
): Promise<PolicyRow[]> {
  const where: Prisma.PolicyWhereInput = { organisationId, deletedAt: null };
  if (filter.status && filter.status.length > 0) where.status = { in: [...filter.status] };
  else if (!filter.includeArchived) where.status = { not: "ARCHIVED" };
  if (filter.search) where.name = { contains: filter.search, mode: "insensitive" };
  const rows = await db.policy.findMany({
    where,
    include: policyPrismaInclude,
    orderBy: [{ name: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(withDraft);
}

export async function findPolicyById(
  organisationId: string,
  id: string,
  db: Db = prisma,
): Promise<PolicyRow | null> {
  const row = await db.policy.findFirst({
    where: { id, organisationId, deletedAt: null },
    include: policyPrismaInclude,
  });
  return row ? withDraft(row) : null;
}

export async function findPolicyVersions(
  organisationId: string,
  policyId: string,
  db: Db = prisma,
): Promise<PolicyVersionRow[]> {
  return db.policyVersion.findMany({
    where: { policyId, policy: { organisationId } },
    include: policyVersionInclude,
    orderBy: { versionNumber: "desc" },
  });
}

export async function nextVersionNumber(policyId: string, db: Db = prisma): Promise<number> {
  const agg = await db.policyVersion.aggregate({
    where: { policyId },
    _max: { versionNumber: true },
  });
  return (agg._max.versionNumber ?? 0) + 1;
}

// ── Assignments ─────────────────────────────────────────────────────────────

export const policyAssignmentInclude = {
  policy: { select: { id: true, name: true } },
  createdBy: { select: userRefSelect },
} satisfies Prisma.PolicyAssignmentInclude;
export type PolicyAssignmentRow = Prisma.PolicyAssignmentGetPayload<{
  include: typeof policyAssignmentInclude;
}>;

/** Not yet ended at `now`: open-ended or ending in the future (includes scheduled future windows). */
export function openAssignmentWhere(now: Date): Prisma.PolicyAssignmentWhereInput {
  return { OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] };
}

export async function findAssignmentsForPolicy(
  organisationId: string,
  policyId: string,
  db: Db = prisma,
): Promise<PolicyAssignmentRow[]> {
  return db.policyAssignment.findMany({
    where: { organisationId, policyId },
    include: policyAssignmentInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

export async function findOpenAssignmentsForPolicy(
  organisationId: string,
  policyId: string,
  now: Date,
  db: Db = prisma,
): Promise<PolicyAssignmentRow[]> {
  return db.policyAssignment.findMany({
    where: { organisationId, policyId, ...openAssignmentWhere(now) },
    include: policyAssignmentInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

export async function findAssignmentById(
  organisationId: string,
  id: string,
  db: Db = prisma,
): Promise<PolicyAssignmentRow | null> {
  return db.policyAssignment.findFirst({
    where: { id, organisationId },
    include: policyAssignmentInclude,
  });
}

export async function findOpenAssignmentsForScope(
  organisationId: string,
  scope: ScopeRef,
  now: Date,
  db: Db = prisma,
): Promise<PolicyAssignmentRow[]> {
  return db.policyAssignment.findMany({
    where: {
      organisationId,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      ...openAssignmentWhere(now),
    },
    include: policyAssignmentInclude,
  });
}

/** Open assignments per policy id (policies without any are absent from the map). */
export async function countOpenAssignmentsByPolicy(
  organisationId: string,
  policyIds: readonly string[],
  now: Date,
  db: Db = prisma,
): Promise<Map<string, number>> {
  if (policyIds.length === 0) return new Map();
  const groups = await db.policyAssignment.groupBy({
    by: ["policyId"],
    where: { organisationId, policyId: { in: [...policyIds] }, ...openAssignmentWhere(now) },
    _count: { _all: true },
  });
  return new Map(groups.map((g) => [g.policyId, g._count._all]));
}

// ── Resolution inputs ───────────────────────────────────────────────────────

export const resolutionPolicyInclude = { currentVersion: true } satisfies Prisma.PolicyInclude;
export type ResolutionPolicyRow = Prisma.PolicyGetPayload<{
  include: typeof resolutionPolicyInclude;
}>;

export interface ResolutionInputs {
  organisation: { id: string; name: string; defaultPolicyId: string | null; defaultBreakPolicyId: string | null };
  employees: Array<{
    id: string;
    primaryLocationId: string | null;
    teams: Array<{ teamId: string }>;
  }>;
  policyAssignments: Prisma.PolicyAssignmentGetPayload<object>[];
  breakPolicyAssignments: Prisma.BreakPolicyAssignmentGetPayload<object>[];
  policies: ResolutionPolicyRow[];
  breakPolicies: Prisma.BreakPolicyGetPayload<object>[];
}

/**
 * Everything the shared resolver needs for a set of employees, loaded in a fixed number of queries:
 * EVERY assignment of the organisation (any scope, any window — the resolver picks) and every referenced
 * policy regardless of status / soft-deletion / organisation (so unusable ones are skipped with a warning
 * instead of silently falling through). Policies carry `currentVersion`, as `resolvePolicyVersion` requires.
 */
export async function loadResolutionInputs(
  organisationId: string,
  employeeIds: readonly string[],
  db: Db = prisma,
): Promise<ResolutionInputs | null> {
  const [organisation, employees, policyAssignments, breakPolicyAssignments] = await Promise.all([
    db.organisation.findUnique({
      where: { id: organisationId },
      select: { id: true, name: true, defaultPolicyId: true, defaultBreakPolicyId: true },
    }),
    employeeIds.length
      ? db.employee.findMany({
          where: { id: { in: [...employeeIds] }, organisationId },
          select: { id: true, primaryLocationId: true, teams: { select: { teamId: true } } },
        })
      : [],
    db.policyAssignment.findMany({ where: { organisationId } }),
    db.breakPolicyAssignment.findMany({ where: { organisationId } }),
  ]);
  if (!organisation) return null;

  const policyIds = new Set(policyAssignments.map((a) => a.policyId));
  if (organisation.defaultPolicyId) policyIds.add(organisation.defaultPolicyId);
  const breakPolicyIds = new Set(breakPolicyAssignments.map((a) => a.breakPolicyId));
  if (organisation.defaultBreakPolicyId) breakPolicyIds.add(organisation.defaultBreakPolicyId);

  const [policies, breakPolicies] = await Promise.all([
    policyIds.size
      ? db.policy.findMany({
          where: { id: { in: [...policyIds] } },
          include: resolutionPolicyInclude,
        })
      : [],
    breakPolicyIds.size ? db.breakPolicy.findMany({ where: { id: { in: [...breakPolicyIds] } } }) : [],
  ]);

  return { organisation, employees, policyAssignments, breakPolicyAssignments, policies, breakPolicies };
}
