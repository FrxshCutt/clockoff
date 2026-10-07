"use client";

import type {
  BreakPolicy,
  BreakPolicyAssignmentResponse,
  BreakPolicyQuery,
  BreakPolicyResponse,
  CreateBreakPolicyAssignmentInput,
  CreateBreakPolicyInput,
  ListBreakPoliciesResponse,
  ListBreakPolicyAssignmentsResponse,
  SetDefaultBreakPolicyInput,
  UpdateBreakPolicyInput,
} from "@clockoff/validation/breakPolicies";
import type { OrganisationResponse } from "@clockoff/validation/organisation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { breakPolicyQueryKeys } from "@/components/policies/policy-query-keys";
import { api } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-client";

/** Queries and mutations for `/api/break-policies/**`, `/api/break-policy-assignments/:id` and the org default. */

function breakPolicyPath(id: string, suffix = ""): string {
  return `/api/break-policies/${encodeURIComponent(id)}${suffix}`;
}

export function useBreakPolicies(query: BreakPolicyQuery = {}) {
  return useQuery({
    queryKey: breakPolicyQueryKeys.list(query),
    queryFn: ({ signal }) =>
      api.get<ListBreakPoliciesResponse>(
        "/api/break-policies",
        {
          status: query.status,
          search: query.search === undefined || query.search === "" ? undefined : query.search,
          includeArchived: query.includeArchived,
        },
        signal,
      ),
    select: (data) => data.breakPolicies,
  });
}

export function useBreakPolicy(id: string | null, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: breakPolicyQueryKeys.detail(id ?? ""),
    queryFn: async ({ signal }) =>
      (await api.get<BreakPolicyResponse>(breakPolicyPath(id ?? ""), undefined, signal))
        .breakPolicy,
    enabled: (options.enabled ?? true) && id !== null,
  });
}

export function useBreakPolicyAssignments(id: string | null, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: breakPolicyQueryKeys.assignments(id ?? ""),
    queryFn: ({ signal }) =>
      api.get<ListBreakPolicyAssignmentsResponse>(
        breakPolicyPath(id ?? "", "/assignments"),
        undefined,
        signal,
      ),
    select: (data) => data.assignments,
    enabled: (options.enabled ?? true) && id !== null,
  });
}

/** Writes the fresh break policy into the detail cache and refreshes every list/assignment view. */
function useSettleBreakPolicy() {
  const queryClient = useQueryClient();
  return async (policy?: BreakPolicy) => {
    if (policy) queryClient.setQueryData(breakPolicyQueryKeys.detail(policy.id), policy);
    await queryClient.invalidateQueries({ queryKey: breakPolicyQueryKeys.all });
  };
}

export function useCreateBreakPolicy() {
  const settle = useSettleBreakPolicy();
  return useMutation({
    mutationFn: async (input: CreateBreakPolicyInput) =>
      (await api.post<BreakPolicyResponse>("/api/break-policies", input)).breakPolicy,
    onSuccess: (policy) => settle(policy),
  });
}

export function useUpdateBreakPolicy() {
  const settle = useSettleBreakPolicy();
  return useMutation({
    mutationFn: async (variables: { id: string; input: UpdateBreakPolicyInput }) =>
      (await api.patch<BreakPolicyResponse>(breakPolicyPath(variables.id), variables.input))
        .breakPolicy,
    onSuccess: (policy) => settle(policy),
  });
}

export function useDeleteBreakPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(breakPolicyPath(id)),
    onSuccess: async (_result, id) => {
      queryClient.removeQueries({ queryKey: breakPolicyQueryKeys.detail(id) });
      await queryClient.invalidateQueries({ queryKey: breakPolicyQueryKeys.all });
    },
  });
}

export function useAssignBreakPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (variables: { id: string; input: CreateBreakPolicyAssignmentInput }) =>
      (
        await api.post<BreakPolicyAssignmentResponse>(
          breakPolicyPath(variables.id, "/assignments"),
          variables.input,
        )
      ).assignment,
    // Assignment counts live on the break policy, so the whole domain refreshes.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: breakPolicyQueryKeys.all }),
  });
}

export function useRemoveBreakPolicyAssignment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: { assignmentId: string; breakPolicyId: string }) =>
      api.delete<void>(
        `/api/break-policy-assignments/${encodeURIComponent(variables.assignmentId)}`,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: breakPolicyQueryKeys.all }),
  });
}

/** `POST /api/organisations/current/default-break-policy` — `breakPolicyId: null` clears the default. */
export function useSetDefaultBreakPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SetDefaultBreakPolicyInput) =>
      api.post<OrganisationResponse>("/api/organisations/current/default-break-policy", input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: breakPolicyQueryKeys.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.currentOrganisation }),
      ]);
    },
  });
}
