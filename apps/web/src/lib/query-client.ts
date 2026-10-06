import { QueryCache, QueryClient, MutationCache } from "@tanstack/react-query";
import { isApiClientError } from "@/lib/api-client";

/** Query keys used across the dashboard. Organisation-scoped keys start with "org" so they can be cleared together. */
export const queryKeys = {
  currentUser: ["auth", "me"] as const,
  currentOrganisation: ["org", "current"] as const,
  onboarding: ["org", "current", "onboarding"] as const,
  members: ["org", "current", "members"] as const,
  joinCode: ["org", "current", "join-code"] as const,
  notifications: ["org", "notifications"] as const,
  notificationPreferences: ["org", "settings", "notification-preferences"] as const,
  billing: ["org", "settings", "billing"] as const,
  managerInvite: (token: string) => ["invites", "manager", token] as const,
} as const;

export const QUERY_DEFAULTS = {
  staleTime: 15_000,
  maxRetries: 1,
  refetchOnWindowFocus: true,
} as const;

/**
 * Retry at most once, and never for client errors (4xx): retrying a 401/403/404/validation error cannot
 * succeed and only delays the error UI. Network failures and 5xx get one retry.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= QUERY_DEFAULTS.maxRetries) return false;
  if (isApiClientError(error) && error.status >= 400 && error.status < 500) return false;
  return true;
}

/**
 * Error codes that mean the dashboard gate's view of the session is out of date:
 * - `UNAUTHENTICATED`: the session ended (signed out elsewhere, expired, password reset).
 * - `NO_ORGANISATION`: the manager no longer belongs to any organisation (e.g. removed by an owner).
 */
export const SESSION_CHANGE_ERROR_CODES = ["UNAUTHENTICATED", "NO_ORGANISATION"] as const;

/** True when `error` should make the dashboard re-check `GET /api/auth/me`. */
export function isSessionChangeError(error: unknown): boolean {
  return (
    isApiClientError(error) &&
    (SESSION_CHANGE_ERROR_CODES as readonly string[]).includes(error.code)
  );
}

/**
 * A new QueryClient per browser session (created once in `Providers`). When any request reports that the
 * session ended or the manager lost their last organisation, the current-user query is invalidated so the
 * dashboard gate redirects (to `/login` or `/create-organisation`) instead of every page showing its own
 * error.
 */
export function makeQueryClient(): QueryClient {
  let client: QueryClient | null = null;

  const onSessionError = (error: unknown, key?: readonly unknown[]) => {
    if (!client || !isSessionChangeError(error)) return;
    const isCurrentUserQuery =
      key !== undefined &&
      key[0] === queryKeys.currentUser[0] &&
      key[1] === queryKeys.currentUser[1];
    if (!isCurrentUserQuery) void client.invalidateQueries({ queryKey: queryKeys.currentUser });
  };

  client = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => onSessionError(error, query.queryKey),
    }),
    mutationCache: new MutationCache({ onError: (error) => onSessionError(error) }),
    defaultOptions: {
      queries: {
        staleTime: QUERY_DEFAULTS.staleTime,
        retry: shouldRetryQuery,
        refetchOnWindowFocus: QUERY_DEFAULTS.refetchOnWindowFocus,
      },
      mutations: {
        retry: false,
      },
    },
  });
  return client;
}
