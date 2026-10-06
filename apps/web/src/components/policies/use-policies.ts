"use client";

import type { OrganisationResponse } from "@workmode/validation/organisation";
import type {
  CreatePolicyAssignmentInput,
  CreatePolicyInput,
  DuplicatePolicyInput,
  ListPoliciesResponse,
  ListPolicyAssignmentsResponse,
  Policy,
  PolicyAssignmentResponse,
  PolicyQuery,
  PolicyResponse,
  PolicyVersionsResponse,
  PublishPolicyInput,
  SetDefaultPolicyInput,
  UpdatePolicyInput,
} from "@workmode/validation/policies";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-client";
import { policyQueryKeys } from "./policy-query-keys";

/** Queries and mutations for `/api/policies/**`, `/api/policy-assignments/:id` and the organisation default. */

function policyPath(id: string, suffix = ""): string {
  return `/api/policies/${encodeURIComponent(id)}${suffix}`;
}

export function usePolicies(query: PolicyQuery = {}) {
  return useQuery({
    queryKey: policyQueryKeys.list(query),
    queryFn: ({ signal }) =>
      api.get<ListPoliciesResponse>(
        "/api/policies",
        {
          status: query.status,
          search: query.search === undefined || query.search === "" ? undefined : query.search,
          includeArchived: query.includeArchived,
        },
        signal,
      ),
    select: (data) => data.policies,
  });
}

export function usePolicy(id: string | null, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: policyQueryKeys.detail(id ?? ""),
    queryFn: async ({ signal }) => (await api.get<PolicyResponse>(policyPath(id ?? ""), undefined, signal)).policy,
    enabled: (options.enabled ?? true) && id !== null,
  });
}

export function usePolicyVersions(id: string | null, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: policyQueryKeys.versions(id ?? ""),
    queryFn: ({ signal }) => api.get<PolicyVersionsResponse>(policyPath(id ?? "", "/versions"), undefined, signal),
    select: (data) => data.versions,
    enabled: (options.enabled ?? true) && id !== null,
  });
}

export function usePolicyAssignments(id: string | null, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: policyQueryKeys.assignments(id ?? ""),
    queryFn: ({ signal }) =>
      api.get<ListPolicyAssignmentsResponse>(policyPath(id ?? "", "/assignments"), undefined, signal),
    select: (data) => data.assignments,
    enabled: (options.enabled ?? true) && id !== null,
  });
}

/** Writes the fresh policy into the detail cache and refreshes every list/version/assignment view. */
function useSettlePolicy() {
  const queryClient = useQueryClient();
  return async (policy?: Policy) => {
    if (policy) queryClient.setQueryData(policyQueryKeys.detail(policy.id), policy);
    await queryClient.invalidateQueries({ queryKey: policyQueryKeys.all });
  };
}

export function useCreatePolicy() {
  const settle = useSettlePolicy();
  return useMutation({
    mutationFn: async (input: CreatePolicyInput) => (await api.post<PolicyResponse>("/api/policies", input)).policy,
    onSuccess: (policy) => settle(policy),
  });
}

export function useUpdatePolicy() {
  const settle = useSettlePolicy();
  return useMutation({
    mutationFn: async (variables: { id: string; input: UpdatePolicyInput }) =>
      (await api.patch<PolicyResponse>(policyPath(variables.id), variables.input)).policy,
    onSuccess: (policy) => settle(policy),
  });
}

export function usePublishPolicy() {
  const settle = useSettlePolicy();
  return useMutation({
    mutationFn: async (variables: { id: string; input: PublishPolicyInput }) =>
      (await api.post<PolicyResponse>(policyPath(variables.id, "/publish"), variables.input)).policy,
    onSuccess: (policy) => settle(policy),
  });
}

export function useDuplicatePolicy() {
  const settle = useSettlePolicy();
  return useMutation({
    mutationFn: async (variables: { id: string; input: DuplicatePolicyInput }) =>
      (await api.post<PolicyResponse>(policyPath(variables.id, "/duplicate"), variables.input)).policy,
    onSuccess: (policy) => settle(policy),
  });
}

export function useArchivePolicy() {
  const settle = useSettlePolicy();
  return useMutation({
    mutationFn: async (id: string) => (await api.post<PolicyResponse>(policyPath(id, "/archive"), {})).policy,
    onSuccess: (policy) => settle(policy),
  });
}

export function useDeletePolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(policyPath(id)),
    onSuccess: async (_result, id) => {
      queryClient.removeQueries({ queryKey: policyQueryKeys.detail(id) });
      await queryClient.invalidateQueries({ queryKey: policyQueryKeys.all });
    },
  });
}

export function useAssignPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (variables: { id: string; input: CreatePolicyAssignmentInput }) =>
      (await api.post<PolicyAssignmentResponse>(policyPath(variables.id, "/assignments"), variables.input)).assignment,
    // Assignment counts live on the policy, so the whole domain refreshes.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: policyQueryKeys.all }),
  });
}

export function useRemovePolicyAssignment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: { assignmentId: string; policyId: string }) =>
      api.delete<void>(`/api/policy-assignments/${encodeURIComponent(variables.assignmentId)}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: policyQueryKeys.all }),
  });
}

/** `POST /api/organisations/current/default-policy` — `policyId: null` clears the default. */
export function useSetDefaultPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SetDefaultPolicyInput) =>
      api.post<OrganisationResponse>("/api/organisations/current/default-policy", input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: policyQueryKeys.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.currentOrganisation }),
      ]);
    },
  });
}
