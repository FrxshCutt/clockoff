"use client";

import { listEmployeesResponseSchema, type Employee } from "@workmode/validation/employees";
import {
  departmentResponseSchema,
  listDepartmentsResponseSchema,
  listLocationsResponseSchema,
  listTeamsResponseSchema,
  locationResponseSchema,
  teamResponseSchema,
  type AddTeamMembersInput,
  type CreateDepartmentInput,
  type CreateTeamInput,
  type Department,
  type ListDepartmentsResponse,
  type ListLocationsResponse,
  type ListTeamsResponse,
  type Location,
  type Team,
  type UpdateDepartmentInput,
  type UpdateTeamInput,
} from "@workmode/validation/locationsTeams";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { breakPolicyQueryKeys, policyQueryKeys } from "@/components/policies/policy-query-keys";
import { parseResponse } from "@/hooks/api-shapes";
import { api } from "@/lib/api-client";
import { departmentKeys, locationKeys, teamKeys, teamMemberKeys } from "./location-keys";
import type { CreateLocationBody, UpdateLocationBody } from "./locations-view-model";

/**
 * Queries and mutations for `/api/locations`, `/api/departments`, `/api/teams` and `/api/teams/:id/members`.
 * Every response is parsed with its `@workmode/validation` schema, so a contract drift surfaces as
 * INVALID_RESPONSE naming the endpoint instead of `undefined` in a table cell.
 */

const encode = encodeURIComponent;
const EMPLOYEE_KEY_PREFIX = ["org", "employees"] as const;

// ── Reads ───────────────────────────────────────────────────────────────────

export function useLocationsList(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: locationKeys.list,
    queryFn: async ({ signal }): Promise<ListLocationsResponse> =>
      parseResponse(
        listLocationsResponseSchema,
        await api.get<unknown>("/api/locations", undefined, signal),
        "GET /api/locations",
      ),
    select: (data) => data.locations,
    enabled: options.enabled ?? true,
  });
}

export function useDepartmentsList(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: departmentKeys.list,
    queryFn: async ({ signal }): Promise<ListDepartmentsResponse> =>
      parseResponse(
        listDepartmentsResponseSchema,
        await api.get<unknown>("/api/departments", undefined, signal),
        "GET /api/departments",
      ),
    select: (data) => data.departments,
    enabled: options.enabled ?? true,
  });
}

export function useTeamsList(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: teamKeys.list,
    queryFn: async ({ signal }): Promise<ListTeamsResponse> =>
      parseResponse(
        listTeamsResponseSchema,
        await api.get<unknown>("/api/teams", undefined, signal),
        "GET /api/teams",
      ),
    select: (data) => data.teams,
    enabled: options.enabled ?? true,
  });
}

/** Up to this many members are listed in the members dialog (the API's maximum page size). */
export const TEAM_MEMBERS_PAGE_SIZE = 200;

/** A team's current members: `GET /api/employees?teamId=` (active and inactive, archived never listed). */
export function useTeamMembers(teamId: string | null, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: teamMemberKeys.members(teamId ?? ""),
    queryFn: async ({ signal }): Promise<{ items: Employee[]; total: number }> => {
      const raw = await api.get<unknown>(
        "/api/employees",
        { teamId: teamId ?? "", page: 1, pageSize: TEAM_MEMBERS_PAGE_SIZE, sort: "lastName" },
        signal,
      );
      const data = parseResponse(listEmployeesResponseSchema, raw, "GET /api/employees?teamId=");
      return { items: data.items, total: data.total };
    },
    enabled: (options.enabled ?? true) && teamId !== null,
  });
}

// ── Invalidation ────────────────────────────────────────────────────────────

/** Employees carry location/department/team refs and resolved policies, so they refresh with the structure. */
async function invalidateStructure(
  queryClient: QueryClient,
  ...roots: readonly (readonly unknown[])[]
): Promise<void> {
  await Promise.all(
    [...roots, EMPLOYEE_KEY_PREFIX].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  );
}

