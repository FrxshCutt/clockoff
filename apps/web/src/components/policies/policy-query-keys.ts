import type { BreakPolicyQuery } from "@clockoff/validation/breakPolicies";
import type { PolicyQuery } from "@clockoff/validation/policies";

/**
 * React Query keys for Work Policies, Break Policies and the things they can be assigned to. Organisation-scoped
 * keys start with "org" (same convention as `queryKeys` in `@/lib/query-client`) so switching organisation
 * clears them together.
 */
export const policyQueryKeys = {
  all: ["org", "policies"] as const,
  list: (query: PolicyQuery = {}) => ["org", "policies", "list", query] as const,
  detail: (id: string) => ["org", "policies", "detail", id] as const,
  versions: (id: string) => ["org", "policies", "versions", id] as const,
  assignments: (id: string) => ["org", "policies", "assignments", id] as const,
} as const;

export const breakPolicyQueryKeys = {
  all: ["org", "break-policies"] as const,
  list: (query: BreakPolicyQuery = {}) => ["org", "break-policies", "list", query] as const,
  detail: (id: string) => ["org", "break-policies", "detail", id] as const,
  assignments: (id: string) => ["org", "break-policies", "assignments", id] as const,
} as const;

/** Locations, teams and employee search results used by the assignment panels. */
export const assignmentTargetQueryKeys = {
  locations: ["org", "locations", "list"] as const,
  teams: ["org", "teams", "list"] as const,
  employeeSearch: (search: string) => ["org", "employees", "search", search] as const,
} as const;
