import type { AssignmentScopeType } from "../enums";
import type { ResolvedFrom } from "./types";

/** Human labels for scope types, used by the dashboard's "Resolved from" badge. */
export const SCOPE_TYPE_LABELS: Record<AssignmentScopeType, string> = {
  EMPLOYEE: "Employee",
  TEAM: "Team",
  LOCATION: "Location",
  ORGANISATION: "Organisation",
};

/** Either a prebuilt `id → name` map or a function; both may simply not know an id. */
export type NameLookup = Readonly<Record<string, string>> | ((id: string) => string | null | undefined);

/** Optional name lookups per scope type, e.g. `{ TEAM: teamNamesById, LOCATION: (id) => locations.get(id)?.name }`. */
export type ScopeNameLookups = Partial<Record<AssignmentScopeType, NameLookup>>;

function lookupName(lookup: NameLookup | undefined, id: string): string | null {
  if (lookup === undefined) return null;
  const name = typeof lookup === "function" ? lookup(id) : lookup[id];
  return name === undefined || name === null || name.trim() === "" ? null : name;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`);
}

/**
 * One-line, manager-facing explanation of a resolution, e.g. `Resolved from Team: Front of House`,
 * `Resolved from Organisation default: Acme Coffee`, or `No policy resolved`.
 */
export function explainResolution(result: { resolvedFrom: ResolvedFrom | null }, names?: ScopeNameLookups): string {
  const from = result.resolvedFrom;
  if (from === null) return "No policy resolved";

  const name = lookupName(names?.[from.scopeType], from.scopeId);
  const suffix = name === null ? "" : `: ${name}`;
  switch (from.via) {
    case "ASSIGNMENT":
      return `Resolved from ${SCOPE_TYPE_LABELS[from.scopeType]}${suffix}`;
    case "DEFAULT":
      return `Resolved from Organisation default${suffix}`;
    default:
      return assertNever(from);
  }
}
