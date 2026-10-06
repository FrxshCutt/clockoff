"use client";

import type { CreateOrganisationInput, LoginInput, RegisterInput } from "@workmode/validation/auth";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { ROUTES, isInternalPath } from "@/config/navigation";
import { api, rememberCsrfToken } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-client";
import { normalizeAcceptInvite, normalizeInvitePreview, parseResponse } from "./api-shapes";
import { fetchCurrentUser, type CurrentUser } from "./use-current-user";
import { z } from "zod";

/** Mutations and queries for `/api/auth/*`, organisation creation/switching and manager invites. */

const registerResponseSchema = z.object({ requiresEmailVerification: z.boolean().optional() });

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: LoginInput) => {
      await api.post<unknown>("/api/auth/login", input);
      // Fresh session: forget anything cached for a previous user, then load the new one.
      queryClient.removeQueries();
      return queryClient.fetchQuery({
        queryKey: queryKeys.currentUser,
        queryFn: ({ signal }) => fetchCurrentUser(signal),
      });
    },
  });
}

export function useRegister() {
  return useMutation({
    mutationFn: async (input: RegisterInput) => {
      const raw = await api.post<unknown>("/api/auth/register", input);
      const parsed = parseResponse(registerResponseSchema, raw ?? {}, "POST /api/auth/register");
      return { requiresEmailVerification: parsed.requiresEmailVerification ?? false };
    },
  });
}

/**
 * Signs out and hard-navigates (default `/login`) so no organisation data survives in memory. `redirectTo`
 * must be a same-origin path, e.g. `/login?next=…` to continue a flow after signing in as someone else.
 */
export function useLogout(options: { redirectTo?: string } = {}) {
  const queryClient = useQueryClient();
  const redirectTo = isInternalPath(options.redirectTo) ? options.redirectTo : ROUTES.login;
  return useMutation({
    mutationFn: () => api.post<unknown>("/api/auth/logout"),
    onSettled: () => {
      rememberCsrfToken(null);
      queryClient.clear();
      window.location.assign(redirectTo);
    },
  });
}

export function useForgotPassword() {
  return useMutation({
    mutationFn: (input: { email: string }) => api.post<unknown>("/api/auth/forgot-password", input),
  });
}

/**
 * Consumes the reset token. The API revokes every existing session and signs this browser in with a fresh
 * one, so the cache is cleared and the new session loaded; `me` is null if no session was established.
 */
export function useResetPassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      token: string;
      password: string;
    }): Promise<{ me: CurrentUser | null }> => {
      await api.post<unknown>("/api/auth/reset-password", input);
      queryClient.removeQueries();
      try {
        const me = await queryClient.fetchQuery({
          queryKey: queryKeys.currentUser,
          queryFn: ({ signal }) => fetchCurrentUser(signal),
          staleTime: 0,
        });
        return { me };
      } catch {
        return { me: null };
      }
    },
  });
}

export function useVerifyEmail() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { token: string }) => api.post<unknown>("/api/auth/verify-email", input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.currentUser }),
  });
}

export function useResendVerification() {
  return useMutation({ mutationFn: () => api.post<unknown>("/api/auth/resend-verification", {}) });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (input: { currentPassword: string; newPassword: string }) =>
      api.post<unknown>("/api/auth/change-password", input),
  });
}

const createdOrganisationSchema = z.object({
  organisation: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string().optional(),
    timezone: z.string().optional(),
  }),
});

export function useCreateOrganisation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateOrganisationInput) => {
      const raw = await api.post<unknown>("/api/organisations", input);
      return parseResponse(createdOrganisationSchema, raw, "POST /api/organisations").organisation;
    },
    onSuccess: async () => {
      // The new organisation becomes current: drop every org-scoped cache and reload the user.
      await queryClient.resetQueries();
    },
  });
}

/**
 * Switches the current organisation, resets every cached query (so no data from the previous organisation
 * can render) and lands on `navigateTo` (default: the overview; `null` stays on the current page).
 */
export function useSwitchOrganisation(options: { navigateTo?: string | null } = {}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const navigateTo = options.navigateTo === undefined ? ROUTES.overview : options.navigateTo;
  return useMutation({
    mutationFn: (organisationId: string) =>
      api.post<unknown>("/api/auth/switch-organisation", { organisationId }),
    onSuccess: async () => {
      await queryClient.resetQueries();
      if (navigateTo) {
        router.replace(navigateTo);
        router.refresh();
      }
    },
  });
}

export function useManagerInvitePreview(token: string | null) {
  return useQuery({
    queryKey: queryKeys.managerInvite(token ?? ""),
    enabled: Boolean(token),
    queryFn: async ({ signal }) => {
      const raw = await api.get<unknown>(
        `/api/invites/manager/${encodeURIComponent(token ?? "")}`,
        undefined,
        signal,
      );
      return normalizeInvitePreview(raw);
    },
    retry: false,
    staleTime: Infinity,
  });
}

export function useAcceptManagerInvite() {
  return useMutation({
    mutationFn: async (input: { token: string; name?: string; password?: string }) => {
      const raw = await api.post<unknown>("/api/organisations/current/members/accept", input);
      return normalizeAcceptInvite(raw);
    },
  });
}

/** Loads the current user after an auth mutation; resolves to null when the session is not established. */
export function useRefreshCurrentUser() {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    try {
      await queryClient.invalidateQueries({ queryKey: queryKeys.currentUser, refetchType: "none" });
      return await queryClient.fetchQuery({
        queryKey: queryKeys.currentUser,
        queryFn: ({ signal }) => fetchCurrentUser(signal),
        staleTime: 0,
      });
    } catch {
      return null;
    }
  }, [queryClient]);
}
