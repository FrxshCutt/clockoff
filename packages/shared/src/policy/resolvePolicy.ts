/**
 * Policy resolution (§6.1) — pure, deterministic, generic over the kind of policy so the same code
 * serves Work Policies (`Policy`/`PolicyAssignment`) and Break Policies (`BreakPolicy`/
 * `BreakPolicyAssignment`). See docs/POLICY_HIERARCHY.md for the human description.
 *
 * Precedence: EMPLOYEE > TEAM > LOCATION (primary) > ORGANISATION assignment > ORGANISATION default.
 */
import type { AssignmentScopeType, PolicyStatus } from "../enums";
import { resolvePolicyVersion } from "./resolvePolicyVersion";
import type { PolicyVersionSnapshot, VersionedPolicyLike } from "./resolvePolicyVersion";
import type {
  AssignmentCandidateSummary,
  AssignmentLike,
  EmployeeContextLike,
  PolicyLike,
  ResolutionWarning,
  ResolveInput,
  ResolveResult,
  ResolvedFrom,
} from "./types";

export * from "./types";
export * from "./restrictionConfig";
export * from "./resolvePolicyVersion";
export * from "./explainResolution";
export * from "./warnings";

/** Levels in the order they are consulted. Exported so the dashboard can render the hierarchy. */
export const POLICY_SCOPE_PRECEDENCE: readonly AssignmentScopeType[] = Object.freeze([
  "EMPLOYEE",
  "TEAM",
  "LOCATION",
  "ORGANISATION",
] as const);

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`);
}

/**
 * Epoch milliseconds of `date`, or a `RangeError` for an Invalid Date. Every comparison against `NaN` is
 * false, so an Invalid Date would otherwise silently make windows open-ended and the sort order arbitrary.
 * Database rows can never hold one; it is always a caller bug (e.g. `new Date(badString)`).
 */
function epochMs(date: Date, what: string): number {
  const ms = date.getTime();
  if (Number.isNaN(ms)) throw new RangeError(`${what} is an Invalid Date`);
  return ms;
}

/**
 * An assignment counts at `now` when `effectiveFrom <= now` (or unset) and `effectiveTo > now` (or unset).
 * Start is inclusive, end is exclusive, so back-to-back windows never overlap; an empty or inverted window
 * (`effectiveFrom >= effectiveTo`) is never active. Throws `RangeError` if `now` or a bound is an Invalid Date.
 */
export function isAssignmentActive(assignment: AssignmentLike, now: Date): boolean {
  const t = epochMs(now, "`now`");
  const from = assignment.effectiveFrom ?? null;
  const to = assignment.effectiveTo ?? null;
  if (from !== null && epochMs(from, `effectiveFrom of assignment ${assignment.id}`) > t) return false;
  if (to !== null && epochMs(to, `effectiveTo of assignment ${assignment.id}`) <= t) return false;
  return true;
}

/**
 * A policy can be the outcome of resolution unless it is ARCHIVED or soft-deleted. DRAFT policies ARE
 * usable here (they should never be assignable via the API, but if one is, `resolvePolicyVersion` surfaces
 * `POLICY_NOT_PUBLISHED` rather than silently falling through to a weaker scope). A runtime status outside
 * `PolicyStatus` (stale enum mirror, hand-built data) is treated as unusable instead of throwing.
 */
export function isPolicyUsable(policy: PolicyLike): boolean {
  if (policy.deletedAt !== undefined && policy.deletedAt !== null) return false;
  const status: PolicyStatus = policy.status;
  switch (status) {
    case "DRAFT":
    case "ACTIVE":
      return true;
    case "ARCHIVED":
      return false;
    default: {
      // Compile-time exhaustiveness; at runtime fail safe (skip with a warning) rather than throw.
      const _unknownStatus: never = status;
      return false;
    }
  }
}

/**
 * Newest `createdAt` first; equal instants fall back to DESCENDING id (plain UTF-16 string comparison, which
 * for lowercase UUIDs matches Postgres `ORDER BY id DESC`), so the order is total and input-order independent.
 * Throws `RangeError` for an Invalid Date `createdAt`.
 */
export function compareAssignmentsNewestFirst(a: AssignmentLike, b: AssignmentLike): number {
  const dt =
    epochMs(b.createdAt, `createdAt of assignment ${b.id}`) - epochMs(a.createdAt, `createdAt of assignment ${a.id}`);
  if (dt !== 0) return dt;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function scopeIdsForLevel(scopeType: AssignmentScopeType, employee: EmployeeContextLike): ReadonlySet<string> {
  switch (scopeType) {
    case "EMPLOYEE":
      return new Set([employee.employeeId]);
    case "TEAM":
      return new Set(employee.teamIds);
    case "LOCATION":
      return employee.primaryLocationId ? new Set([employee.primaryLocationId]) : new Set();
    case "ORGANISATION":
      return new Set([employee.organisationId]);
    default:
      return assertNever(scopeType);
  }
}

/** Own-property lookup, so ids such as `toString` or `__proto__` never hit `Object.prototype`. */
function lookupPolicy<T>(policiesById: Readonly<Record<string, T>>, id: string): T | undefined {
  return Object.hasOwn(policiesById, id) ? policiesById[id] : undefined;
}

/** First occurrence of each id; a row loaded twice must not look like a duplicate assignment. */
function uniqueById(assignments: readonly AssignmentLike[]): AssignmentLike[] {
  const seen = new Set<string>();
  const out: AssignmentLike[] = [];
  for (const a of assignments) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
  }
  return out;
}

function summarise(a: AssignmentLike): AssignmentCandidateSummary {
  return { assignmentId: a.id, scopeId: a.scopeId, policyId: a.policyId, createdAt: a.createdAt.toISOString() };
}

/** Where a policy reference came from; shared by the warning builders. */
interface ReferenceSource {
  via: ResolvedFrom["via"];
  scopeType: AssignmentScopeType;
  scopeId: string;
  assignmentId: string | null;
}

function describeSource(where: ReferenceSource): string {
  return where.via === "DEFAULT" ? "organisation default" : `${where.scopeType} assignment ${where.assignmentId}`;
}

function inactivePolicyWarning(policy: PolicyLike, where: ReferenceSource): ResolutionWarning {
  const reason = policy.deletedAt ? "soft-deleted" : `status ${String(policy.status)}`;
  return {
    code: "INACTIVE_POLICY_SKIPPED",
    message: `Skipped ${describeSource(where)}: policy ${policy.id} is ${reason}`,
    details: {
      policyId: policy.id,
      status: policy.status,
      deletedAt: policy.deletedAt ? policy.deletedAt.toISOString() : null,
      ...where,
    },
  };
}

function organisationMismatchWarning(
  policyId: string,
  policyOrganisationId: string,
  organisationId: string,
  where: ReferenceSource,
): ResolutionWarning {
  return {
    code: "POLICY_ORGANISATION_MISMATCH",
    message: `Skipped ${describeSource(where)}: policy ${policyId} belongs to organisation ${policyOrganisationId}, not ${organisationId}`,
    details: { policyId, policyOrganisationId, organisationId, ...where },
  };
}

function notLoadedWarning(policyId: string, where: ReferenceSource): ResolutionWarning {
  return {
    code: "POLICY_NOT_LOADED",
    message: `${describeSource(where)} references policy ${policyId}, which was not supplied in policiesById; its status could not be checked`,
    details: { policyId, ...where },
  };
}

/**
 * Why a loaded policy may NOT be the outcome for this employee, as the warning to emit; `null` if it may.
 * Organisation is checked first: a foreign policy is a tenancy problem whatever its status.
 */
function rejectionOf(policy: PolicyLike, organisationId: string, where: ReferenceSource): ResolutionWarning | null {
  if (policy.organisationId !== undefined && policy.organisationId !== organisationId) {
    return organisationMismatchWarning(policy.id, policy.organisationId, organisationId, where);
  }
  if (!isPolicyUsable(policy)) return inactivePolicyWarning(policy, where);
  return null;
}

/**
 * Resolve the single policy that applies to an employee at `now`.
 *
 * Algorithm, per level in `POLICY_SCOPE_PRECEDENCE`:
 *  1. candidates = active assignments of that scope type whose scopeId applies to the employee, newest
 *     first (`compareAssignmentsNewestFirst`);
 *  2. drop candidates whose policy is archived/soft-deleted (`INACTIVE_POLICY_SKIPPED`) or owned by another
 *     organisation (`POLICY_ORGANISATION_MISMATCH`);
 *  3. if none remain, fall through to the next level;
 *  4. otherwise the first (newest) candidate wins. Several candidates for one scope produce
 *     `DUPLICATE_SCOPE_ASSIGNMENT`; several TEAMS whose own winners point at different policies produce
 *     `AMBIGUOUS_TEAM_ASSIGNMENT`.
 * After all levels, `organisationDefaultPolicyId` is used (an ORGANISATION-scope assignment row therefore
 * beats the organisation default). Nothing usable → `{ policy: null, policyId: null, resolvedFrom: null }`.
 *
 * Never throws for data problems; every anomaly is a warning the caller should log. The one exception is a
 * caller bug that cannot come from the database: an Invalid Date in `now`, in any assignment's
 * `createdAt`/`effectiveFrom`/`effectiveTo` or in any supplied policy's `deletedAt` throws `RangeError`
 * (checked for every row, so whether it throws never depends on which levels happen to be reached).
 */
export function resolvePolicy<T extends PolicyLike>(input: ResolveInput<T>): ResolveResult<T> {
  const now = input.now ?? new Date();
  epochMs(now, "resolvePolicy: `now`");
  const warnings: ResolutionWarning[] = [];
  const { employee, policiesById } = input;
  const assignments = uniqueById(input.assignments);
  for (const a of assignments) epochMs(a.createdAt, `createdAt of assignment ${a.id}`);
  for (const p of Object.values(policiesById)) {
    if (p.deletedAt !== undefined && p.deletedAt !== null) epochMs(p.deletedAt, `deletedAt of policy ${p.id}`);
  }
  const active = assignments.filter((a) => isAssignmentActive(a, now));

  for (const scopeType of POLICY_SCOPE_PRECEDENCE) {
    const applicable = scopeIdsForLevel(scopeType, employee);
    if (applicable.size === 0) continue;

    const candidates = active
      .filter((a) => a.scopeType === scopeType && applicable.has(a.scopeId))
      .sort(compareAssignmentsNewestFirst);
    if (candidates.length === 0) continue;

    const usable: AssignmentLike[] = [];
    for (const candidate of candidates) {
      const policy = lookupPolicy(policiesById, candidate.policyId);
      if (policy !== undefined) {
        const rejection = rejectionOf(policy, employee.organisationId, {
          via: "ASSIGNMENT",
          scopeType,
          scopeId: candidate.scopeId,
          assignmentId: candidate.id,
        });
        if (rejection !== null) {
          warnings.push(rejection);
          continue;
        }
      }
      // Not-loaded policies stay in the running: precedence must not be silently weakened by a caller bug.
      usable.push(candidate);
    }
    if (usable.length === 0) continue;

    const winner = usable[0]!;

    const byScope = new Map<string, AssignmentLike[]>();
    for (const a of usable) {
      const list = byScope.get(a.scopeId);
      if (list) list.push(a);
      else byScope.set(a.scopeId, [a]);
    }
    for (const [scopeId, group] of byScope) {
      if (group.length > 1) {
        warnings.push({
          code: "DUPLICATE_SCOPE_ASSIGNMENT",
          message: `${group.length} active ${scopeType} assignments for scope ${scopeId}; using the most recently created (${group[0]!.id})`,
          details: {
            scopeType,
            scopeId,
            assignmentIds: group.map((a) => a.id),
            winnerAssignmentId: group[0]!.id,
          },
        });
      }
    }

    if (scopeType === "TEAM" && byScope.size > 1) {
      // Compare each team's OWN winner (its newest usable assignment). Stale duplicate rows inside one
      // team are already reported as DUPLICATE_SCOPE_ASSIGNMENT and must not manufacture ambiguity.
      // Map insertion order follows `usable`, so `teamWinners` is newest-first and starts with `winner`.
      const teamWinners = [...byScope.values()].map((group) => group[0]!);
      const distinctPolicies = new Set(teamWinners.map((a) => a.policyId));
      if (distinctPolicies.size > 1) {
        warnings.push({
          code: "AMBIGUOUS_TEAM_ASSIGNMENT",
          message: `Employee ${employee.employeeId} is in ${byScope.size} teams with different policies; using the most recently created assignment (${winner.id}, team ${winner.scopeId})`,
          details: {
            scopeType: "TEAM",
            candidates: teamWinners.map(summarise),
            winnerAssignmentId: winner.id,
          },
        });
      }
    }

    const resolvedFrom: ResolvedFrom = {
      via: "ASSIGNMENT",
      scopeType,
      scopeId: winner.scopeId,
      assignmentId: winner.id,
    };
    const policy = lookupPolicy(policiesById, winner.policyId);
    if (policy === undefined) {
      warnings.push(
        notLoadedWarning(winner.policyId, {
          via: "ASSIGNMENT",
          scopeType,
          scopeId: winner.scopeId,
          assignmentId: winner.id,
        }),
      );
      return { policy: null, policyId: winner.policyId, resolvedFrom, warnings };
    }
    return { policy, policyId: winner.policyId, resolvedFrom, warnings };
  }

  const defaultId = input.organisationDefaultPolicyId ?? null;
  if (defaultId === null) {
    return { policy: null, policyId: null, resolvedFrom: null, warnings };
  }
  const where: ReferenceSource = {
    via: "DEFAULT",
    scopeType: "ORGANISATION",
    scopeId: employee.organisationId,
    assignmentId: null,
  };
  const resolvedFrom: ResolvedFrom = { via: "DEFAULT", scopeType: "ORGANISATION", scopeId: employee.organisationId };
  const policy = lookupPolicy(policiesById, defaultId);
  if (policy === undefined) {
    warnings.push(notLoadedWarning(defaultId, where));
    return { policy: null, policyId: defaultId, resolvedFrom, warnings };
  }
  const rejection = rejectionOf(policy, employee.organisationId, where);
  if (rejection !== null) {
    warnings.push(rejection);
    return { policy: null, policyId: null, resolvedFrom: null, warnings };
  }
  return { policy, policyId: defaultId, resolvedFrom, warnings };
}

/**
 * Builds the `policiesById` map from any array of rows with an `id` (last duplicate wins). Keys are defined
 * as own data properties, so even an id of `__proto__` is stored as a key rather than replacing the
 * prototype; the result is still a plain object (safe to pass to React Server Components).
 */
export function indexPoliciesById<T extends { id: string }>(policies: readonly T[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const p of policies) {
    Object.defineProperty(out, p.id, { value: p, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** Shape of a `BreakPolicyAssignment` row — the only field that differs from `AssignmentLike`. */
export interface BreakPolicyAssignmentLike extends Omit<AssignmentLike, "policyId"> {
  breakPolicyId: string;
}

/** Adapts a `BreakPolicyAssignment` row so `resolvePolicy` can resolve break policies. */
export function fromBreakPolicyAssignment(row: BreakPolicyAssignmentLike): AssignmentLike {
  return {
    id: row.id,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    policyId: row.breakPolicyId,
    effectiveFrom: row.effectiveFrom ?? null,
    effectiveTo: row.effectiveTo ?? null,
    createdAt: row.createdAt,
  };
}

export interface ResolvedWorkPolicy<T extends VersionedPolicyLike> extends ResolveResult<T> {
  /** Published-version snapshot of `policy` (all-null when nothing resolved or nothing is published). */
  version: PolicyVersionSnapshot;
}

/**
 * Convenience composition for Work Policies: `resolvePolicy` followed by `resolvePolicyVersion`, with the
 * warnings of both merged into `warnings`. Break policies carry their rules on the row itself and have no
 * versions, so they use `resolvePolicy` directly.
 */
export function resolveWorkPolicy<T extends VersionedPolicyLike>(input: ResolveInput<T>): ResolvedWorkPolicy<T> {
  const resolution = resolvePolicy(input);
  const { warnings: versionWarnings, ...version } = resolvePolicyVersion(resolution.policy);
  return {
    ...resolution,
    version,
    warnings: [...resolution.warnings, ...versionWarnings],
  };
}
