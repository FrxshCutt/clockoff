/**
 * Seam for services owned by other engineers. The Work Mode job, the device endpoints, the break service
 * and the digest call the functions below by the EXACT names their owners expose; every caller in sync/,
 * deviceState/, deviceEvents/, breaks/, workState/ and digest/ imports from this file only, so swapping an
 * implementation is a one-line change here.
 *
 *   - `resolveEmployeePolicies`, `resolveForEmployees`, `computePolicyVersionString`
 *                                       → src/server/policies/policies.service.ts
 *     `resolveEmployeePolicies` throws EMPLOYEE_NOT_FOUND for an employee outside the organisation and the
 *     resolution reads through the shared Prisma client (no transaction client). The mobile `policyVersion`
 *     token is the PolicyVersion id (`sync/policyResolution.ts#policyVersionToken`), not the composite
 *     `computePolicyVersionString` — see that module.
 *   - `recomputeEmployeeInviteStatus`   → src/server/employees/employees.service.ts
 *   - `markCompletedShifts`, `materialiseRecurrences`
 *                                       → src/server/shifts/shifts.service.ts
 *   - `createManagerNotification`, `publishNotificationCreated`
 *                                       → src/server/notifications/notifications.service.ts
 *     (second argument: a Prisma client / transaction, or `{ db, publish, respectPreferences }`; pass
 *     `{ db: tx, publish: false }` inside a transaction and publish the rows after the commit).
 */

export {
  computePolicyVersionString,
  resolveEmployeePolicies,
  resolveForEmployees,
} from "@/server/policies/policies.service";
export type {
  EmployeePolicyResolution,
  ResolvedBreakPolicy,
  ResolvedWorkPolicySummary,
} from "@/server/policies/policies.service";

export { recomputeEmployeeInviteStatus } from "@/server/employees/employees.service";

export { markCompletedShifts, materialiseRecurrences } from "@/server/shifts/shifts.service";

export {
  createManagerNotification,
  publishNotificationCreated,
} from "@/server/notifications/notifications.service";
export type {
  CreateManagerNotificationInput,
  CreateManagerNotificationOptions,
} from "@/server/notifications/notifications.service";