/** Deleting a scope orphans its assignments, so the policy pages must refetch too. */
const POLICY_ROOTS = [policyQueryKeys.all, breakPolicyQueryKeys.all] as const;

// ── Locations ───────────────────────────────────────────────────────────────

export function useCreateLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateLocationBody): Promise<Location> =>
      parseResponse(
        locationResponseSchema,
        await api.post<unknown>("/api/locations", input),
        "POST /api/locations",
      ).location,
    onSuccess: () => invalidateStructure(queryClient, locationKeys.all),
  });
}

export function useUpdateLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      input,
    }: {
      id: string;
      input: UpdateLocationBody;
    }): Promise<Location> =>
      parseResponse(
        locationResponseSchema,
        await api.patch<unknown>(`/api/locations/${encode(id)}`, input),
        "PATCH /api/locations/:id",
      ).location,
    onSuccess: () => invalidateStructure(queryClient, locationKeys.all, teamKeys.all),
  });
}

export function useDeleteLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/locations/${encode(id)}`),
    onSuccess: () =>
      invalidateStructure(queryClient, locationKeys.all, teamKeys.all, ...POLICY_ROOTS),
  });
}

// ── Departments ─────────────────────────────────────────────────────────────

export function useCreateDepartment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateDepartmentInput): Promise<Department> =>
      parseResponse(
        departmentResponseSchema,
        await api.post<unknown>("/api/departments", input),
        "POST /api/departments",
      ).department,
    onSuccess: () => invalidateStructure(queryClient, departmentKeys.all),
  });
}

export function useUpdateDepartment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      input,
    }: {
      id: string;
      input: UpdateDepartmentInput;
    }): Promise<Department> =>
      parseResponse(
        departmentResponseSchema,
        await api.patch<unknown>(`/api/departments/${encode(id)}`, input),
        "PATCH /api/departments/:id",
      ).department,
    onSuccess: () => invalidateStructure(queryClient, departmentKeys.all),
  });
}

export function useDeleteDepartment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/departments/${encode(id)}`),
    onSuccess: () => invalidateStructure(queryClient, departmentKeys.all),
  });
}

// ── Teams ───────────────────────────────────────────────────────────────────

export function useCreateTeam() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateTeamInput): Promise<Team> =>
      parseResponse(
        teamResponseSchema,
        await api.post<unknown>("/api/teams", input),
        "POST /api/teams",
      ).team,
    onSuccess: () => invalidateStructure(queryClient, teamKeys.all, locationKeys.all),
  });
}

export function useUpdateTeam() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: UpdateTeamInput }): Promise<Team> =>
      parseResponse(
        teamResponseSchema,
        await api.patch<unknown>(`/api/teams/${encode(id)}`, input),
        "PATCH /api/teams/:id",
      ).team,
    onSuccess: () => invalidateStructure(queryClient, teamKeys.all, locationKeys.all),
  });
}

export function useDeleteTeam() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/teams/${encode(id)}`),
    onSuccess: () =>
      invalidateStructure(queryClient, teamKeys.all, locationKeys.all, ...POLICY_ROOTS),
  });
}

/** `POST /api/teams/:id/members` — idempotent; employees already in the team are left as they are. */
export function useAddTeamMembers() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: AddTeamMembersInput }): Promise<Team> =>
      parseResponse(
        teamResponseSchema,
        await api.post<unknown>(`/api/teams/${encode(id)}/members`, input),
        "POST /api/teams/:id/members",
      ).team,
    onSuccess: () => invalidateStructure(queryClient, teamKeys.all),
  });
}

export function useRemoveTeamMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, employeeId }: { id: string; employeeId: string }) =>
      api.delete<void>(`/api/teams/${encode(id)}/members/${encode(employeeId)}`),
    onSuccess: () => invalidateStructure(queryClient, teamKeys.all),
  });
}
