import type { ResolutionWarning } from "@workmode/shared/policy/resolvePolicy";
import {
  computePolicyVersionString,
  resolveEmployeePolicies,
  resolveForEmployees,
  type EmployeePolicyResolution,
} from "@/server/workState/externalServices";

/**
 * Policy resolution for the device sync surface (§6.1). The resolution itself is owned by the policies
 * service (`resolveForEmployees` / `resolveEmployeePolicies` / `computePolicyVersionString` in
 * src/server/policies, re-exported through `workState/externalServices.ts`); this module only adds the two
 * readings the mobile contract and the Work Mode job need on top of it.
 */

export { computePolicyVersionString, resolveEmployeePolicies, resolveForEmployees };
export type { EmployeePolicyResolution };

/**
 * The version token devices echo back: the id of the published `PolicyVersion` in force, or null when no
 * published policy resolves. `mobileSyncResponseSchema.policyVersion` / `deviceStateReportSchema.policyVersionApplied`
 * are UUIDs and `Device.policyVersionId` is a foreign key to `policy_versions`, so a device is "up to date"
 * exactly when the two ids are equal. (`computePolicyVersionString` is the composite diagnostic string of the
 * policies service — `<policyId>:<versionNumber>|<breakPolicyId>:<updatedAt>` — and is recorded in the
 * POLICY_SYNCED activity metadata, never sent as the token.)
 */
export function policyVersionToken(
  resolution: Pick<EmployeePolicyResolution, "policy"> | null | undefined,
): string | null {
  return resolution?.policy?.currentVersion?.id ?? null;
}

/** Warnings worth persisting as POLICY_RESOLUTION_WARNING activities (§6.1). */
export function ambiguousTeamWarnings(resolution: EmployeePolicyResolution): ResolutionWarning[] {
  return resolution.warnings.filter((w) => w.code === "AMBIGUOUS_TEAM_ASSIGNMENT");
}
