/**
 * React Query keys for locations, departments and teams. They deliberately match the reference-list keys the
 * employee and policy pages already use (`["org", "<resource>", "list"]`, caching the full list response) so a
 * change made here refreshes every select and picker that shows the same data, and vice versa. Organisation-
 * scoped keys start with "org" (see `queryKeys` in `@/lib/query-client`).
 */
export const locationKeys = {
  all: ["org", "locations"] as const,
  list: ["org", "locations", "list"] as const,
} as const;

export const departmentKeys = {
  all: ["org", "departments"] as const,
  list: ["org", "departments", "list"] as const,
} as const;

export const teamKeys = {
  all: ["org", "teams"] as const,
  list: ["org", "teams", "list"] as const,
} as const;

/** A team's members come from `GET /api/employees?teamId=`; kept under the employees prefix so employee edits refresh it. */
export const teamMemberKeys = {
  members: (teamId: string) => ["org", "employees", "team-members", teamId] as const,
} as const;
