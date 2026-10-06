import type { Prisma } from "@workmode/db";
import type { RestrictionConfig } from "@workmode/shared/policy/restrictionConfig";
import {
  BREAK_BEHAVIOUR_DEFAULT,
  breakBehaviourDefaultSchema,
  restrictionConfigSchema,
  type BreakBehaviourDefault,
  type Policy,
  type PolicyAssignment,
  type PolicyVersion,
} from "@workmode/validation/policies";
import type { PolicyAssignmentRow, PolicyRow, PolicyVersionRow } from "./policies.repository";
import { isWindowActive, scopeKey } from "./scopes";

/** Row → API DTO mappers (instants as UTC ISO strings, JSON columns normalised). */

/**
 * `PolicyVersion.restrictionConfig` is only ever written through `restrictionConfigSchema`, so a row that
 * fails it is a data-integrity bug: surface it as a 500 (with the version id in the error) rather than
 * ship a half-valid config to devices.
 */
export function readRestrictionConfig(
  value: Prisma.JsonValue,
  versionId: string,
): RestrictionConfig {
  const parsed = restrictionConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`PolicyVersion ${versionId} has an invalid restrictionConfig`);
  }
  return parsed.data;
}

/** Lenient: the column has a database default, so an unreadable value falls back to it. */
export function readBreakBehaviourDefault(value: Prisma.JsonValue): BreakBehaviourDefault {
  const parsed = breakBehaviourDefaultSchema.safeParse(value);
  return parsed.success ? parsed.data : { ...BREAK_BEHAVIOUR_DEFAULT, relaxedCategories: [] };
}

export function toPolicyVersionDto(row: PolicyVersionRow): PolicyVersion {
  return {
    id: row.id,
    policyId: row.policyId,
    versionNumber: row.versionNumber,
    restrictionConfig: readRestrictionConfig(row.restrictionConfig, row.id),
    breakBehaviourDefault: readBreakBehaviourDefault(row.breakBehaviourDefault),
    changeNote: row.changeNote,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.name } : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface PolicyDtoExtras {
  isDefault: boolean;
  assignmentCount: number;
  assignedEmployeeCount: number;
}

export function toPolicyDto(row: PolicyRow, extras: PolicyDtoExtras): Policy {
  // A version counts as published only with `publishedAt` set (the resolver applies the same rule).
  const current = row.currentVersion && row.currentVersion.publishedAt ? row.currentVersion : null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    currentVersion: current ? toPolicyVersionDto(current) : null,
    draftVersion: row.draftVersion ? toPolicyVersionDto(row.draftVersion) : null,
    isDefault: extras.isDefault,
    assignmentCount: extras.assignmentCount,
    assignedEmployeeCount: extras.assignedEmployeeCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toPolicyAssignmentDto(
  row: PolicyAssignmentRow,
  scopeNames: ReadonlyMap<string, string>,
  now: Date,
): PolicyAssignment {
  const name =
    row.scopeType === "ORGANISATION"
      ? null
      : (scopeNames.get(scopeKey({ scopeType: row.scopeType, scopeId: row.scopeId })) ?? null);
  return {
    id: row.id,
    policy: { id: row.policy.id, name: row.policy.name },
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    scope: name === null ? null : { id: row.scopeId, name },
    effectiveFrom: row.effectiveFrom?.toISOString() ?? null,
    effectiveTo: row.effectiveTo?.toISOString() ?? null,
    isActive: isWindowActive(row, now),
    createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.name } : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Compact, PII-free snapshot of an assignment for audit entries and `POLICY_ASSIGNED` error details. */
export function summariseAssignment(
  row: PolicyAssignmentRow,
  scopeNames?: ReadonlyMap<string, string>,
) {
  return {
    id: row.id,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    scopeName:
      scopeNames?.get(scopeKey({ scopeType: row.scopeType, scopeId: row.scopeId })) ?? null,
    effectiveFrom: row.effectiveFrom?.toISOString() ?? null,
    effectiveTo: row.effectiveTo?.toISOString() ?? null,
  };
}
