import { parseRelaxedCategories } from "@workmode/shared/breaks/breakRules";
import type {
  BreakPolicy,
  BreakPolicyAssignment,
  BreakPolicyRules,
} from "@workmode/validation/breakPolicies";
import { isWindowActive, scopeKey } from "@/server/policies/scopes";
import type { BreakPolicyAssignmentRow, BreakPolicyRow } from "./breakPolicies.repository";

/** Row → API DTO mappers for Break Policies. */

/** The rule columns of a row as the validation `BreakPolicyRules` shape (JSON categories normalised). */
export function rulesOf(row: BreakPolicyRow): BreakPolicyRules {
  return {
    breaksEnabled: row.breaksEnabled,
    maxBreaksPerShift: row.maxBreaksPerShift,
    maxBreakDurationMinutes: row.maxBreakDurationMinutes,
    maxTotalBreakMinutes: row.maxTotalBreakMinutes,
    minGapBetweenBreaksMinutes: row.minGapBetweenBreaksMinutes,
    minMinutesAfterShiftStart: row.minMinutesAfterShiftStart,
    employeeTriggeredAllowed: row.employeeTriggeredAllowed,
    scheduledBreaksAllowed: row.scheduledBreaksAllowed,
    restrictionBehaviour: row.restrictionBehaviour,
    relaxedCategories: parseRelaxedCategories(row.relaxedCategories),
  };
}

export interface BreakPolicyDtoExtras {
  isDefault: boolean;
  assignmentCount: number;
  assignedEmployeeCount: number;
}

export function toBreakPolicyDto(row: BreakPolicyRow, extras: BreakPolicyDtoExtras): BreakPolicy {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    ...rulesOf(row),
    status: row.status,
    isDefault: extras.isDefault,
    assignmentCount: extras.assignmentCount,
    assignedEmployeeCount: extras.assignedEmployeeCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toBreakPolicyAssignmentDto(
  row: BreakPolicyAssignmentRow,
  scopeNames: ReadonlyMap<string, string>,
  now: Date,
): BreakPolicyAssignment {
  const name =
    row.scopeType === "ORGANISATION"
      ? null
      : (scopeNames.get(scopeKey({ scopeType: row.scopeType, scopeId: row.scopeId })) ?? null);
  return {
    id: row.id,
    breakPolicy: { id: row.breakPolicy.id, name: row.breakPolicy.name },
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

export function summariseBreakAssignment(
  row: BreakPolicyAssignmentRow,
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
