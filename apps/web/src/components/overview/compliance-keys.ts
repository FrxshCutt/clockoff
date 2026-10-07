import type { ComplianceFilter } from "@clockoff/validation/compliance";

/** List state behind `GET /api/compliance/employees` (also the URL state of the Compliance tab on /activity). */
export interface ComplianceListParams {
  readonly filter: ComplianceFilter;
  readonly search: string;
  readonly page: number;
  readonly pageSize: number;
  readonly locationId: string | null;
  readonly teamId: string | null;
}

/**
 * React Query keys for the compliance domain (`/api/compliance/*`). Organisation-scoped keys start with
 * "org" (see `queryKeys` in `@/lib/query-client`) so switching organisation clears them together.
 */
export const complianceKeys = {
  all: ["org", "compliance"] as const,
  summary: ["org", "compliance", "summary"] as const,
  employees: (params: ComplianceListParams) => ["org", "compliance", "employees", params] as const,
} as const;
