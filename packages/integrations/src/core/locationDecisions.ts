import { normaliseName } from "@clockoff/shared/csv/matchEmployee";

/**
 * Departments → locations and employee groups → teams (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §6.3,
 * §6.4). Pure decision functions: the apply sink (apps/web) loads the map rows and ClockOff rows for a batch,
 * calls these per record in memory and performs only the writes they ask for. Nothing here reads a clock, a
 * database or the network.
 *
 * Vocabulary: a "department key" is a Planday department id (decimal string) or {@link NO_DEPARTMENT_ID} for
 * people and shifts outside every department (§6.3: departments are optional per portal).
 */

/** Pseudo department for "not in any department": employees with an empty `departments[]`, shifts with no `departmentId`. */
export const NO_DEPARTMENT_ID = "none";

/** Where an included department goes (`IntegrationMappingConfig.departmentMappings` value). */
export type DepartmentMappingTarget =
  | { readonly target: "LOCATION"; readonly locationId: string }
  | { readonly target: "DEPARTMENT"; readonly departmentId: string };

/** `IntegrationMappingConfig.groupMappings` value: a group is mapped to a team, or not listed. */
export interface GroupMappingTarget {
  readonly target: "TEAM";
  readonly teamId: string;
}

export type DepartmentMappings = Readonly<Record<string, DepartmentMappingTarget>>;
export type GroupMappings = Readonly<Record<string, GroupMappingTarget>>;

/** The department key of one shift (`departmentId` null → "none"). */
export function departmentKeyOf(externalDepartmentId: string | null | undefined): string {
  return externalDepartmentId ? externalDepartmentId : NO_DEPARTMENT_ID;
}

/** The department keys of one employee: their departments, or `["none"]` when they have none. */
export function departmentKeysOf(
  externalDepartmentIds: readonly string[] | null | undefined,
): string[] {
  const ids = [...new Set(externalDepartmentIds ?? [])];
  return ids.length > 0 ? ids : [NO_DEPARTMENT_ID];
}

/**
 * Whether the catalogue needs the "Not in any department" row (§6.3): when some employees have no department, or
 * the portal has no departments at all (then it maps to one location instead of importing nobody).
 */
