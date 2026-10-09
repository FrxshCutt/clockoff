import { nameKey } from "@clockoff/shared/csv/matchEmployee";
import type { EmploymentStatus, PendingExternalEmployeeReason } from "@clockoff/shared/enums";
import type { ExternalEmployee } from "@clockoff/shared/providers/syncSink";
import { plandayEmployeeExternalId } from "../planday/constants";
import {
  decideMemberships,
  departmentKeysOf,
  mappedLocationIds,
  mappedTeamIds,
  type DepartmentMappings,
  type GroupMappings,
} from "./locationDecisions";

/**
 * Employees (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §6.5): scope, matching and the decision table, as
 * pure functions. The sinks (apps/web) load the batch's map rows and ClockOff employees in a few queries, call these
 * per record in memory and perform only the writes they ask for.
 *
 * Safety rules encoded here: out-of-scope people are never persisted anywhere; a name alone never auto-links after
 * onboarding; an ambiguous match is never merged; a raw CSV id without corroboration never links; a
 * `PLANDAY:<otherPortal>:…` id never matches; deactivation needs positive evidence (D-045); a future dismissal
 * changes nothing until its date has passed (Q23).
 */

/** Missing employees get a manager review after this long without positive deactivation evidence (§6.5). */
export const MISSING_EMPLOYEE_REVIEW_AFTER_MS = 24 * 3_600_000;
/** At most this many by-id reads per run confirm absent employees (notes §9.2 rule, §6.5). */
export const ABSENT_EMPLOYEE_RECHECK_LIMIT = 20;

/** The `IntegrationMappingConfig` fields the employee decisions read. */
export interface EmployeeMappingConfig {
  /** Included department keys (`"none"` = not in any department). */
  readonly includedDepartmentIds: readonly string[];
  /** Planday employee ids left unticked at step 5 or dismissed from the pending queue. */
  readonly excludedEmployeeIds: readonly string[];
  readonly departmentMappings: DepartmentMappings;
  readonly groupMappings: GroupMappings;
  readonly autoIncludeNewEmployees: boolean;
  /** Persist Planday's `email` (D-042). Off: used in memory for matching only; email is then not a managed field. */
  readonly importEmails: boolean;
}

const setCache = new WeakMap<readonly string[], ReadonlySet<string>>();

function asSet(values: readonly string[]): ReadonlySet<string> {
  let set = setCache.get(values);
  if (!set) {
    set = new Set(values);
    setCache.set(values, set);
  }
  return set;
}

