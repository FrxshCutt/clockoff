import type { EmployeeListParams } from "./employee-filters";

/**
 * React Query keys for the employee domain. Organisation-scoped keys start with "org" (see
 * `queryKeys` in `@/lib/query-client`) so switching organisation clears them together.
 */
export const employeeKeys = {
  all: ["org", "employees"] as const,
  list: (params: EmployeeListParams) => ["org", "employees", "list", params] as const,
  picker: (search: string) => ["org", "employees", "picker", search] as const,
  detail: (id: string) => ["org", "employees", "detail", id] as const,
  state: (id: string, window: { from: string; to: string } | null) =>
    ["org", "employees", "state", id, window] as const,
  shifts: (id: string, params: Readonly<Record<string, unknown>>) =>
    ["org", "employees", "shifts", id, params] as const,
  activity: (id: string, params: Readonly<Record<string, unknown>>) =>
    ["org", "employees", "activity", id, params] as const,
} as const;

export const overrideKeys = {
  all: ["org", "overrides"] as const,
  list: (params: Readonly<Record<string, unknown>>) =>
    ["org", "overrides", "list", params] as const,
} as const;

export const inviteKeys = {
  instructions: (inviteId: string) => ["org", "invites", "instructions", inviteId] as const,
} as const;

/** Reference lists used by selects and filters (policies, break rules, locations, departments, teams). */
export const referenceKeys = {
  policies: ["org", "policies", "list"] as const,
  breakPolicies: ["org", "break-policies", "list"] as const,
  locations: ["org", "locations", "list"] as const,
  departments: ["org", "departments", "list"] as const,
  teams: ["org", "teams", "list"] as const,
} as const;
