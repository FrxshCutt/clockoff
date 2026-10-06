/**
 * React Query keys for the organisation activity feed and the audit log. Organisation-scoped keys start
 * with "org" (see `queryKeys` in `@/lib/query-client`) so switching organisation clears them together.
 */
export const activityKeys = {
  all: ["org", "activity"] as const,
  feed: (params: Readonly<Record<string, unknown>>) => ["org", "activity", "feed", params] as const,
} as const;

export const auditLogKeys = {
  all: ["org", "audit-logs"] as const,
  list: (params: Readonly<Record<string, unknown>>) =>
    ["org", "audit-logs", "list", params] as const,
} as const;
