import type { AssignmentScopeType, PolicyStatus } from "../enums";

/**
 * Structural shapes for policy resolution (§6.1). They are deliberately minimal and framework-free so
 * both `Policy` + `PolicyAssignment` and `BreakPolicy` + `BreakPolicyAssignment` rows from Prisma satisfy
 * them without mapping (except `breakPolicyId` → `policyId`, see `fromBreakPolicyAssignment`).
 *
 * All instants are UTC `Date`s; resolution never touches timezones.
 */

/** The minimum a policy row must expose for resolution to judge whether it is usable. */
export interface PolicyLike {
  id: string;
  status: PolicyStatus;
  /** Soft delete. `undefined` and `null` both mean "not deleted". */
  deletedAt?: Date | null;
  /**
   * Owning organisation. Optional so minimal shapes still work, but Prisma rows always carry it and then a
   * policy belonging to ANOTHER organisation is never applied (`POLICY_ORGANISATION_MISMATCH`, fall-through):
   * the database does not enforce that an assignment's policy shares its organisation.
   */
  organisationId?: string;
}

/**
 * A scope assignment row (PolicyAssignment / BreakPolicyAssignment).
 *
 * `_TPolicy` is a documentation-only (phantom) parameter naming the kind of policy `policyId` points at, so
 * `AssignmentLike<Policy>` and `AssignmentLike<BreakPolicy>` read well at call sites and match the §6.1
 * signature. It does not change the shape: TypeScript is structural, so the two are interchangeable and
 * `resolvePolicy` cannot detect a break assignment passed with work policies — keep them apart at load time.
 */
export interface AssignmentLike<_TPolicy extends PolicyLike = PolicyLike> {
  id: string;
  scopeType: AssignmentScopeType;
  /** Organisation / Location / Team / Employee id, depending on `scopeType`. */
  scopeId: string;
  /** Id of the (break) policy this assignment points at. */
  policyId: string;
  /** Inclusive start of the effective window; `null`/`undefined` = always. */
  effectiveFrom?: Date | null;
  /** Exclusive end of the effective window; `null`/`undefined` = open-ended. */
  effectiveTo?: Date | null;
  /** Tie-breaker: the most recently created active assignment wins within a level (equal instants: higher id). */
  createdAt: Date;
}

/** Everything about an employee that influences which scopes apply to them. */
export interface EmployeeContextLike {
  employeeId: string;
  organisationId: string;
  /** Teams the employee belongs to (EmployeeTeam rows). Order is irrelevant. */
  teamIds: readonly string[];
  /** Only the primary location participates in resolution (§6.1). */
  primaryLocationId?: string | null;
  /**
   * Secondary locations (EmployeeLocation rows). Accepted for completeness but NOT consulted by
   * `resolvePolicy` — see docs/POLICY_HIERARCHY.md. Reserved for future use.
   */
  locationIds?: readonly string[];
}

export interface ResolveInput<T extends PolicyLike> {
  employee: EmployeeContextLike;
  /**
   * Every assignment that could apply to this employee's organisation (any scope, any window). Pass ALL of
   * them and let resolution pick the winner (do not pre-select in SQL: Postgres orders `createdAt` to the
   * microsecond, a JS `Date` only to the millisecond). A repeated `id` is counted once (first occurrence).
   *
   * Deliberately the unparameterised `AssignmentLike`: `AssignmentLike<T>[]` would make TypeScript infer `T`
   * from the assignments too and widen it to `PolicyLike`, losing the concrete policy type of the result.
   */
  assignments: readonly AssignmentLike[];
  /**
   * Every policy referenced by `assignments` or `organisationDefaultPolicyId`, keyed by id, REGARDLESS of
   * status or organisation. Resolution needs archived/deleted/foreign rows present in order to skip them; a
   * referenced id that is missing produces a `POLICY_NOT_LOADED` warning. Only OWN properties are read.
   */
  policiesById: Readonly<Record<string, T>>;
  /** `Organisation.defaultPolicyId` / `Organisation.defaultBreakPolicyId`. */
  organisationDefaultPolicyId?: string | null;
  /** Instant to evaluate effective windows at. Defaults to `new Date()`. */
  now?: Date;
}

/** Where the winning policy came from. Discriminated on `via` for exhaustive switches. */
export type ResolvedFrom =
  | {
      via: "ASSIGNMENT";
      scopeType: AssignmentScopeType;
      scopeId: string;
      assignmentId: string;
    }
  | {
      via: "DEFAULT";
      scopeType: "ORGANISATION";
      /** The organisation id, for symmetry with the ASSIGNMENT variant. */
      scopeId: string;
    };

