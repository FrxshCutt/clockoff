import type { BreakPolicy as BreakPolicyRow } from "@workmode/db";
import { breakPolicyFromRecord, type BreakPolicyLike } from "@workmode/shared/breaks/breakRules";
import type { AssignmentScopeType, PolicyStatus } from "@workmode/shared/enums";
import { AppError } from "@workmode/shared/errors";
import {
  fromBreakPolicyAssignment,
  indexPoliciesById,
  resolvePolicy,
  resolveWorkPolicy,
  type ResolutionWarning,
  type ResolvedFrom,
} from "@workmode/shared/policy/resolvePolicy";
import type { RestrictionConfig } from "@workmode/shared/policy/restrictionConfig";
import type { BreakBehaviourDefault, ResolvedPolicyRef } from "@workmode/validation/policies";
import { readBreakBehaviourDefault } from "./policies.mappers";
import { loadResolutionInputs, type ResolutionPolicyRow } from "./policies.repository";
import { loadScopeNames, scopeKey, type ScopeRef } from "./scopes";

/**
 * Resolution service (§6.1): loads an employee's context (teams, primary location), every assignment of
 * the organisation and the referenced policies, and delegates the decision to the pure resolver in
 * `@workmode/shared/policy`. Used by the employee endpoints, the mobile sync and the sync job. Nothing
 * here writes: warnings (including `AMBIGUOUS_TEAM_ASSIGNMENT`) are returned for the caller to persist
 * with `resolutionWarningKey` de-duplication (the job's responsibility, not an API request's).
 */

export interface ResolvedPolicyVersionSummary {
  id: string;
  versionNumber: number;
  restrictionConfig: RestrictionConfig;
  breakBehaviourDefault: BreakBehaviourDefault;
  publishedAt: Date;
}

export interface ResolvedWorkPolicySummary {
  id: string;
  name: string;
  status: PolicyStatus;
  /** Null when the policy resolved but has no published, valid version (see `warnings`). */
  currentVersion: ResolvedPolicyVersionSummary | null;
}

/** Where a resolved policy came from, with the scope's display name when known. */
export type PolicyResolvedFrom =
  | {
      via: "ASSIGNMENT";
      scopeType: AssignmentScopeType;
      scopeId: string;
      scopeName: string | null;
      assignmentId: string;
    }
  | { via: "DEFAULT"; scopeType: "ORGANISATION"; scopeId: string; scopeName: string | null };

/** The resolved `BreakPolicy` row plus its rules parsed for `canStartBreak` & co. */
export type ResolvedBreakPolicy = BreakPolicyRow & { rules: BreakPolicyLike };

export interface EmployeePolicyResolution {
  employeeId: string;
  organisationId: string;
  policy: ResolvedWorkPolicySummary | null;
  policyResolvedFrom: PolicyResolvedFrom | null;
  breakPolicy: ResolvedBreakPolicy | null;
  breakPolicyResolvedFrom: PolicyResolvedFrom | null;
  /** Work-policy and break-policy warnings together (see the two subsets for de-duplication keys). */
  warnings: ResolutionWarning[];
  workWarnings: ResolutionWarning[];
  breakWarnings: ResolutionWarning[];
  resolvedAt: Date;
}

function toResolvedFrom(
  from: ResolvedFrom | null,
  names: ReadonlyMap<string, string>,
): PolicyResolvedFrom | null {
  if (from === null) return null;
  const scopeName = names.get(scopeKey(from)) ?? null;
  if (from.via === "DEFAULT") {
    return { via: "DEFAULT", scopeType: "ORGANISATION", scopeId: from.scopeId, scopeName };
  }
  return {
    via: "ASSIGNMENT",
    scopeType: from.scopeType,
    scopeId: from.scopeId,
    scopeName,
    assignmentId: from.assignmentId,
  };
}

