import type { ResolutionWarning } from "./types";

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}

const NONE = "-";

/**
 * Stable identity of the CONDITION behind a resolution warning, for de-duplicating persisted WARNING
 * activities (§6.1). Resolution runs on every device sync and dashboard render, so a caller that logs every
 * warning it sees would flood the activity feed; instead it should record a warning only when its key is not
 * among the keys it recorded last time for that employee (e.g. kept in the activity's `metadata`).
 *
 * The key changes exactly when the underlying condition changes (another winner, a new competing
 * assignment, another version) and never with `now`, input order or message wording. It is unique per
 * employee AND per policy kind only: combine it with the employee id and "work"/"break" when storing.
 */
export function resolutionWarningKey(warning: ResolutionWarning): string {
  switch (warning.code) {
    case "AMBIGUOUS_TEAM_ASSIGNMENT": {
      const { details } = warning;
      const candidates = details.candidates.map((c) => `${c.assignmentId}>${c.policyId}`).sort();
      return [warning.code, details.winnerAssignmentId, ...candidates].join(":");
    }
    case "DUPLICATE_SCOPE_ASSIGNMENT": {
      const { details } = warning;
      return [
        warning.code,
        details.scopeType,
        details.scopeId,
        details.winnerAssignmentId,
        ...[...details.assignmentIds].sort(),
      ].join(":");
    }
    case "INACTIVE_POLICY_SKIPPED": {
      const { details } = warning;
      return [
        warning.code,
        details.via,
        details.scopeType,
        details.scopeId,
        details.assignmentId ?? NONE,
        details.policyId,
        details.status,
        details.deletedAt === null ? NONE : "deleted",
      ].join(":");
    }
    case "POLICY_ORGANISATION_MISMATCH": {
      const { details } = warning;
      return [
        warning.code,
        details.via,
        details.scopeType,
        details.scopeId,
        details.assignmentId ?? NONE,
        details.policyId,
        details.policyOrganisationId,
      ].join(":");
    }
    case "POLICY_NOT_LOADED": {
      const { details } = warning;
      return [
        warning.code,
        details.via,
        details.scopeType,
        details.scopeId,
        details.assignmentId ?? NONE,
        details.policyId,
      ].join(":");
    }
    case "POLICY_NOT_PUBLISHED":
      return [warning.code, warning.details.policyId, warning.details.currentVersionId ?? NONE].join(":");
    case "POLICY_VERSION_NOT_LOADED":
      return [
        warning.code,
        warning.details.policyId,
        warning.details.currentVersionId,
        warning.details.suppliedVersionId ?? NONE,
      ].join(":");
    case "INVALID_RESTRICTION_CONFIG":
      return [warning.code, warning.details.policyId, warning.details.versionId].join(":");
    default:
      return assertNever(warning);
  }
}