export const POLICY_RESOLUTION_WARNING_CODES = [
  "AMBIGUOUS_TEAM_ASSIGNMENT",
  "DUPLICATE_SCOPE_ASSIGNMENT",
  "INACTIVE_POLICY_SKIPPED",
  "POLICY_ORGANISATION_MISMATCH",
  "POLICY_NOT_LOADED",
  "POLICY_NOT_PUBLISHED",
  "POLICY_VERSION_NOT_LOADED",
  "INVALID_RESTRICTION_CONFIG",
] as const;
export type PolicyResolutionWarningCode = (typeof POLICY_RESOLUTION_WARNING_CODES)[number];

/** Summary of a competing assignment, JSON-safe (dates as ISO strings) so it can go in an activity log. */
export interface AssignmentCandidateSummary {
  assignmentId: string;
  scopeId: string;
  policyId: string;
  createdAt: string;
}

/**
 * Non-fatal findings produced while resolving. Callers are expected to persist them (e.g. as a WARNING
 * activity, §6.1) rather than ignore them. `details` is always JSON-serialisable.
 */
export type ResolutionWarning =
  | {
      /** Employee is in several teams whose active assignments point at DIFFERENT policies. */
      code: "AMBIGUOUS_TEAM_ASSIGNMENT";
      message: string;
      details: {
        scopeType: "TEAM";
        candidates: AssignmentCandidateSummary[];
        winnerAssignmentId: string;
      };
    }
  | {
      /** More than one active assignment for the same (scopeType, scopeId); should be prevented by the DB. */
      code: "DUPLICATE_SCOPE_ASSIGNMENT";
      message: string;
      details: {
        scopeType: AssignmentScopeType;
        scopeId: string;
        assignmentIds: string[];
        winnerAssignmentId: string;
      };
    }
  | {
      /**
       * An assignment (or the organisation default) pointed at an ARCHIVED or soft-deleted policy (or one whose
       * runtime `status` is not a known `PolicyStatus`, which is treated as unusable rather than thrown on).
       */
      code: "INACTIVE_POLICY_SKIPPED";
      message: string;
      details: {
        policyId: string;
        status: PolicyStatus;
        deletedAt: string | null;
        via: ResolvedFrom["via"];
        scopeType: AssignmentScopeType;
        scopeId: string;
        assignmentId: string | null;
      };
    }
  | {
      /**
       * An assignment (or the organisation default) pointed at a policy owned by a DIFFERENT organisation. It is
       * skipped and resolution falls through. Tenancy bug in whatever wrote the assignment / default.
       */
      code: "POLICY_ORGANISATION_MISMATCH";
      message: string;
      details: {
        policyId: string;
        policyOrganisationId: string;
        /** The employee's organisation. */
        organisationId: string;
        via: ResolvedFrom["via"];
        scopeType: AssignmentScopeType;
        scopeId: string;
        assignmentId: string | null;
      };
    }
  | {
      /** The winning id was not present in `policiesById`; its status could not be checked. Caller bug. */
      code: "POLICY_NOT_LOADED";
      message: string;
      details: {
        policyId: string;
        via: ResolvedFrom["via"];
        scopeType: AssignmentScopeType;
        scopeId: string;
        assignmentId: string | null;
      };
    }
  | {
      /** The policy has no published current version, so there is no restriction config to apply. */
      code: "POLICY_NOT_PUBLISHED";
      message: string;
      details: {
        policyId: string;
        currentVersionId: string | null;
      };
    }
  | {
      /**
       * The policy names a current version (`currentVersionId`) but that version was not supplied in
       * `currentVersion` (missing `include: { currentVersion: true }`, or a different version was attached).
       * Caller bug; NOT the same as "not published", so the dashboard must not offer "Publish" for it.
       */
      code: "POLICY_VERSION_NOT_LOADED";
      message: string;
      details: {
        policyId: string;
        currentVersionId: string;
        /** Id of the version that WAS supplied, if any. */
        suppliedVersionId: string | null;
      };
    }
  | {
      /** The stored `restrictionConfig` JSON does not match `RestrictionConfig`. Data-integrity bug. */
      code: "INVALID_RESTRICTION_CONFIG";
      message: string;
      details: {
        policyId: string;
        versionId: string;
      };
    };

export interface ResolveResult<T extends PolicyLike> {
  /**
   * The resolved policy row, or `null` when nothing resolved OR when the winning id was not loaded
   * (then `policyId` is still set and a `POLICY_NOT_LOADED` warning is present).
   */
  policy: T | null;
  policyId: string | null;
  resolvedFrom: ResolvedFrom | null;
  warnings: ResolutionWarning[];
}