function toWorkPolicySummary(
  policy: ResolutionPolicyRow | null,
  version: { versionId: string | null; versionNumber: number | null; publishedAt: Date | null; restrictionConfig: RestrictionConfig | null },
): ResolvedWorkPolicySummary | null {
  if (policy === null) return null;
  const current =
    version.versionId !== null &&
    version.versionNumber !== null &&
    version.publishedAt !== null &&
    version.restrictionConfig !== null &&
    policy.currentVersion
      ? {
          id: version.versionId,
          versionNumber: version.versionNumber,
          restrictionConfig: version.restrictionConfig,
          breakBehaviourDefault: readBreakBehaviourDefault(policy.currentVersion.breakBehaviourDefault),
          publishedAt: version.publishedAt,
        }
      : null;
  return { id: policy.id, name: policy.name, status: policy.status, currentVersion: current };
}

/**
 * Resolve Work Policy and Break Policy for many employees of one organisation with a fixed number of
 * queries (one per assignment table, one per policy table). Employees that do not belong to the
 * organisation are silently absent from the result. Pure resolution per employee, O(assignments) each.
 */
export async function resolveForEmployees(
  organisationId: string,
  employeeIds: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, EmployeePolicyResolution>> {
  const result = new Map<string, EmployeePolicyResolution>();
  if (employeeIds.length === 0) return result;
  const inputs = await loadResolutionInputs(organisationId, employeeIds);
  if (!inputs) return result;

  const policiesById = indexPoliciesById(inputs.policies);
  const breakPoliciesById = indexPoliciesById(inputs.breakPolicies);
  const breakAssignments = inputs.breakPolicyAssignments.map(fromBreakPolicyAssignment);

  interface Raw {
    employeeId: string;
    work: ReturnType<typeof resolveWorkPolicy<ResolutionPolicyRow>>;
    breaks: ReturnType<typeof resolvePolicy<BreakPolicyRow>>;
  }
  const raws: Raw[] = inputs.employees.map((employee) => {
    const context = {
      employeeId: employee.id,
      organisationId,
      teamIds: employee.teams.map((t) => t.teamId),
      primaryLocationId: employee.primaryLocationId,
    };
    return {
      employeeId: employee.id,
      work: resolveWorkPolicy({
        employee: context,
        assignments: inputs.policyAssignments,
        policiesById,
        organisationDefaultPolicyId: inputs.organisation.defaultPolicyId,
        now,
      }),
      breaks: resolvePolicy({
        employee: context,
        assignments: breakAssignments,
        policiesById: breakPoliciesById,
        organisationDefaultPolicyId: inputs.organisation.defaultBreakPolicyId,
        now,
      }),
    };
  });

  const scopes: ScopeRef[] = [];
  for (const raw of raws) {
    if (raw.work.resolvedFrom) scopes.push(raw.work.resolvedFrom);
    if (raw.breaks.resolvedFrom) scopes.push(raw.breaks.resolvedFrom);
  }
  const names = scopes.length ? await loadScopeNames(organisationId, scopes) : new Map<string, string>();

  for (const raw of raws) {
    const breakPolicy = raw.breaks.policy
      ? { ...raw.breaks.policy, rules: breakPolicyFromRecord(raw.breaks.policy) }
      : null;
    result.set(raw.employeeId, {
      employeeId: raw.employeeId,
      organisationId,
      policy: toWorkPolicySummary(raw.work.policy, raw.work.version),
      policyResolvedFrom: toResolvedFrom(raw.work.resolvedFrom, names),
      breakPolicy,
      breakPolicyResolvedFrom: toResolvedFrom(raw.breaks.resolvedFrom, names),
      warnings: [...raw.work.warnings, ...raw.breaks.warnings],
      workWarnings: raw.work.warnings,
      breakWarnings: raw.breaks.warnings,
      resolvedAt: now,
    });
  }
  return result;
}

/**
 * Resolve one employee's Work Policy and Break Policy at `now`. `EMPLOYEE_NOT_FOUND` (404) when the
 * employee is not part of the organisation (a cross-tenant id is indistinguishable from a missing one).
 */
export async function resolveEmployeePolicies(
  organisationId: string,
  employeeId: string,
  now: Date = new Date(),
): Promise<EmployeePolicyResolution> {
  const resolved = (await resolveForEmployees(organisationId, [employeeId], now)).get(employeeId);
  if (!resolved) throw new AppError("EMPLOYEE_NOT_FOUND", "Employee not found");
  return resolved;
}

/**
 * Opaque token a device compares to decide whether to re-download its policy:
 * `<policyId>:<versionNumber>|<breakPolicyId>:<updatedAt ms>`, with `none` for a missing part. An
 * unpublished work policy counts as `none` (nothing is in force until it is published).
 */
export function computePolicyVersionString(
  resolution: Pick<EmployeePolicyResolution, "policy" | "breakPolicy">,
): string {
  const work = resolution.policy?.currentVersion
    ? `${resolution.policy.id}:${resolution.policy.currentVersion.versionNumber}`
    : "none";
  const breaks = resolution.breakPolicy
    ? `${resolution.breakPolicy.id}:${resolution.breakPolicy.updatedAt.getTime()}`
    : "none";
  return `${work}|${breaks}`;
}

/** `{ id, name, resolvedFrom }` refs as embedded in employee DTOs (`resolvedPolicyRefSchema`). */
export function toResolvedPolicyRefs(resolution: EmployeePolicyResolution): {
  policy: ResolvedPolicyRef | null;
  breakPolicy: ResolvedPolicyRef | null;
} {
  const source = (from: PolicyResolvedFrom | null) =>
    from === null ? null : from.via === "DEFAULT" ? ("DEFAULT" as const) : from.scopeType;
  const workSource = source(resolution.policyResolvedFrom);
  const breakSource = source(resolution.breakPolicyResolvedFrom);
  return {
    policy:
      resolution.policy && workSource
        ? { id: resolution.policy.id, name: resolution.policy.name, resolvedFrom: workSource }
        : null,
    breakPolicy:
      resolution.breakPolicy && breakSource
        ? {
            id: resolution.breakPolicy.id,
            name: resolution.breakPolicy.name,
            resolvedFrom: breakSource,
          }
        : null,
  };
}

/** Which policy / break policy each active employee resolves to, as counts per policy id. */
export async function countResolvedEmployees(
  organisationId: string,
  employeeIds: readonly string[],
  now: Date = new Date(),
): Promise<{ byPolicyId: Map<string, number>; byBreakPolicyId: Map<string, number> }> {
  const byPolicyId = new Map<string, number>();
  const byBreakPolicyId = new Map<string, number>();
  const resolutions = await resolveForEmployees(organisationId, employeeIds, now);
  for (const r of resolutions.values()) {
    if (r.policy) byPolicyId.set(r.policy.id, (byPolicyId.get(r.policy.id) ?? 0) + 1);
    if (r.breakPolicy) {
      byBreakPolicyId.set(r.breakPolicy.id, (byBreakPolicyId.get(r.breakPolicy.id) ?? 0) + 1);
    }
  }
  return { byPolicyId, byBreakPolicyId };
}

/** Ids of the employees (from `employeeIds`) whose resolved Work Policy is `policyId`. */
export async function employeesResolvingToPolicy(
  organisationId: string,
  employeeIds: readonly string[],
  policyId: string,
  now: Date = new Date(),
): Promise<string[]> {
  const resolutions = await resolveForEmployees(organisationId, employeeIds, now);
  return [...resolutions.values()].filter((r) => r.policy?.id === policyId).map((r) => r.employeeId);
}

/** Ids of the employees (from `employeeIds`) whose resolved Break Policy is `breakPolicyId`. */
export async function employeesResolvingToBreakPolicy(
  organisationId: string,
  employeeIds: readonly string[],
  breakPolicyId: string,
  now: Date = new Date(),
): Promise<string[]> {
  const resolutions = await resolveForEmployees(organisationId, employeeIds, now);
  return [...resolutions.values()]
    .filter((r) => r.breakPolicy?.id === breakPolicyId)
    .map((r) => r.employeeId);
}
