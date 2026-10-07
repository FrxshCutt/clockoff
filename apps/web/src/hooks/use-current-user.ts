"use client";

import type { Permission } from "@clockoff/shared/permissions";
import { hasPermission } from "@clockoff/shared/permissions";
import type { Role } from "@clockoff/shared/enums";
import { currentUserSchema, type CurrentUser } from "@clockoff/validation/auth";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, isUnauthenticatedError, rememberCsrfToken } from "@/lib/api-client";
import { queryKeys, shouldRetryQuery } from "@/lib/query-client";
import { parseResponse } from "./api-shapes";

export type { CurrentUser };
export type CurrentUserOrganisation = CurrentUser["organisations"][number];

export async function fetchCurrentUser(signal?: AbortSignal): Promise<CurrentUser> {
  const raw = await apiFetch<unknown>("/api/auth/me", { signal });
  const me = parseResponse(currentUserSchema, raw, "GET /api/auth/me");
  rememberCsrfToken(me.csrfToken);
  return me;
}

/**
 * The signed-in manager (`GET /api/auth/me`). Errors with `code === "UNAUTHENTICATED"` when signed out —
 * the dashboard gate turns that into a redirect to `/login?next=…`.
 */
export function useCurrentUser(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.currentUser,
    queryFn: ({ signal }) => fetchCurrentUser(signal),
    enabled: options.enabled ?? true,
    staleTime: 60_000,
    retry: (failureCount, error) =>
      !isUnauthenticatedError(error) && shouldRetryQuery(failureCount, error),
  });
}

/** The membership for the organisation currently selected, or the first one when none is selected yet. */
export function getCurrentMembership(
  me: CurrentUser | undefined | null,
): CurrentUserOrganisation | null {
  if (!me || me.organisations.length === 0) return null;
  return (
    me.organisations.find((o) => o.id === me.currentOrganisationId) ?? me.organisations[0] ?? null
  );
}

export function useCurrentMembership(): CurrentUserOrganisation | null {
  const { data } = useCurrentUser();
  return getCurrentMembership(data);
}

export function useCurrentRole(): Role | null {
  return useCurrentMembership()?.role ?? null;
}

/** UI-level permission check (the API enforces the same rules; this only hides controls that would fail). */
export function usePermission(permission: Permission): boolean {
  const role = useCurrentRole();
  return role !== null && hasPermission(role, permission);
}

/**
 * Whether the phone test tools ("Create test shift…") are available in the current organisation
 * (`testToolsEnabled` on `GET /api/auth/me`; the API answers 404 otherwise).
 */
export function useTestToolsEnabled(): boolean {
  return useCurrentMembership()?.testToolsEnabled === true;
}

/**
 * Whether to show "Create test shift…": the current organisation has the phone test tools and the
 * manager may create shifts (`schedule:write`, the permission `POST /api/test-tools/test-shift` checks).
 */
export function useCanCreateTestShift(): boolean {
  const testTools = useTestToolsEnabled();
  const canSchedule = usePermission("schedule:write");
  return testTools && canSchedule;
}