/** Case-insensitive email key; null for no email. */
export function emailKey(email: string | null | undefined): string | null {
  const trimmed = email?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/** The exact full-name key (`nameKey` of the CSV matcher) of a first and last name. */
export function employeeNameKey(firstName: string, lastName: string): string {
  return nameKey(`${firstName} ${lastName}`);
}

// ---------------------------------------------------------------------------------------------------------
// Scope and resolved targets
// ---------------------------------------------------------------------------------------------------------

/**
 * In scope (§6.5): at least one of the person's department keys is included (an empty `departments[]` counts as
 * `"none"`) and the id is not in `excludedEmployeeIds`. Out-of-scope people are counted and never persisted.
 */
export function isEmployeeInScope(
  external: Pick<ExternalEmployee, "externalId" | "externalLocationIds">,
  config: Pick<EmployeeMappingConfig, "includedDepartmentIds" | "excludedEmployeeIds">,
): boolean {
  if (asSet(config.excludedEmployeeIds).has(external.externalId)) return false;
  const included = asSet(config.includedDepartmentIds);
  return departmentKeysOf(external.externalLocationIds).some((key) => included.has(key));
}

/** What an in-scope Planday employee resolves to in ClockOff, through the department and group mappings. */
export interface EmployeeTargets {
  readonly inScope: boolean;
  /** The primary department's location, else the first included department's location; null when none. */
  readonly primaryLocationId: string | null;
  /** The ClockOff department of a department mapped to one (primary first); null when none is. */
  readonly departmentId: string | null;
  /** Every location the person's included departments map to (sorted). */
  readonly locationIds: readonly string[];
  /** Every team the person's mapped groups map to (sorted). */
  readonly teamIds: readonly string[];
}

export function resolveEmployeeTargets(
  external: Pick<
    ExternalEmployee,
    "externalId" | "externalLocationIds" | "externalTeamIds" | "primaryExternalLocationId"
  >,
  config: Pick<
    EmployeeMappingConfig,
    "includedDepartmentIds" | "excludedEmployeeIds" | "departmentMappings" | "groupMappings"
  >,
): EmployeeTargets {
  const inScope = isEmployeeInScope(external, config);
  const included = asSet(config.includedDepartmentIds);
  const keys = departmentKeysOf(external.externalLocationIds).filter((key) => included.has(key));
  const primary = external.primaryExternalLocationId ?? null;
  // The primary department first, then the others in Planday's order.
  const ordered =
    primary !== null && keys.includes(primary)
      ? [primary, ...keys.filter((key) => key !== primary)]
      : keys;
  let primaryLocationId: string | null = null;
  let departmentId: string | null = null;
  const locationIds = new Set<string>();
  for (const key of ordered) {
    const mapping = config.departmentMappings[key];
    if (!mapping) continue;
    if (mapping.target === "LOCATION") {
      primaryLocationId ??= mapping.locationId;
      locationIds.add(mapping.locationId);
    } else {
      departmentId ??= mapping.departmentId;
    }
  }
  const teamIds = new Set<string>();
  for (const groupId of external.externalTeamIds ?? []) {
    const mapping = config.groupMappings[groupId];
    if (mapping) teamIds.add(mapping.teamId);
  }
  return {
    inScope,
    primaryLocationId,
    departmentId,
    locationIds: [...locationIds].sort(),
    teamIds: [...teamIds].sort(),
  };
}

/**
 * The decision inputs hashed into an employee's `lastHash` (§6.2): the mapped record, the resolved primary location
 * and ClockOff department, the location and team ids, the scope flag and `importEmails`. Mapping changes that keep
 * every target leave the hash unchanged.
 */
export function employeeDecisionInputs(
  external: ExternalEmployee,
  targets: EmployeeTargets,
  config: Pick<EmployeeMappingConfig, "importEmails">,
): Record<string, unknown> {
  return {
    v: 1,
    kind: "EMPLOYEE",
    record: {
      externalId: external.externalId,
      firstName: external.firstName.trim(),
      lastName: external.lastName.trim(),
      email: emailKey(external.email),
      active: external.active,
    },
    targets: {
      inScope: targets.inScope,
      primaryLocationId: targets.primaryLocationId,
      departmentId: targets.departmentId,
      locationIds: targets.locationIds,
      teamIds: targets.teamIds,
    },
    importEmails: config.importEmails,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Matching (§6.5, rules 1 to 6)
// ---------------------------------------------------------------------------------------------------------

/** A non-deleted ClockOff employee of the organisation, as the matcher sees it. */
export interface EmployeeCandidate {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string | null;
  readonly externalEmployeeId: string | null;
  /** The Planday id an EMPLOYEE map row of this integration links it to; null when unmapped. */
  readonly mappedExternalId: string | null;
}

export interface EmployeeCandidateIndex {
  readonly candidates: readonly EmployeeCandidate[];
  readonly byMappedExternalId: ReadonlyMap<string, EmployeeCandidate>;
  readonly byExternalEmployeeId: ReadonlyMap<string, readonly EmployeeCandidate[]>;
  readonly byEmail: ReadonlyMap<string, readonly EmployeeCandidate[]>;
  readonly byNameKey: ReadonlyMap<string, readonly EmployeeCandidate[]>;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Builds the lookup tables once per batch (matching is then constant time per Planday employee). */
export function indexEmployeeCandidates(
  candidates: readonly EmployeeCandidate[],
): EmployeeCandidateIndex {
  const byMappedExternalId = new Map<string, EmployeeCandidate>();
  const byExternalEmployeeId = new Map<string, EmployeeCandidate[]>();
  const byEmail = new Map<string, EmployeeCandidate[]>();
  const byNameKey = new Map<string, EmployeeCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.mappedExternalId !== null) {
      byMappedExternalId.set(candidate.mappedExternalId, candidate);
    }
    if (candidate.externalEmployeeId) {
      push(byExternalEmployeeId, candidate.externalEmployeeId, candidate);
    }
    const email = emailKey(candidate.email);
    if (email) push(byEmail, email, candidate);
    push(byNameKey, employeeNameKey(candidate.firstName, candidate.lastName), candidate);
  }
  return { candidates, byMappedExternalId, byExternalEmployeeId, byEmail, byNameKey };
}

function isIndex(
  value: EmployeeCandidateIndex | readonly EmployeeCandidate[],
): value is EmployeeCandidateIndex {
  return !Array.isArray(value);
}

/** How a Planday employee was matched (`PendingExternalEmployee.matchSignal`, §6.5). */
export type EmployeeMatchSignal = "EXTERNAL_ID" | "EXTERNAL_ID_RAW" | "EMAIL" | "NAME";

export type EmployeeMatch =
  /** Rule 1: an EMPLOYEE map row links this Planday id to the employee. */
  | { readonly kind: "MAPPED"; readonly employeeId: string }
  /** Rules 2a, 2b (corroborated), 3, and 4 in the wizard: strong enough to link. */
  | { readonly kind: "MATCHED"; readonly employeeId: string; readonly signal: EmployeeMatchSignal }
  /** One candidate on weak evidence (a raw CSV id alone, or a name alone after onboarding): the manager confirms. */
  | {
      readonly kind: "POSSIBLE_MATCH";
      readonly employeeId: string;
      readonly signal: "EXTERNAL_ID_RAW" | "NAME";
    }
  /** Rule 5 (and shared emails): never merged; the manager chooses. */
  | { readonly kind: "AMBIGUOUS"; readonly candidateEmployeeIds: readonly string[] }
  /** Rule 6: nobody; a new employee. */
  | { readonly kind: "NONE" };

export interface MatchOptions {
  /** The connection's portal id (rule 2a compares `PLANDAY:<portalId>:<id>` exactly). */
  readonly portalId: string;
  /**
   * WIZARD: the DIRECTORY run's MATCH_EMPLOYEES over the complete staged set (a unique name matches).
   * SYNC: after onboarding, page by page (a name alone is only a POSSIBLE_MATCH).
   */
  readonly mode: "WIZARD" | "SYNC";
  /**
   * SYNC only: ClockOff employees another Planday record linked earlier in the same run. A match whose only
   * candidate is one of them is AMBIGUOUS with that candidate, so two Planday people are never folded into one
   * employee and one person is never created twice.
   */
  readonly claimedEmployeeIds?: ReadonlySet<string>;
}

const NO_CLAIMS: ReadonlySet<string> = new Set();

/**
 * Whether the ClockOff employee records an identity that contradicts this Planday employee (rule 4's last
 * condition): a different email when both have one, or an external id that is not this person's.
 */
function hasDifferentIdentity(
  candidate: EmployeeCandidate,
  external: Pick<ExternalEmployee, "externalId" | "email">,
  portalId: string,
): boolean {
  const theirs = emailKey(candidate.email);
  const ours = emailKey(external.email);
  if (theirs !== null && ours !== null && theirs !== ours) return true;
  const recorded = candidate.externalEmployeeId;
  return (
    recorded !== null &&
    recorded !== "" &&
    recorded !== external.externalId &&
    recorded !== plandayEmployeeExternalId(portalId, external.externalId)
  );
}

/**
 * `matchExternalEmployee(external, candidates, plandayNameCounts)` — §6.5, first rule that applies:
 *
 * 1. an EMPLOYEE map row → MAPPED;
 * 2a. `externalEmployeeId === PLANDAY:<portalId>:<id>` on an employee not mapped to another Planday id → MATCHED;
 * 2b. `externalEmployeeId === <id>` (raw, from a CSV) with the email or the name agreeing → MATCHED, alone →
 *     POSSIBLE_MATCH (never auto-linked);
 * 3. the email equals exactly one unmapped employee → MATCHED; two or more → AMBIGUOUS;
 * 4. the exact name equals exactly one unmapped employee, no other in-scope Planday employee has it
 *    (`plandayNameCounts[key] === 1`) and that employee records no contradicting email or id → MATCHED in the
 *    wizard, POSSIBLE_MATCH in a SYNC;
 * 5. the name equals two or more unmapped employees, or two Planday employees share it and one ClockOff employee
 *    has it → AMBIGUOUS;
 * 6. NONE.
 *
 * `plandayNameCounts` counts in-scope Planday employees per name key (`countPlandayNames`): in the wizard over the
 * complete staged set, so namesakes on different pages are always seen. A missing key counts as 1.
 */
export function matchExternalEmployee(
  external: Pick<ExternalEmployee, "externalId" | "firstName" | "lastName" | "email">,
  candidates: EmployeeCandidateIndex | readonly EmployeeCandidate[],
  plandayNameCounts: Readonly<Record<string, number>>,
  options: MatchOptions,
): EmployeeMatch {
  const index = isIndex(candidates) ? candidates : indexEmployeeCandidates(candidates);
  const mapped = index.byMappedExternalId.get(external.externalId);
  if (mapped) return { kind: "MAPPED", employeeId: mapped.id };

  const claimed = options.mode === "SYNC" ? (options.claimedEmployeeIds ?? NO_CLAIMS) : NO_CLAIMS;
  // Unmapped employees, plus those another Planday record claimed in this run (reported as ambiguous below).
  const eligible = (candidate: EmployeeCandidate) =>
    candidate.mappedExternalId === null || claimed.has(candidate.id);
  const settle = (candidate: EmployeeCandidate, match: EmployeeMatch): EmployeeMatch =>
    claimed.has(candidate.id) ? { kind: "AMBIGUOUS", candidateEmployeeIds: [candidate.id] } : match;

  // Rule 2a: the id this integration writes, for this portal only.
  const qualified = (
    index.byExternalEmployeeId.get(
      plandayEmployeeExternalId(options.portalId, external.externalId),
    ) ?? []
  ).filter(eligible);
  if (qualified[0]) {
    return settle(qualified[0], {
      kind: "MATCHED",
      employeeId: qualified[0].id,
      signal: "EXTERNAL_ID",
    });
  }

  const email = emailKey(external.email);
  const key = employeeNameKey(external.firstName, external.lastName);

  // Rule 2b: a raw Planday id (a CSV import), corroborated by the email or the exact name.
  const raw = (index.byExternalEmployeeId.get(external.externalId) ?? []).filter(eligible);
  if (raw[0]) {
    const candidate = raw[0];
    const corroborated =
      (email !== null && emailKey(candidate.email) === email) ||
      employeeNameKey(candidate.firstName, candidate.lastName) === key;
    return settle(
      candidate,
      corroborated
        ? { kind: "MATCHED", employeeId: candidate.id, signal: "EXTERNAL_ID_RAW" }
        : { kind: "POSSIBLE_MATCH", employeeId: candidate.id, signal: "EXTERNAL_ID_RAW" },
    );
  }

  // Rule 3: the email.
  if (email !== null) {
    const byEmail = (index.byEmail.get(email) ?? []).filter(eligible);
    if (byEmail.length > 1) {
      return { kind: "AMBIGUOUS", candidateEmployeeIds: byEmail.map((c) => c.id).sort() };
    }
    if (byEmail[0]) {
      return settle(byEmail[0], { kind: "MATCHED", employeeId: byEmail[0].id, signal: "EMAIL" });
    }
  }

  // Rules 4 and 5: the exact full name.
  const byName = (index.byNameKey.get(key) ?? []).filter(eligible);
  if (byName.length > 1) {
    return { kind: "AMBIGUOUS", candidateEmployeeIds: byName.map((c) => c.id).sort() };
  }
  const namesake = byName[0];
  if (namesake) {
    if ((plandayNameCounts[key] ?? 1) > 1) {
      return { kind: "AMBIGUOUS", candidateEmployeeIds: [namesake.id] };
    }
    if (hasDifferentIdentity(namesake, external, options.portalId)) return { kind: "NONE" };
    return settle(
      namesake,
      options.mode === "WIZARD"
        ? { kind: "MATCHED", employeeId: namesake.id, signal: "NAME" }
        : { kind: "POSSIBLE_MATCH", employeeId: namesake.id, signal: "NAME" },
    );
  }
  return { kind: "NONE" };
}

/** In-scope Planday employees per name key: the `plandayNameCounts` argument of `matchExternalEmployee`. */
export function countPlandayNames(
  employees: Iterable<Pick<ExternalEmployee, "firstName" | "lastName">>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const employee of employees) {
    const key = employeeNameKey(employee.firstName, employee.lastName);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * Over a complete set of matches (the wizard's MATCH_EMPLOYEES): when two Planday employees matched the same
 * ClockOff employee (a shared email, say), neither may link: both become AMBIGUOUS with that candidate, so a link
 * can never fold two people into one (and never hits the one-employee-per-map-row index).
 */
export function resolveDuplicateMatches<T extends { readonly match: EmployeeMatch }>(
  entries: readonly T[],
): T[] {
  const uses = new Map<string, number>();
  for (const { match } of entries) {
    if (match.kind === "MATCHED" || match.kind === "POSSIBLE_MATCH") {
      uses.set(match.employeeId, (uses.get(match.employeeId) ?? 0) + 1);
    }
  }
  return entries.map((entry) => {
    const { match } = entry;
    if (
      (match.kind === "MATCHED" || match.kind === "POSSIBLE_MATCH") &&
      (uses.get(match.employeeId) ?? 0) > 1
    ) {
      return { ...entry, match: { kind: "AMBIGUOUS", candidateEmployeeIds: [match.employeeId] } };
    }
    return entry;
  });
}

/** The `PendingExternalEmployee` match columns. */
export interface PendingMatchFields {
  readonly matchedEmployeeId: string | null;
  readonly matchSignal: EmployeeMatchSignal | null;
  readonly candidateEmployeeIds: readonly string[];
}

/**
 * Encodes a match into the pending row's columns (and `matchFromPendingFields` decodes it):
 * MATCHED / MAPPED → `matchedEmployeeId` + signal, no candidates; POSSIBLE_MATCH → `matchedEmployeeId` + signal and
 * `candidateEmployeeIds = [matchedEmployeeId]` (what tells a weak match from a strong one in a wizard row, whose
 * reason is ONBOARDING either way); AMBIGUOUS → no `matchedEmployeeId`, the candidates; NONE → all empty.
 */
export function pendingMatchFields(match: EmployeeMatch): PendingMatchFields {
  switch (match.kind) {
    case "MAPPED":
      return {
        matchedEmployeeId: match.employeeId,
        matchSignal: "EXTERNAL_ID",
        candidateEmployeeIds: [],
      };
    case "MATCHED":
      return {
        matchedEmployeeId: match.employeeId,
        matchSignal: match.signal,
        candidateEmployeeIds: [],
      };
    case "POSSIBLE_MATCH":
      return {
        matchedEmployeeId: match.employeeId,
        matchSignal: match.signal,
        candidateEmployeeIds: [match.employeeId],
      };
    case "AMBIGUOUS":
      return {
        matchedEmployeeId: null,
        matchSignal: null,
        candidateEmployeeIds: [...match.candidateEmployeeIds],
      };
    case "NONE":
      return { matchedEmployeeId: null, matchSignal: null, candidateEmployeeIds: [] };
  }
}

/** Decodes `pendingMatchFields` (unknown or inconsistent columns decode to the safest reading). */
export function matchFromPendingFields(fields: {
  readonly matchedEmployeeId: string | null;
  readonly matchSignal: string | null;
  readonly candidateEmployeeIds: readonly string[];
}): EmployeeMatch {
  const signal = fields.matchSignal as EmployeeMatchSignal | null;
  const known =
    signal === "EXTERNAL_ID" ||
    signal === "EXTERNAL_ID_RAW" ||
    signal === "EMAIL" ||
    signal === "NAME";
  if (fields.matchedEmployeeId) {
    const weak =
      fields.candidateEmployeeIds.length === 1 &&
      fields.candidateEmployeeIds[0] === fields.matchedEmployeeId;
    if (!known || fields.candidateEmployeeIds.length > 1) {
      return {
        kind: "AMBIGUOUS",
        candidateEmployeeIds: [
          ...new Set([fields.matchedEmployeeId, ...fields.candidateEmployeeIds]),
        ].sort(),
      };
    }
    if (weak) {
      return {
        kind: "POSSIBLE_MATCH",
        employeeId: fields.matchedEmployeeId,
        signal: signal === "NAME" ? "NAME" : "EXTERNAL_ID_RAW",
      };
    }
    return { kind: "MATCHED", employeeId: fields.matchedEmployeeId, signal };
  }
  if (fields.candidateEmployeeIds.length > 0) {
    return { kind: "AMBIGUOUS", candidateEmployeeIds: [...fields.candidateEmployeeIds] };
  }
  return { kind: "NONE" };
}

// ---------------------------------------------------------------------------------------------------------
// Writes: create, link and update payloads
// ---------------------------------------------------------------------------------------------------------

/** The ClockOff employee as the decisions see it (managed fields and memberships). */
export interface ExistingEmployee {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string | null;
  readonly externalEmployeeId: string | null;
  readonly primaryLocationId: string | null;
  readonly departmentId: string | null;
  readonly employmentStatus: EmploymentStatus;
  /** `EmployeeLocation` rows. */
  readonly locationIds: readonly string[];
  /** `EmployeeTeam` rows. */
  readonly teamIds: readonly string[];
}

/** `importExternalEmployee` input (§6.5): `inviteStatus NOT_INVITED`, `source INTEGRATION` and the map row are the writer's. */
export interface EmployeeCreate {
  readonly firstName: string;
  readonly lastName: string;
  /** Only with `importEmails`. */
  readonly email: string | null;
  readonly externalEmployeeId: string;
  readonly primaryLocationId: string | null;
  readonly departmentId: string | null;
  readonly locationIds: readonly string[];
  readonly teamIds: readonly string[];
}

/** Managed-field changes and membership changes for a linked or mapped employee. */
export interface EmployeeUpdate {
  readonly patch: {
    readonly firstName?: string;
    readonly lastName?: string;
    readonly email?: string;
    readonly externalEmployeeId?: string;
    readonly primaryLocationId?: string | null;
    readonly departmentId?: string;
  };
  readonly locations: { readonly add: readonly string[]; readonly remove: readonly string[] };
  readonly teams: { readonly add: readonly string[]; readonly remove: readonly string[] };
}

export function employeeCreateFor(
  external: ExternalEmployee,
  targets: EmployeeTargets,
  config: Pick<EmployeeMappingConfig, "importEmails">,
  portalId: string,
): EmployeeCreate {
  return {
    firstName: external.firstName.trim(),
    lastName: external.lastName.trim(),
    email: config.importEmails ? external.email?.trim() || null : null,
    externalEmployeeId: plandayEmployeeExternalId(portalId, external.externalId),
    primaryLocationId: targets.primaryLocationId,
    departmentId: targets.departmentId,
    locationIds: targets.locationIds,
    teamIds: targets.teamIds,
  };
}

/**
 * The changes that bring a ClockOff employee in line with Planday (§6.5 "SYNC, mapped, fields changed"): first and
 * last name; email only with `importEmails` and only when Planday has one (a Planday profile without an email never
 * erases the address ClockOff holds); `primaryLocationId`; `departmentId` only when a department maps to a ClockOff
 * department; memberships of mapped locations and teams. With `link`, also `externalEmployeeId =
 * PLANDAY:<portalId>:<id>` when the employee has none (a CSV value is never overwritten). Never invite status,
 * devices, policies, job title or phone. Null when nothing changes.
 */
export function employeeUpdateFor(
  external: ExternalEmployee,
  targets: EmployeeTargets,
  employee: ExistingEmployee,
  config: Pick<
    EmployeeMappingConfig,
    "importEmails" | "departmentMappings" | "groupMappings" | "includedDepartmentIds"
  >,
  options: { readonly link?: { readonly portalId: string } } = {},
): EmployeeUpdate | null {
  const patch: {
    firstName?: string;
    lastName?: string;
    email?: string;
    externalEmployeeId?: string;
    primaryLocationId?: string | null;
    departmentId?: string;
  } = {};
  const firstName = external.firstName.trim();
  const lastName = external.lastName.trim();
  if (firstName !== employee.firstName) patch.firstName = firstName;
  if (lastName !== employee.lastName) patch.lastName = lastName;
  const email = external.email?.trim() ?? "";
  if (config.importEmails && email !== "" && emailKey(email) !== emailKey(employee.email)) {
    patch.email = email;
  }
  if (options.link && !employee.externalEmployeeId) {
    patch.externalEmployeeId = plandayEmployeeExternalId(
      options.link.portalId,
      external.externalId,
    );
  }
  if (targets.primaryLocationId !== employee.primaryLocationId) {
    patch.primaryLocationId = targets.primaryLocationId;
  }
  if (targets.departmentId !== null && targets.departmentId !== employee.departmentId) {
    patch.departmentId = targets.departmentId;
  }
  const locations = decideMemberships({
    desired: targets.locationIds,
    current: employee.locationIds,
    managed: mappedLocationIds(config.departmentMappings, config.includedDepartmentIds),
  });
  const teams = decideMemberships({
    desired: targets.teamIds,
    current: employee.teamIds,
    managed: mappedTeamIds(config.groupMappings),
  });
  const changed =
    Object.keys(patch).length > 0 ||
    locations.add.length > 0 ||
    locations.remove.length > 0 ||
    teams.add.length > 0 ||
    teams.remove.length > 0;
  return changed ? { patch, locations, teams } : null;
}

// ---------------------------------------------------------------------------------------------------------
// Decision table: the EMPLOYEES phase (wizard staging and SYNC)
// ---------------------------------------------------------------------------------------------------------

/** The employee's `ExternalEntityMap` row. */
export interface EmployeeMapRow {
  readonly internalId: string;
  readonly lastHash: string | null;
  /** Deactivated by the sync (eligible for reactivation). */
  readonly upstreamRemovedAt: Date | null;
  /** First run Planday stopped returning the employee without positive evidence. */
  readonly upstreamMissingSince: Date | null;
  /** The manager chose "Keep" on the MISSING_IN_PLANDAY review. */
  readonly reviewDismissedAt: Date | null;
}

export type EmployeeWarningCode =
  | "EMPLOYEE_OUT_OF_SCOPE"
  | "EMPLOYEE_NOT_VISIBLE"
  | "DEACTIVATION_SCHEDULED"
  | "EMPLOYEE_INACTIVE_IN_CLOCKOFF";

export interface EmployeeDecisionInput {
  /**
   * The person from `/hr/v1.0/employees`. `active` is false when their `deactivationDate` has already passed
   * (the provider sets it); such a person is never imported or reactivated from the active list.
   */
  readonly external: ExternalEmployee;
  /** `matchExternalEmployee(...)`; MAPPED when a map row exists. */
  readonly match: EmployeeMatch;
  readonly mapRow: EmployeeMapRow | null;
  /** The mapped employee (MAPPED), else the matched one (MATCHED); null otherwise. */
  readonly employee: ExistingEmployee | null;
  readonly config: EmployeeMappingConfig;
  /** DIRECTORY: the wizard's EMPLOYEES phase (staging only). SYNC: after onboarding. */
  readonly phase: "DIRECTORY" | "SYNC";
  readonly portalId: string;
  /** `employeeDecisionInputs(...)` hashed. */
  readonly hash?: string;
  /** SYNC: employees the plan can still take (Infinity when unlimited); decrement on every IMPORT. */
  readonly capacityRemaining?: number;
}

interface EmployeeDecisionBase {
  /** Write the incoming hash and `last_seen_at` on the map row. */
  readonly writeHash: boolean;
  /**
   * The mapped employee is on the active list again: clear `upstreamMissingSince` and `reviewDismissedAt` and delete
   * a MISSING_IN_PLANDAY pending row.
   */
  readonly clearMissing: boolean;
  readonly warning?: EmployeeWarningCode;
}

export type EmployeeDecision = EmployeeDecisionBase &
  /** Not in scope and not mapped: counted (`excluded.outOfScope`), never persisted; any pending row is deleted. */
  (
    | { readonly action: "OUT_OF_SCOPE"; readonly dropPending: true }
    /** Unmapped, but their dismissal date has passed: never imported; any pending row is deleted. */
    | { readonly action: "IGNORE_DISMISSED"; readonly dropPending: true }
    /** Wizard: upsert `PendingExternalEmployee(reason ONBOARDING)`; MATCH_EMPLOYEES computes the match later. */
    | { readonly action: "STAGE" }
    | { readonly action: "UNCHANGED" }
    | { readonly action: "REHASH_ONLY" }
    | { readonly action: "UPDATE"; readonly update: EmployeeUpdate }
    /** Mapped but no longer in scope: kept as is (never deactivated for it); their excluded shifts are cancelled by §6.6. */
    | { readonly action: "KEEP_OUT_OF_SCOPE" }
    /**
     * Inactive in ClockOff (or deactivated by the sync) and active on Planday's list: the id goes to the run's
     * REACTIVATIONS list (ids only), which `decideReactivation` settles after the deactivation phases of the same
     * run. `update` applies now.
     */
    | { readonly action: "QUEUE_REACTIVATION"; readonly update: EmployeeUpdate | null }
    /** SYNC, new, auto-include on, plan capacity left: `importExternalEmployee`, counted `created`. */
    | { readonly action: "IMPORT"; readonly create: EmployeeCreate }
    /** SYNC, a strong match while auto-include is on: `linkExternalEmployee` (map row, managed, fields). */
    | {
        readonly action: "LINK";
        readonly employeeId: string;
        readonly signal: EmployeeMatchSignal;
        readonly update: EmployeeUpdate | null;
      }
    /** Upsert `PendingExternalEmployee(reason)` with the match columns. */
    | {
        readonly action: "PENDING";
        readonly reason: Exclude<
          PendingExternalEmployeeReason,
          "ONBOARDING" | "MISSING_IN_PLANDAY"
        >;
        readonly match: PendingMatchFields;
      }
  );

function unchangedOrRehash(hash: string | undefined, mapRow: EmployeeMapRow) {
  return hash !== undefined && hash === mapRow.lastHash
    ? ({ action: "UNCHANGED", writeHash: false } as const)
    : ({ action: "REHASH_ONLY", writeHash: true } as const);
}

/**
 * `decideEmployeeAction` — the §6.5 decision table for one person of an EMPLOYEES page.
 *
 * Mapped employees: out of scope → kept as is with EMPLOYEE_OUT_OF_SCOPE; deactivated by the sync and active in
 * Planday again → QUEUE_REACTIVATION; otherwise the managed-field update, or UNCHANGED (hash equal and nothing to
 * change) / REHASH_ONLY (hash differs, nothing to change). A hash match alone never skips a change: the entity must
 * still be in the state the last decision left it in (§6.2 step 3).
 *
 * Unmapped people: out of scope → OUT_OF_SCOPE; wizard → STAGE; SYNC → LINK (strong match, auto-include on),
 * IMPORT (no candidate, auto-include on, capacity left) or PENDING with NEW_EMPLOYEE (auto-include off),
 * PLAN_LIMIT, POSSIBLE_MATCH or AMBIGUOUS_MATCH.
 */
export function decideEmployeeAction(input: EmployeeDecisionInput): EmployeeDecision {
  const { external, match, mapRow, employee, config } = input;
  const targets = resolveEmployeeTargets(external, config);

  if (mapRow && employee) {
    const clearMissing = mapRow.upstreamMissingSince !== null || mapRow.reviewDismissedAt !== null;
    if (input.phase === "DIRECTORY") {
      // The DIRECTORY run only stages: everyone in scope, imported or not (IMPORT_EMPLOYEES writes employees).
      return targets.inScope
        ? { action: "STAGE", writeHash: false, clearMissing }
        : { action: "OUT_OF_SCOPE", dropPending: true, writeHash: false, clearMissing };
    }
    if (!targets.inScope) {
      return {
        action: "KEEP_OUT_OF_SCOPE",
        writeHash: false,
        clearMissing,
        warning: "EMPLOYEE_OUT_OF_SCOPE",
      };
    }
    const update = employeeUpdateFor(external, targets, employee, config);
    if (
      external.active &&
      (mapRow.upstreamRemovedAt !== null || employee.employmentStatus === "INACTIVE")
    ) {
      // `decideReactivation` settles it after the deactivation phases: reactivate (deactivated by the sync),
      // keep inactive with a warning (deactivated by a manager) or only clear `upstreamRemovedAt`.
      return { action: "QUEUE_REACTIVATION", update, writeHash: true, clearMissing };
    }
    if (update) return { action: "UPDATE", update, writeHash: true, clearMissing };
    return { ...unchangedOrRehash(input.hash, mapRow), clearMissing };
  }

  // Not mapped (or the map row's employee is gone): never persisted unless in scope.
  if (!targets.inScope) {
    return { action: "OUT_OF_SCOPE", dropPending: true, writeHash: false, clearMissing: false };
  }
  if (!external.active) {
    return { action: "IGNORE_DISMISSED", dropPending: true, writeHash: false, clearMissing: false };
  }
  if (input.phase === "DIRECTORY")
    return { action: "STAGE", writeHash: false, clearMissing: false };

  switch (match.kind) {
    case "MAPPED":
    case "MATCHED": {
      if (!config.autoIncludeNewEmployees) {
        return {
          action: "PENDING",
          reason: "NEW_EMPLOYEE",
          match: pendingMatchFields(match),
          writeHash: false,
          clearMissing: false,
        };
      }
      const signal = match.kind === "MATCHED" ? match.signal : "EXTERNAL_ID";
      const update =
        employee && employee.id === match.employeeId
          ? employeeUpdateFor(external, targets, employee, config, {
              link: { portalId: input.portalId },
            })
          : null;
      return {
        action: "LINK",
        employeeId: match.employeeId,
        signal,
        update,
        writeHash: true,
        clearMissing: false,
      };
    }
    case "POSSIBLE_MATCH":
      return {
        action: "PENDING",
        reason: "POSSIBLE_MATCH",
        match: pendingMatchFields(match),
        writeHash: false,
        clearMissing: false,
      };
    case "AMBIGUOUS":
      return {
        action: "PENDING",
        reason: "AMBIGUOUS_MATCH",
        match: pendingMatchFields(match),
        writeHash: false,
        clearMissing: false,
      };
    case "NONE": {
      if (!config.autoIncludeNewEmployees) {
        return {
          action: "PENDING",
          reason: "NEW_EMPLOYEE",
          match: pendingMatchFields(match),
          writeHash: false,
          clearMissing: false,
        };
      }
      if ((input.capacityRemaining ?? Number.POSITIVE_INFINITY) <= 0) {
        return {
          action: "PENDING",
          reason: "PLAN_LIMIT",
          match: pendingMatchFields(match),
          writeHash: false,
          clearMissing: false,
        };
      }
      return {
        action: "IMPORT",
        create: employeeCreateFor(external, targets, config, input.portalId),
        writeHash: true,
        clearMissing: false,
      };
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// APPLY_EMPLOYEES (IMPORT_EMPLOYEES run): staged rows + the manager's step 5 choices
// ---------------------------------------------------------------------------------------------------------

/** Step 5 selection (`plandayEmployeeSelectionSchema`). */
export interface EmployeeSelection {
  readonly mode: "ALL_EXCEPT" | "ONLY";
  readonly externalIds: readonly string[];
}

/** A step 5 resolution for one person (`plandayEmployeeResolutionSchema`). */
export type EmployeeResolution =
  | { readonly action: "LINK"; readonly employeeId: string }
  | { readonly action: "CREATE" }
  | { readonly action: "EXCLUDE" };

export function isEmployeeSelected(selection: EmployeeSelection, externalId: string): boolean {
  const listed = asSet(selection.externalIds).has(externalId);
  return selection.mode === "ALL_EXCEPT" ? !listed : listed;
}

export interface ImportDecisionInput {
  readonly externalId: string;
  /** The staged row's match (`matchFromPendingFields`). */
  readonly match: EmployeeMatch;
  readonly selection: EmployeeSelection;
  readonly resolution: EmployeeResolution | null;
  /** An EMPLOYEE map row already exists (imported by an earlier save of step 5). */
  readonly mapped: boolean;
  /** Employees the plan can still take (Infinity when unlimited); decrement on every IMPORT. */
  readonly capacityRemaining: number;
}

export type ImportDecision =
  /** Append the id to `excludedEmployeeIds`; delete the pending row. */
  | { readonly action: "EXCLUDE" }
  /** Already imported or linked: apply the managed fields (`employeeUpdateFor`); delete the pending row. */
  | { readonly action: "ALREADY_LINKED" }
  /** `importExternalEmployee`; delete the pending row; record the id in `employeesImport.createdIds`. */
  | { readonly action: "IMPORT" }
  /** `linkExternalEmployee`; delete the pending row; record the id in `employeesImport.linkedIds`. */
  | {
      readonly action: "LINK";
      readonly employeeId: string;
      readonly signal: EmployeeMatchSignal | null;
    }
  /** Selected but not importable now: the row stays pending with this reason. */
  | { readonly action: "PENDING"; readonly reason: "PLAN_LIMIT" | "AMBIGUOUS_MATCH" };

/**
 * One staged person at the IMPORT_EMPLOYEES run's APPLY_EMPLOYEES phase (§6.5): unticked or excluded → EXCLUDE;
 * an explicit LINK / CREATE wins; otherwise a strong match links, a possible match is created (step 5's default for
 * "possible match: confirm" is Create), an unresolved ambiguous row stays pending (it is never merged), and a new
 * person is imported while the plan has room.
 */
export function decideImportAction(input: ImportDecisionInput): ImportDecision {
  if (
    !isEmployeeSelected(input.selection, input.externalId) ||
    input.resolution?.action === "EXCLUDE"
  ) {
    return { action: "EXCLUDE" };
  }
  if (input.mapped || input.match.kind === "MAPPED") return { action: "ALREADY_LINKED" };
  const create = (): ImportDecision =>
    input.capacityRemaining > 0
      ? { action: "IMPORT" }
      : { action: "PENDING", reason: "PLAN_LIMIT" };
  const resolution = input.resolution;
  if (resolution?.action === "LINK") {
    const match = input.match;
    const signal =
      (match.kind === "MATCHED" || match.kind === "POSSIBLE_MATCH") &&
      match.employeeId === resolution.employeeId
        ? match.signal
        : null;
    return { action: "LINK", employeeId: resolution.employeeId, signal };
  }
  if (resolution?.action === "CREATE") return create();
  switch (input.match.kind) {
    case "MATCHED":
      return { action: "LINK", employeeId: input.match.employeeId, signal: input.match.signal };
    case "AMBIGUOUS":
      return { action: "PENDING", reason: "AMBIGUOUS_MATCH" };
    case "POSSIBLE_MATCH":
    case "NONE":
      return create();
  }
}

// ---------------------------------------------------------------------------------------------------------
// Deactivation evidence: DEACTIVATED_EMPLOYEES and ABSENT_EMPLOYEES (EMPLOYEE_STATUS batches)
// ---------------------------------------------------------------------------------------------------------

/**
 * One EMPLOYEE_STATUS record as the provider reports it:
 * - DEACTIVATED: on `/employees/deactivated` with `deactivationDate` null or passed, or a by-id read with
 *   `isDeactivated: true` and the date passed (positive evidence);
 * - ACTIVE: on `/employees/deactivated` with a future date, or a by-id read whose body is still active;
 * - REMOVED: a by-id read answered 400 / 404 (record-level skip, Q24).
 */
export type EmployeeStatusEvidence = "DEACTIVATED" | "ACTIVE" | "REMOVED";

export type EmployeeStatusDecision =
  /** Not ours (unmapped): nothing. With `dropPending`, a pending row for the person is deleted. */
  | { readonly action: "IGNORE"; readonly dropPending: boolean }
  | { readonly action: "UNCHANGED"; readonly warning?: EmployeeWarningCode }
  /**
   * `deactivateManagedEmployee` (as `deactivateEmployee` with a SYSTEM actor), map row `upstreamRemovedAt = now`,
   * `upstreamMissingSince` cleared.
   */
  | {
      readonly action: "DEACTIVATE";
      readonly reason: "DEACTIVATED_IN_PLANDAY" | "REMOVED_FROM_PLANDAY";
    }
  /** No positive evidence: warning EMPLOYEE_NOT_VISIBLE, map row `upstreamMissingSince` set if null; devices untouched. */
  | {
      readonly action: "MARK_MISSING";
      readonly setMissingSince: boolean;
      readonly warning: "EMPLOYEE_NOT_VISIBLE";
    };

/**
 * The §6.5 deactivation rows for one status record. Deactivation needs positive evidence (D-045): only DEACTIVATED
 * deactivates; a future dismissal (ACTIVE from the deactivated list) changes nothing; anything else from a by-id read
 * only flags the person missing.
 */
export function decideEmployeeStatusAction(input: {
  readonly phase: "DEACTIVATED_EMPLOYEES" | "ABSENT_EMPLOYEES";
  readonly status: EmployeeStatusEvidence;
  readonly mapRow: EmployeeMapRow | null;
  readonly employee: Pick<ExistingEmployee, "employmentStatus"> | null;
}): EmployeeStatusDecision {
  const { phase, status, mapRow, employee } = input;
  if (!mapRow || !employee) return { action: "IGNORE", dropPending: status === "DEACTIVATED" };
  if (status === "DEACTIVATED") {
    if (employee.employmentStatus === "INACTIVE") return { action: "UNCHANGED" };
    return {
      action: "DEACTIVATE",
      reason: phase === "DEACTIVATED_EMPLOYEES" ? "DEACTIVATED_IN_PLANDAY" : "REMOVED_FROM_PLANDAY",
    };
  }
  if (phase === "DEACTIVATED_EMPLOYEES") {
    // Listed with a future date: caught once the date has passed (Q23).
    return status === "ACTIVE"
      ? { action: "UNCHANGED", warning: "DEACTIVATION_SCHEDULED" }
      : { action: "UNCHANGED" };
  }
  return {
    action: "MARK_MISSING",
    setMissingSince: mapRow.upstreamMissingSince === null,
    warning: "EMPLOYEE_NOT_VISIBLE",
  };
}

/** Whether a missing employee is due for the MISSING_IN_PLANDAY review (24 h without evidence, not dismissed). */
export function shouldQueueMissingReview(
  mapRow: Pick<EmployeeMapRow, "upstreamMissingSince" | "reviewDismissedAt">,
  now: Date,
): boolean {
  return (
    mapRow.upstreamMissingSince !== null &&
    mapRow.reviewDismissedAt === null &&
    now.getTime() - mapRow.upstreamMissingSince.getTime() >= MISSING_EMPLOYEE_REVIEW_AFTER_MS
  );
}

/**
 * Ids to re-check by id in ABSENT_EMPLOYEES (§6.5): mapped, active in ClockOff, not seen on `/employees` in this
 * run and not on this run's deactivated list; at most ABSENT_EMPLOYEE_RECHECK_LIMIT (the rest wait for the next run).
 */
export function selectAbsentEmployeeRechecks(input: {
  readonly mapped: ReadonlyArray<{
    readonly externalId: string;
    readonly employmentStatus: EmploymentStatus;
  }>;
  readonly seenExternalIds: Iterable<string>;
  readonly listedDeactivatedIds: Iterable<string>;
  readonly limit?: number;
}): string[] {
  const seen = new Set(input.seenExternalIds);
  const listed = new Set(input.listedDeactivatedIds);
  const limit = input.limit ?? ABSENT_EMPLOYEE_RECHECK_LIMIT;
  return input.mapped
    .filter(
      (row) =>
        row.employmentStatus === "ACTIVE" &&
        !seen.has(row.externalId) &&
        !listed.has(row.externalId),
    )
    .map((row) => row.externalId)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------------------------------------
// REACTIVATIONS (database only, after both deactivation phases of the same run)
// ---------------------------------------------------------------------------------------------------------

export type ReactivationDecision =
  /** `reactivateManagedEmployee`: ACTIVE, invite status recomputed, EMPLOYEE_REACTIVATED; `upstreamRemovedAt` cleared. */
  | { readonly action: "REACTIVATE" }
  /** Nothing (not mapped any more, or this run's deactivation phases listed the person as deactivated). */
  | { readonly action: "SKIP"; readonly reason: "NOT_MAPPED" | "LISTED_DEACTIVATED" }
  /** Already active in ClockOff (a manager reactivated): only `upstreamRemovedAt` is cleared. */
  | { readonly action: "CLEAR_REMOVED" }
  /** Deactivated by a manager in ClockOff: left inactive, with a warning. */
  | { readonly action: "KEEP_INACTIVE"; readonly warning: "EMPLOYEE_INACTIVE_IN_CLOCKOFF" };

/**
 * One id from the run's REACTIVATIONS list. An id this run's DEACTIVATED_EMPLOYEES or ABSENT_EMPLOYEES phase listed
 * as deactivated (date passed) is skipped, so a person on both lists never alternates (§6.5).
 */
export function decideReactivation(input: {
  readonly mapRow: Pick<EmployeeMapRow, "upstreamRemovedAt"> | null;
  readonly employee: Pick<ExistingEmployee, "employmentStatus"> | null;
  /** Listed as DEACTIVATED by this run's deactivation phases. */
  readonly listedDeactivated: boolean;
}): ReactivationDecision {
  if (!input.mapRow || !input.employee) return { action: "SKIP", reason: "NOT_MAPPED" };
  if (input.listedDeactivated) return { action: "SKIP", reason: "LISTED_DEACTIVATED" };
  if (input.employee.employmentStatus === "ACTIVE") return { action: "CLEAR_REMOVED" };
  if (input.mapRow.upstreamRemovedAt === null) {
    return { action: "KEEP_INACTIVE", warning: "EMPLOYEE_INACTIVE_IN_CLOCKOFF" };
  }
  return { action: "REACTIVATE" };
}
