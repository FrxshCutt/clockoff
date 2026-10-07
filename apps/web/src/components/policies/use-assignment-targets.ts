"use client";

import type { ListEmployeesResponse } from "@clockoff/validation/employees";
import type { ListLocationsResponse, ListTeamsResponse } from "@clockoff/validation/locationsTeams";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { assignmentTargetQueryKeys } from "./policy-query-keys";

/** Everything a policy can be assigned to: `GET /api/locations`, `GET /api/teams`, `GET /api/employees?search=`. */

export function useLocations(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: assignmentTargetQueryKeys.locations,
    queryFn: ({ signal }) => api.get<ListLocationsResponse>("/api/locations", undefined, signal),
    select: (data) => data.locations,
    enabled: options.enabled ?? true,
  });
}

export function useTeams(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: assignmentTargetQueryKeys.teams,
    queryFn: ({ signal }) => api.get<ListTeamsResponse>("/api/teams", undefined, signal),
    select: (data) => data.teams,
    enabled: options.enabled ?? true,
  });
}

export const EMPLOYEE_SEARCH_PAGE_SIZE = 20;

/** First page of employees matching `search` (name, email, external id, job title), sorted by last name. */
export function useEmployeeSearch(search: string, options: { enabled?: boolean } = {}) {
  const trimmed = search.trim();
  return useQuery({
    queryKey: assignmentTargetQueryKeys.employeeSearch(trimmed),
    queryFn: ({ signal }) =>
      api.get<ListEmployeesResponse>(
        "/api/employees",
        {
          search: trimmed === "" ? undefined : trimmed,
          pageSize: EMPLOYEE_SEARCH_PAGE_SIZE,
          sort: "lastName",
        },
        signal,
      ),
    select: (data) => ({ items: data.items, total: data.total }),
    enabled: options.enabled ?? true,
    placeholderData: keepPreviousData,
  });
}