export function needsNoDepartmentRow(input: {
  readonly departmentCount: number;
  readonly unassignedEmployeeCount: number | null;
}): boolean {
  return input.departmentCount === 0 || (input.unassignedEmployeeCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------------------------------------
// Wizard step 3 suggestion (§6.3, first row)
// ---------------------------------------------------------------------------------------------------------

export type DepartmentSuggestion =
  | { readonly target: "NEW_LOCATION"; readonly name: string }
  | { readonly target: "LOCATION"; readonly locationId: string };

/** Case- and whitespace-insensitive name comparison (NFKC, lower case, single spaces). */
export function sameName(a: string, b: string): boolean {
  return normaliseName(a) === normaliseName(b);
}

/**
 * The default choice for one catalogue row: a new location named like the department (the "none" row: named
 * after the portal), unless an existing ClockOff location already has that name, which is suggested instead.
 * The new location's time zone is the portal's (department zones are not readable, §6.7).
 */
export function suggestDepartmentTarget(
  department: { readonly externalId: string; readonly name: string },
  existingLocations: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  options: { readonly portalName: string },
): DepartmentSuggestion {
  const name =
    department.externalId === NO_DEPARTMENT_ID ? options.portalName.trim() : department.name.trim();
  const existing = existingLocations.find((location) => sameName(location.name, name));
  return existing
    ? { target: "LOCATION", locationId: existing.id }
    : { target: "NEW_LOCATION", name };
}

// ---------------------------------------------------------------------------------------------------------
// Catalogue (STRUCTURE runs write the catalogue only, §6.3)
// ---------------------------------------------------------------------------------------------------------

/** The fields of a catalogue entry this module maintains (`plandayCatalogSchema` entries carry more). */
export interface CatalogEntry {
  readonly externalId: string;
  readonly name: string;
  readonly number?: string | null;
  /** ISO instant the entry was first seen. */
  readonly firstSeenAt: string;
  /** The last complete read no longer returned it. */
  readonly missing: boolean;
}

/**
 * Merges one page of departments or groups into the catalogue: new ids are appended (`added`; after onboarding they
 * stay excluded and OWNER/ADMIN are told, §6.3 "New department after onboarding"), names and numbers are refreshed,
 * and a seen entry is no longer missing. Entries keep any other field the caller stores on them.
 */
export function mergeCatalogPage<E extends CatalogEntry>(
  entries: readonly E[],
  records: ReadonlyArray<{
    readonly externalId: string;
    readonly name: string;
    readonly number?: string | null;
  }>,
  now: Date,
  create: (record: {
    externalId: string;
    name: string;
    number: string | null;
    firstSeenAt: string;
  }) => E,
): { readonly entries: E[]; readonly added: string[] } {
  const byId = new Map(entries.map((entry) => [entry.externalId, entry] as const));
  const next = [...entries];
  const added: string[] = [];
  for (const record of records) {
    const existing = byId.get(record.externalId);
    if (!existing) {
      const created = create({
        externalId: record.externalId,
        name: record.name,
        number: record.number ?? null,
        firstSeenAt: now.toISOString(),
      });
      byId.set(record.externalId, created);
      next.push(created);
      added.push(record.externalId);
      continue;
    }
    const updated: E = {
      ...existing,
      name: record.name,
      ...("number" in record ? { number: record.number ?? null } : {}),
      missing: false,
    };
    next[next.indexOf(existing)] = updated;
    byId.set(record.externalId, updated);
  }
  return { entries: next, added };
}

/**
 * At the end of a complete read: entries whose id was not seen are marked missing (never removed, notes §11) and
 * returned in `missing` (newly missing only, for the DEPARTMENT_MISSING warning). The "none" row is never missing.
 */
export function markMissingCatalogEntries<E extends CatalogEntry>(
  entries: readonly E[],
  seenIds: Iterable<string>,
): { readonly entries: E[]; readonly missing: string[] } {
  const seen = new Set(seenIds);
  const missing: string[] = [];
  const next = entries.map((entry) => {
    if (entry.externalId === NO_DEPARTMENT_ID || seen.has(entry.externalId)) return entry;
    if (!entry.missing) missing.push(entry.externalId);
    return { ...entry, missing: true };
  });
  return { entries: next, missing };
}

// ---------------------------------------------------------------------------------------------------------
// Departments → locations (§6.3)
// ---------------------------------------------------------------------------------------------------------

/** The map row of a department (`ExternalEntityMap` LOCATION or DEPARTMENT) or a group (TEAM). */
export interface StructureMapRow<T extends string> {
  readonly entityType: T;
  readonly internalId: string;
  readonly lastHash: string | null;
  readonly upstreamRemovedAt: Date | null;
}

/** A ClockOff location or team a mapping or map row points to. */
export interface StructureTargetRow {
  readonly id: string;
  readonly name: string;
  /** Set when this integration created (and therefore manages) the row. */
  readonly managedByIntegrationId: string | null;
  /** Soft-deleted (or gone): the mapping points nowhere usable. */
  readonly deleted?: boolean;
}

/**
 * A department's mapping as the apply step sees it: a stored target (`LOCATION` / `DEPARTMENT`), or the wizard's
 * step 3 / settings choice to create a location (`NEW_LOCATION`, applied in the request before it is stored as
 * `LOCATION`).
 */
export type DepartmentMappingInput =
  DepartmentMappingTarget | { readonly target: "NEW_LOCATION"; readonly name?: string };

export interface DepartmentDecisionInput {
  /** The department as Planday returned it; null when a complete department list no longer contains it. */
  readonly department: { readonly externalId: string; readonly name: string } | null;
  /** In `includedDepartmentIds`. */
  readonly included: boolean;
  /** Its mapping (included departments only); null when it has none. */
  readonly mapping: DepartmentMappingInput | null;
  readonly mapRow: StructureMapRow<"LOCATION" | "DEPARTMENT"> | null;
  /**
   * The ClockOff location the mapping points to (a `LOCATION` target), else the one the map row points to; null for
   * a ClockOff department target or when nothing exists yet.
   */
  readonly location: StructureTargetRow | null;
  readonly integrationId: string;
  /** The portal's IANA zone: a created location's time zone (§6.7). */
  readonly portalTimezone: string;
  /** `departmentDecisionInputs(...)` hashed; compared with `mapRow.lastHash`. */
  readonly hash?: string;
  /**
   * The provider's display name ("Planday"). A managed location whose name another live location had already taken
   * was given a suffixed name ("Bar (Planday)", "Bar (Planday 2)"); with this, that name counts as the department's
   * name, so the decision settles instead of asking for the same rename on every run. Absent: exact names only.
   */
  readonly providerName?: string;
}

/**
 * Whether `current` is `desired`, or the provider-suffixed variant a rename gives when `desired` is taken by another
 * live location (`"<desired> (<providerName>)"`, `"<desired> (<providerName> <n>)"`, n ≥ 2).
 */
export function isManagedLocationName(
  current: string,
  desired: string,
  providerName?: string,
): boolean {
  if (current === desired) return true;
  if (!providerName) return false;
  const prefix = `${desired} (${providerName}`;
  if (!current.startsWith(prefix) || !current.endsWith(")")) return false;
  const rest = current.slice(prefix.length, -1);
  return rest === "" || /^ [2-9]$|^ [1-9]\d+$/.test(rest);
}

export type StructureWarningCode =
  | "DEPARTMENT_MISSING"
  | "GROUP_MISSING"
  | "DEPARTMENT_UNMAPPED"
  | "DEPARTMENT_TARGET_MISSING"
  | "GROUP_TARGET_MISSING";

interface StructureDecisionBase {
  /** Write the incoming hash and `last_seen_at` on the map row. */
  readonly writeHash: boolean;
  /** Clear the map row's `upstreamRemovedAt` (the record is back on a complete list). */
  readonly clearMissing: boolean;
  readonly warning?: StructureWarningCode;
}

export type DepartmentDecision = StructureDecisionBase &
  (
    | { readonly action: "IGNORE" }
    | { readonly action: "UNCHANGED" }
    | { readonly action: "REHASH_ONLY" }
    /** Create `Location { name, timezone, source: INTEGRATION, managedByIntegrationId }`, its LOCATION map row, and store the mapping `{ target: "LOCATION", locationId }`. */
    | { readonly action: "CREATE_LOCATION"; readonly name: string; readonly timezone: string }
    /** Create (or, with `replacesMapRow`, repoint) the map row. The target is not marked managed. */
    | {
        readonly action: "LINK";
        readonly entityType: "LOCATION" | "DEPARTMENT";
        readonly internalId: string;
        readonly replacesMapRow: boolean;
      }
    /** Rename the managed location (also used to apply a new-location name chosen in settings). */
    | { readonly action: "RENAME_LOCATION"; readonly locationId: string; readonly name: string }
    /** Set the map row's `upstreamRemovedAt`; the location is kept (never deleted). */
    | { readonly action: "MARK_MISSING" }
  );

function noChange(hash: string | undefined, lastHash: string | null | undefined) {
  return hash !== undefined && lastHash !== undefined && hash === lastHash
    ? ({ action: "UNCHANGED", writeHash: false } as const)
    : ({ action: "REHASH_ONLY", writeHash: true } as const);
}

/**
 * The §6.3 table for one department of a SYNC run's DEPARTMENTS phase or of a wizard step 3 / settings save:
 * create, link, rename, mark missing or nothing. Rows that point at a manager's existing location are never
 * renamed or marked managed; a missing department is only flagged (never deleted).
 */
export function decideDepartmentAction(input: DepartmentDecisionInput): DepartmentDecision {
  const { department, mapRow, location } = input;
  if (department === null) {
    if (!mapRow) return { action: "IGNORE", writeHash: false, clearMissing: false };
    if (mapRow.upstreamRemovedAt) {
      return {
        action: "UNCHANGED",
        writeHash: false,
        clearMissing: false,
        warning: "DEPARTMENT_MISSING",
      };
    }
    return {
      action: "MARK_MISSING",
      writeHash: false,
      clearMissing: false,
      warning: "DEPARTMENT_MISSING",
    };
  }
  const clearMissing = mapRow?.upstreamRemovedAt != null;
  if (!input.included) return { action: "IGNORE", writeHash: false, clearMissing };
  const mapping = input.mapping;
  if (!mapping) {
    return { action: "IGNORE", writeHash: false, clearMissing, warning: "DEPARTMENT_UNMAPPED" };
  }

  if (mapping.target === "NEW_LOCATION") {
    const name = (mapping.name ?? department.name).trim() || department.name;
    const managed =
      mapRow?.entityType === "LOCATION" &&
      location !== null &&
      location.id === mapRow.internalId &&
      !location.deleted &&
      location.managedByIntegrationId === input.integrationId;
    if (!managed) {
      return {
        action: "CREATE_LOCATION",
        name,
        timezone: input.portalTimezone,
        writeHash: true,
        clearMissing,
      };
    }
    if (!isManagedLocationName(location.name, name, input.providerName)) {
      return {
        action: "RENAME_LOCATION",
        locationId: location.id,
        name,
        writeHash: true,
        clearMissing,
      };
    }
    return { ...noChange(input.hash, mapRow.lastHash), clearMissing };
  }

  const entityType = mapping.target;
  const internalId = mapping.target === "LOCATION" ? mapping.locationId : mapping.departmentId;
  if (
    mapping.target === "LOCATION" &&
    (location === null || location.deleted || location.id !== internalId)
  ) {
    return {
      action: "IGNORE",
      writeHash: false,
      clearMissing,
      warning: "DEPARTMENT_TARGET_MISSING",
    };
  }
  if (!mapRow || mapRow.entityType !== entityType || mapRow.internalId !== internalId) {
    return {
      action: "LINK",
      entityType,
      internalId,
      replacesMapRow: mapRow !== null,
      writeHash: true,
      clearMissing,
    };
  }
  if (
    mapping.target === "LOCATION" &&
    location !== null &&
    location.managedByIntegrationId === input.integrationId &&
    !isManagedLocationName(location.name, department.name.trim(), input.providerName)
  ) {
    return {
      action: "RENAME_LOCATION",
      locationId: location.id,
      name: department.name.trim(),
      writeHash: true,
      clearMissing,
    };
  }
  return { ...noChange(input.hash, mapRow.lastHash), clearMissing };
}

/** The decision inputs hashed into a department's `lastHash` (§6.2): the record and its mapping entry. */
export function departmentDecisionInputs(
  department: { readonly externalId: string; readonly name: string },
  included: boolean,
  mapping: DepartmentMappingInput | null,
): Record<string, unknown> {
  return {
    v: 1,
    kind: "DEPARTMENT",
    record: { externalId: department.externalId, name: department.name.trim() },
    included,
    mapping: included ? mapping : null,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Employee groups → teams (§6.4)
// ---------------------------------------------------------------------------------------------------------

export type GroupMappingInput = GroupMappingTarget | { readonly target: "NEW_TEAM" };

export interface GroupDecisionInput {
  /** The group as Planday returned it; null when a complete group list no longer contains it. */
  readonly group: { readonly externalId: string; readonly name: string } | null;
  /** Its mapping; null when the group is not mapped to a team (ignored). */
  readonly mapping: GroupMappingInput | null;
  readonly mapRow: StructureMapRow<"TEAM"> | null;
  /** The ClockOff team the mapping points to, else the one the map row points to. */
  readonly team: StructureTargetRow | null;
  readonly integrationId: string;
  readonly hash?: string;
}

export type GroupDecision = StructureDecisionBase &
  (
    | { readonly action: "IGNORE" }
    | { readonly action: "UNCHANGED" }
    | { readonly action: "REHASH_ONLY" }
    /** Create `Team { name, source: INTEGRATION, managedByIntegrationId }` and its TEAM map row. */
    | { readonly action: "CREATE_TEAM"; readonly name: string }
    | { readonly action: "LINK"; readonly internalId: string; readonly replacesMapRow: boolean }
    | { readonly action: "RENAME_TEAM"; readonly teamId: string; readonly name: string }
    | { readonly action: "MARK_MISSING" }
  );

/** The §6.4 table for one employee group (rename and missing as for departments). */
export function decideGroupAction(input: GroupDecisionInput): GroupDecision {
  const { group, mapRow, team } = input;
  if (group === null) {
    if (!mapRow) return { action: "IGNORE", writeHash: false, clearMissing: false };
    return {
      action: mapRow.upstreamRemovedAt ? "UNCHANGED" : "MARK_MISSING",
      writeHash: false,
      clearMissing: false,
      warning: "GROUP_MISSING",
    };
  }
  const clearMissing = mapRow?.upstreamRemovedAt != null;
  const mapping = input.mapping;
  if (!mapping) return { action: "IGNORE", writeHash: false, clearMissing };
  const name = group.name.trim();

  if (mapping.target === "NEW_TEAM") {
    const managed =
      mapRow !== null &&
      team !== null &&
      team.id === mapRow.internalId &&
      !team.deleted &&
      team.managedByIntegrationId === input.integrationId;
    if (!managed) return { action: "CREATE_TEAM", name, writeHash: true, clearMissing };
    if (team.name !== name) {
      return { action: "RENAME_TEAM", teamId: team.id, name, writeHash: true, clearMissing };
    }
    return { ...noChange(input.hash, mapRow.lastHash), clearMissing };
  }

  if (team === null || team.deleted || team.id !== mapping.teamId) {
    return { action: "IGNORE", writeHash: false, clearMissing, warning: "GROUP_TARGET_MISSING" };
  }
  if (!mapRow || mapRow.internalId !== mapping.teamId) {
    return {
      action: "LINK",
      internalId: mapping.teamId,
      replacesMapRow: mapRow !== null,
      writeHash: true,
      clearMissing,
    };
  }
  if (team.managedByIntegrationId === input.integrationId && team.name !== name) {
    return { action: "RENAME_TEAM", teamId: team.id, name, writeHash: true, clearMissing };
  }
  return { ...noChange(input.hash, mapRow.lastHash), clearMissing };
}

/** The decision inputs hashed into a group's `lastHash` (§6.2): the record and its mapping entry. */
export function groupDecisionInputs(
  group: { readonly externalId: string; readonly name: string },
  mapping: GroupMappingInput | null,
): Record<string, unknown> {
  return {
    v: 1,
    kind: "GROUP",
    record: { externalId: group.externalId, name: group.name.trim() },
    mapping,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Memberships (§6.4 "Membership", §6.5 "memberships of mapped locations and teams")
// ---------------------------------------------------------------------------------------------------------

/**
 * Membership changes for one employee: rows for every desired target that is missing are added, and rows for
 * **managed** targets (teams / locations that some group / department maps to) the employee no longer has are
 * removed. Rows of unmapped (ClockOff-only) teams and locations are never touched, so team overrides stay editable.
 */
export function decideMemberships(input: {
  readonly desired: readonly string[];
  readonly current: readonly string[];
  readonly managed: Iterable<string>;
}): { readonly add: string[]; readonly remove: string[] } {
  const desired = new Set(input.desired);
  const current = new Set(input.current);
  const managed = new Set(input.managed);
  const add = [...desired].filter((id) => !current.has(id)).sort();
  const remove = [...current].filter((id) => managed.has(id) && !desired.has(id)).sort();
  return { add, remove };
}

/** Every ClockOff location some included department maps to (the managed set for location memberships). */
export function mappedLocationIds(
  departmentMappings: DepartmentMappings,
  includedDepartmentIds?: readonly string[],
): string[] {
  const included = includedDepartmentIds ? new Set(includedDepartmentIds) : null;
  const ids = new Set<string>();
  for (const [key, target] of Object.entries(departmentMappings)) {
    if (included && !included.has(key)) continue;
    if (target.target === "LOCATION") ids.add(target.locationId);
  }
  return [...ids].sort();
}

/** Every ClockOff team some group maps to (the managed set for team memberships). */
export function mappedTeamIds(groupMappings: GroupMappings): string[] {
  return [...new Set(Object.values(groupMappings).map((target) => target.teamId))].sort();
}
