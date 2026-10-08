/**
 * React Query keys for workforce integrations (`/api/integrations/*`), shared by the Integrations page, the
 * Planday wizard, the health banner and the realtime invalidation table, so they all refetch the same queries
 * (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §7.11). Organisation-scoped keys start with "org" (see
 * `queryKeys` in `@/lib/query-client`) so switching organisation clears them together. Every Planday key sits
 * under `integrationKeys.all`, so invalidating that prefix refreshes the Planday queries as well.
 */

export const integrationKeys = {
  all: ["org", "integrations"] as const,
  /** `GET /api/integrations` */
  list: ["org", "integrations", "list"] as const,
  /** `GET /api/integrations/health` (the dashboard banner). */
  health: ["org", "integrations", "health"] as const,
} as const;

/** Steps of the Planday wizard with their own `GET` (`/api/integrations/planday/onboarding/<step>`). */
export type PlandayOnboardingStepKey =
  "locations" | "teams" | "employees" | "shift-preview" | "policies" | "invites";

export const plandayKeys = {
  all: ["org", "integrations", "planday"] as const,
  /** `GET /api/integrations/planday` (the Integrations page card). */
  detail: ["org", "integrations", "planday", "detail"] as const,
  /** `GET /api/integrations/planday/connect-methods` */
  connectMethods: ["org", "integrations", "planday", "connect-methods"] as const,
  /** Prefix of every run query (the history list and each run's progress). */
  runs: ["org", "integrations", "planday", "runs"] as const,
  /** `GET /api/integrations/planday/runs?limit=` */
  runList: (limit: number) => ["org", "integrations", "planday", "runs", "list", limit] as const,
  /** `GET /api/integrations/planday/runs/:runId` */
  run: (runId: string) => ["org", "integrations", "planday", "runs", "detail", runId] as const,
  /** `GET /api/integrations/planday/settings` */
  settings: ["org", "integrations", "planday", "settings"] as const,
  /** Prefix of the pending-employee queue queries. */
  pendingEmployees: ["org", "integrations", "planday", "pending-employees"] as const,
  /** `GET /api/integrations/planday/pending-employees?…` */
  pendingEmployeeList: (params: Readonly<Record<string, unknown>>) =>
    ["org", "integrations", "planday", "pending-employees", params] as const,
  /** `GET /api/integrations/planday/connect-links` */
  connectLinks: ["org", "integrations", "planday", "connect-links"] as const,
  /** Prefix of every wizard query (the session and each step). */
  onboarding: ["org", "integrations", "planday", "onboarding"] as const,
  /** `GET /api/integrations/planday/onboarding` */
  onboardingSession: ["org", "integrations", "planday", "onboarding", "session"] as const,
  /** `GET /api/integrations/planday/onboarding/<step>` (with the step's query, e.g. the employee filters). */
  onboardingStep: (step: PlandayOnboardingStepKey, params?: Readonly<Record<string, unknown>>) =>
    params === undefined
      ? (["org", "integrations", "planday", "onboarding", step] as const)
      : (["org", "integrations", "planday", "onboarding", step, params] as const),
} as const;
