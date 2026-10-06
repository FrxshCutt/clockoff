import { isRestrictionConfig } from "./restrictionConfig";
import type { RestrictionConfig } from "./restrictionConfig";
import type { PolicyLike, ResolutionWarning } from "./types";

/** Minimal `PolicyVersion` row. `restrictionConfig` is `unknown` because Prisma hands back `JsonValue`. */
export interface PolicyVersionLike {
  id: string;
  versionNumber: number;
  restrictionConfig: unknown;
  /** `null` = draft version that has never been published. */
  publishedAt: Date | null;
}

/**
 * A `Policy` row loaded with `include: { currentVersion: true }`. When `currentVersionId` is a string,
 * `currentVersion` must be THAT version; otherwise the result is `POLICY_VERSION_NOT_LOADED`.
 */
export interface VersionedPolicyLike extends PolicyLike {
  currentVersionId?: string | null;
  currentVersion?: PolicyVersionLike | null;
}

/** The published version's data without warnings; what a device sync or the dashboard displays. */
export interface PolicyVersionSnapshot {
  versionId: string | null;
  versionNumber: number | null;
  publishedAt: Date | null;
  restrictionConfig: RestrictionConfig | null;
}

export interface ResolvedPolicyVersion extends PolicyVersionSnapshot {
  warnings: ResolutionWarning[];
}

const EMPTY_VERSION: PolicyVersionSnapshot = {
  versionId: null,
  versionNumber: null,
  publishedAt: null,
  restrictionConfig: null,
};

/**
 * Returns the restriction config of the policy's current PUBLISHED version.
 *
 * - `policy` null → empty snapshot, no warning (nothing resolved upstream is not this function's news).
 * - `currentVersionId` set but `currentVersion` absent or a different version → `POLICY_VERSION_NOT_LOADED`,
 *   config null (a loading bug, deliberately NOT reported as "not published").
 * - no `currentVersion`, or `currentVersion.publishedAt` null → `POLICY_NOT_PUBLISHED`, config null.
 * - stored JSON fails `isRestrictionConfig` → `INVALID_RESTRICTION_CONFIG`, config null (version id and
 *   number are still reported so the problem can be located).
 */
export function resolvePolicyVersion(policy: VersionedPolicyLike | null): ResolvedPolicyVersion {
  if (policy === null) return { ...EMPTY_VERSION, warnings: [] };

  const version = policy.currentVersion ?? null;
  const expectedVersionId = policy.currentVersionId;
  if (typeof expectedVersionId === "string" && (version === null || version.id !== expectedVersionId)) {
    const suppliedVersionId = version?.id ?? null;
    return {
      ...EMPTY_VERSION,
      warnings: [
        {
          code: "POLICY_VERSION_NOT_LOADED",
          message:
            suppliedVersionId === null
              ? `Policy ${policy.id} current version ${expectedVersionId} was not loaded (include currentVersion)`
              : `Policy ${policy.id} current version is ${expectedVersionId} but version ${suppliedVersionId} was supplied`,
          details: { policyId: policy.id, currentVersionId: expectedVersionId, suppliedVersionId },
        },
      ],
    };
  }

  if (version === null || version.publishedAt === null) {
    const currentVersionId = policy.currentVersionId ?? version?.id ?? null;
    return {
      ...EMPTY_VERSION,
      warnings: [
        {
          code: "POLICY_NOT_PUBLISHED",
          message:
            version === null
              ? `Policy ${policy.id} has no current version`
              : `Policy ${policy.id} current version ${version.id} (v${version.versionNumber}) has not been published`,
          details: { policyId: policy.id, currentVersionId },
        },
      ],
    };
  }

  if (!isRestrictionConfig(version.restrictionConfig)) {
    return {
      versionId: version.id,
      versionNumber: version.versionNumber,
      publishedAt: version.publishedAt,
      restrictionConfig: null,
      warnings: [
        {
          code: "INVALID_RESTRICTION_CONFIG",
          message: `Policy ${policy.id} version ${version.id} (v${version.versionNumber}) has a restrictionConfig that does not match RestrictionConfig`,
          details: { policyId: policy.id, versionId: version.id },
        },
      ],
    };
  }

  return {
    versionId: version.id,
    versionNumber: version.versionNumber,
    publishedAt: version.publishedAt,
    restrictionConfig: version.restrictionConfig,
    warnings: [],
  };
}
