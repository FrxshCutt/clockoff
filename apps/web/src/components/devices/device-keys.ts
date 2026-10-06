/**
 * React Query keys for `/api/devices`. Organisation-scoped keys start with "org" (see `queryKeys` in
 * `@/lib/query-client`) so switching organisation clears them together.
 */
export const deviceKeys = {
  all: ["org", "devices"] as const,
  list: (params: Readonly<Record<string, unknown>>) => ["org", "devices", "list", params] as const,
  detail: (id: string) => ["org", "devices", "detail", id] as const,
} as const;
