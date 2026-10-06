import { prisma } from "@workmode/db";
import type { BreakPolicyLike } from "@workmode/shared/breaks/breakRules";
import { AppError } from "@workmode/shared/errors";
import type { ResolutionWarning } from "@workmode/shared/policy/resolvePolicy";
import type { ResolvedPolicyRef } from "@workmode/validation/policies";
import type { NamedRef } from "@workmode/validation/refs";
import { logger } from "@/lib/logger";
import { resolveForEmployees, toResolvedPolicyRefs } from "@/server/policies";
import {
  findBreakPolicyInOrganisation,
  findEmployeeLevelAssignments,
  findPolicyInOrganisation,
  type BreakPolicyRow,
  type Db,
  type PolicyRow,
} from "./employees.repository";

/**
 * Policy data for a page of employees (§6.1). Resolution is delegated to the policies service
 * (`resolveForEmployees`, the batch form of `resolveEmployeePolicies`), which loads one organisation's
 * assignments and policies in a fixed number of queries and runs the pure resolver from
 * `@workmode/shared/policy`. This module adds the one thing the employee DTO needs on top: which
 * EMPLOYEE-scope override (if any) a manager set, independent of whether it currently wins.
 */

export interface ResolvedEmployeePolicies {
  /** The Work Policy that actually applies and the scope it came from; null when nothing resolves. */
  resolvedPolicy: ResolvedPolicyRef | null;
  resolvedBreakPolicy: ResolvedPolicyRef | null;
  /** Parsed rules of the resolved Break Policy (for allowances); null when none resolves. */
  breakPolicyRules: BreakPolicyLike | null;
  /** The live EMPLOYEE-scope assignment's policy, when one exists (whatever its status). */
  policyOverride: NamedRef | null;
  breakPolicyOverride: NamedRef | null;
  warnings: ResolutionWarning[];
}

const EMPTY: ResolvedEmployeePolicies = {
  resolvedPolicy: null,
  resolvedBreakPolicy: null,
  breakPolicyRules: null,
  policyOverride: null,
  breakPolicyOverride: null,
  warnings: [],
};

export async function resolvePoliciesForEmployees(
  organisationId: string,
  employeeIds: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, ResolvedEmployeePolicies>> {
  const result = new Map<string, ResolvedEmployeePolicies>();
  if (employeeIds.length === 0) return result;
  const [resolutions, overrides] = await Promise.all([
    resolveForEmployees(organisationId, employeeIds, now),
    findEmployeeLevelAssignments(organisationId, employeeIds, now),
  ]);
  for (const employeeId of employeeIds) {
    const resolution = resolutions.get(employeeId);
    const override = overrides.get(employeeId);
    if (!resolution) {
      result.set(employeeId, {
        ...EMPTY,
        policyOverride: override?.policy ?? null,
        breakPolicyOverride: override?.breakPolicy ?? null,
      });
      continue;
    }
    if (resolution.warnings.length > 0) {
      logger.debug(
        { organisationId, employeeId, codes: resolution.warnings.map((w) => w.code) },
        "policy resolution warnings",
      );
    }
    const refs = toResolvedPolicyRefs(resolution);
    result.set(employeeId, {
      resolvedPolicy: refs.policy,
      resolvedBreakPolicy: refs.breakPolicy,
      breakPolicyRules: resolution.breakPolicy?.rules ?? null,
      policyOverride: override?.policy ?? null,
      breakPolicyOverride: override?.breakPolicy ?? null,
      warnings: resolution.warnings,
    });
  }
  return result;
}

/**
 * A Work Policy a manager may assign to an employee: in this organisation (else a field-level
 * VALIDATION_ERROR), not archived or deleted (POLICY_ARCHIVED) and published (POLICY_NOT_PUBLISHED —
 * assigning a draft would silently leave the employee with no restrictions).
 */
export async function assertAssignablePolicy(
  organisationId: string,
  policyId: string,
  db: Db = prisma,
): Promise<PolicyRow> {
  const policy = await findPolicyInOrganisation(organisationId, policyId, db);
  if (!policy) {
    throw new AppError("VALIDATION_ERROR", "Unknown Work Policy", {
      details: {
        source: "body",
        formErrors: [],
        fieldErrors: { policyId: ["Unknown Work Policy"] },
      },
    });
  }
  if (policy.deletedAt || policy.status === "ARCHIVED") {
    throw new AppError("POLICY_ARCHIVED", "This Work Policy is archived and cannot be assigned", {
      details: { policyId },
    });
  }
  if (policy.status === "DRAFT" || !policy.currentVersion?.publishedAt) {
    throw new AppError("POLICY_NOT_PUBLISHED", "Publish this Work Policy before assigning it", {
      details: { policyId },
    });
  }
  return policy;
}

export async function assertAssignableBreakPolicy(
  organisationId: string,
  breakPolicyId: string,
  db: Db = prisma,
): Promise<BreakPolicyRow> {
  const policy = await findBreakPolicyInOrganisation(organisationId, breakPolicyId, db);
  if (!policy) {
    throw new AppError("VALIDATION_ERROR", "Unknown Break Policy", {
      details: {
        source: "body",
        formErrors: [],
        fieldErrors: { breakPolicyId: ["Unknown Break Policy"] },
      },
    });
  }
  if (policy.deletedAt || policy.status === "ARCHIVED") {
    throw new AppError("POLICY_ARCHIVED", "This Break Policy is archived and cannot be assigned", {
      details: { breakPolicyId },
    });
  }
  return policy;
}
