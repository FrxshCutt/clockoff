"use client";

import type { CreateAssignmentInput } from "@workmode/validation/policies";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useBreakPolicies, usePolicies } from "@/components/employees/employee-api";
import { breakPolicyQueryKeys, policyQueryKeys } from "@/components/policies/policy-query-keys";
import { api } from "@/lib/api-client";
import { locationKeys, teamKeys } from "./location-keys";
import { assignableBreakPolicies, assignableWorkPolicies, type AssignableScope, type PolicyKind, type PolicyOption } from "./locations-view-model";

/**
 * The inline "Assign…" controls on Locations & Teams. What is assigned at each scope comes embedded on the
 * location / team rows (`policyAssignment` / `breakPolicyAssignment`); these hooks supply the policies to
 * choose from and the assignment mutations. Query keys are shared with the Employees and Policies pages so
 * every list stays in sync.
 */

const encode = encodeURIComponent;

export interface PolicyOptionsState {
  /** Policies that can be chosen; undefined while loading. */
  options: PolicyOption[] | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
}

/** Work Policies and Break Rules a manager can assign (`GET /api/policies`, `GET /api/break-policies`). */
export function usePolicyOptions(options: { enabled?: boolean } = {}): { workPolicies: PolicyOptionsState; breakPolicies: PolicyOptionsState } {
  const enabled = options.enabled ?? true;
  const policies = usePolicies({ enabled });
  const breakPolicies = useBreakPolicies({ enabled });
  const workOptions = useMemo(() => (policies.data ? assignableWorkPolicies(policies.data) : undefined), [policies.data]);
  const breakOptions = useMemo(() => (breakPolicies.data ? assignableBreakPolicies(breakPolicies.data) : undefined), [breakPolicies.data]);
  return {
    workPolicies: {
      options: workOptions,
      isPending: policies.isPending,
      isError: policies.isError,
      error: policies.error,
      refetch: () => void policies.refetch(),
    },
    breakPolicies: {
      options: breakOptions,
      isPending: breakPolicies.isPending,
      isError: breakPolicies.isError,
      error: breakPolicies.error,
      refetch: () => void breakPolicies.refetch(),
    },
  };
}

function assignmentsPath(kind: PolicyKind, policyId: string): string {
  return kind === "policy" ? `/api/policies/${encode(policyId)}/assignments` : `/api/break-policies/${encode(policyId)}/assignments`;
}

function assignmentPath(kind: PolicyKind, assignmentId: string): string {
  return kind === "policy" ? `/api/policy-assignments/${encode(assignmentId)}` : `/api/break-policy-assignments/${encode(assignmentId)}`;
}

/** Rows embed their assignment, resolved policies on employees change, and the policy pages count assignments. */
async function invalidateAfterAssignment(queryClient: QueryClient, kind: PolicyKind): Promise<void> {
  const keys = [locationKeys.all, teamKeys.all, kind === "policy" ? policyQueryKeys.all : breakPolicyQueryKeys.all, ["org", "employees"] as const];
  await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

export interface AssignScopePolicyVariables {
  policyId: string;
  scopeType: AssignableScope;
  scopeId: string;
}

/**
 * `POST /api/<kind>/:id/assignments { scopeType, scopeId }`. The server replaces any assignment already in
 * force at the same scope (one open assignment per scope), so no client-side clean-up is needed.
 */
export function useAssignScopePolicy(kind: PolicyKind) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (variables: AssignScopePolicyVariables): Promise<void> => {
      const body: CreateAssignmentInput = { scopeType: variables.scopeType, scopeId: variables.scopeId };
      await api.post<unknown>(assignmentsPath(kind, variables.policyId), body);
    },
    onSettled: () => invalidateAfterAssignment(queryClient, kind),
  });
}

/** `DELETE /api/<kind>-assignments/:id` — the scope inherits from the next level up again. */
export function useRemoveScopeAssignment(kind: PolicyKind) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (assignmentId: string) => api.delete<void>(assignmentPath(kind, assignmentId)),
    onSettled: () => invalidateAfterAssignment(queryClient, kind),
  });
}
