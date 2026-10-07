"use client";

import type { Role } from "@clockoff/shared/enums";
import type { UpdateOrganisationInput } from "@clockoff/validation/organisation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-client";
import {
  normalizeCurrentOrganisation,
  normalizeJoinCode,
  normalizeMembers,
  normalizeOnboarding,
} from "./api-shapes";

/** Queries and mutations for `/api/organisations/current/*`. */

export function useCurrentOrganisation(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.currentOrganisation,
    queryFn: async ({ signal }) =>
      normalizeCurrentOrganisation(
        await api.get<unknown>("/api/organisations/current", undefined, signal),
      ),
    enabled: options.enabled ?? true,
  });
}

export function useUpdateOrganisation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateOrganisationInput) =>
      api.patch<unknown>("/api/organisations/current", input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.currentOrganisation }),
        // Organisation names/time zones are also listed in /api/auth/me (org switcher).
        queryClient.invalidateQueries({ queryKey: queryKeys.currentUser }),
      ]);
    },
  });
}

export function useOnboarding() {
  return useQuery({
    queryKey: queryKeys.onboarding,
    queryFn: async ({ signal }) =>
      normalizeOnboarding(
        await api.get<unknown>("/api/organisations/current/onboarding", undefined, signal),
      ),
  });
}

export function useDismissOnboarding() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<unknown>("/api/organisations/current/onboarding/dismiss"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.onboarding }),
  });
}

export function useMembers(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.members,
    queryFn: async ({ signal }) =>
      normalizeMembers(
        await api.get<unknown>("/api/organisations/current/members", undefined, signal),
      ),
    enabled: options.enabled ?? true,
  });
}

export function useInviteMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; role: Role }) =>
      api.post<unknown>("/api/organisations/current/members", input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.members }),
  });
}

/** Re-sends a pending or expired manager invite with a fresh link (`POST …/members/invite { inviteId }`). */
export function useResendManagerInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) =>
      api.post<unknown>("/api/organisations/current/members/invite", { inviteId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.members }),
  });
}

/** Cancels a manager invite (`DELETE …/members/invites/:inviteId`). */
export function useRevokeManagerInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) =>
      api.delete<unknown>(
        `/api/organisations/current/members/invites/${encodeURIComponent(inviteId)}`,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.members }),
  });
}

export function useUpdateMemberRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { membershipId: string; role: Role }) =>
      api.patch<unknown>(
        `/api/organisations/current/members/${encodeURIComponent(input.membershipId)}`,
        { role: input.role },
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.members }),
        queryClient.invalidateQueries({ queryKey: queryKeys.currentUser }),
      ]);
    },
  });
}

const removeMemberResponseSchema = z.object({ removedSelf: z.boolean().optional() }).passthrough();

/**
 * Removes a member (`DELETE …/members/:membershipId`). Removing your own membership leaves the organisation:
 * every cached query is reset so nothing from it can render, and the dashboard gate picks the next
 * organisation (or sends the manager to create one).
 */
export function useRemoveMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (membershipId: string) => {
      const raw = await api.delete<unknown>(
        `/api/organisations/current/members/${encodeURIComponent(membershipId)}`,
      );
      const parsed = removeMemberResponseSchema.safeParse(raw ?? {});
      return { removedSelf: parsed.success ? (parsed.data.removedSelf ?? false) : false };
    },
    onSuccess: async (result) => {
      if (result.removedSelf) {
        await queryClient.resetQueries();
        return;
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.members });
    },
  });
}

function useJoinCodeMutation(action: "regenerate" | "revoke") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const raw = await api.post<unknown>(`/api/organisations/current/join-code/${action}`);
      // The response shape is informative only; the organisation query is the source of truth.
      try {
        return normalizeJoinCode(raw);
      } catch {
        return null;
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.currentOrganisation }),
  });
}

export function useRegenerateJoinCode() {
  return useJoinCodeMutation("regenerate");
}

export function useRevokeJoinCode() {
  return useJoinCodeMutation("revoke");
}
