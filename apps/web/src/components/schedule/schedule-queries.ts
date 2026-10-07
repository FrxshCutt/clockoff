"use client";

import type {
  Employee,
  EmployeeDetailResponse,
  ListEmployeesResponse,
} from "@clockoff/validation/employees";
import type { ListLocationsResponse, Location } from "@clockoff/validation/locationsTeams";
import type {
  BulkShiftActionInput,
  BulkShiftActionResponse,
  CancelShiftInput,
  CreateShiftInput,
  CreateShiftResponse,
  DuplicateShiftInput,
  ListShiftsResponse,
  Shift,
  ShiftResponse,
} from "@clockoff/validation/shifts";
import { updateShiftSchema } from "@clockoff/validation/shifts";
import type { z } from "zod";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { api } from "@/lib/api-client";

/**
 * Queries and mutations for `/api/shifts`, plus the employee and location lookups the schedule needs.
 * Keys start with "org" like the rest of the dashboard so switching organisation clears them.
 */
export const scheduleKeys = {
  shiftsRoot: ["org", "shifts"] as const,
  shifts: (query: ShiftsQueryInput) =>
    [
      "org",
      "shifts",
      "range",
      query.from,
      query.to,
      query.employeeId ?? null,
      query.locationId ?? null,
    ] as const,
  employeeShifts: (employeeId: string, from: string | null) =>
    ["org", "shifts", "employee", employeeId, from] as const,
  locations: ["org", "locations"] as const,
  employeeSearch: (search: string) => ["org", "employees", "search", search] as const,
  employee: (id: string) => ["org", "employees", "detail", id] as const,
};

export interface ShiftsQueryInput {
  /** ISO instants (UTC). */
  from: string;
  to: string;
  employeeId?: string | null;
  locationId?: string | null;
}

export function useShifts(input: ShiftsQueryInput | null) {
  return useQuery({
    queryKey: input ? scheduleKeys.shifts(input) : ["org", "shifts", "range", "disabled"],
    enabled: input !== null,
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => {
      if (!input) return [] as Shift[];
      const response = await api.get<ListShiftsResponse>(
        "/api/shifts",
        {
          from: input.from,
          to: input.to,
          employeeId: input.employeeId ?? undefined,
          locationId: input.locationId ?? undefined,
        },
        signal,
      );
      return response.shifts;
    },
  });
}

/** How far past `from` (or now) the series lookup reaches; the recurrence job materialises only 8 weeks ahead. */
const SERIES_LOOKAHEAD_MS = 400 * 86_400_000;

/**
 * `GET /api/employees/:id/shifts?from&to&limit` — used to find the later members of a recurrence series.
 * `to` is sent explicitly because the API's default window ends about three months after `from`.
 */
export async function fetchEmployeeShiftsFrom(employeeId: string, from: string): Promise<Shift[]> {
  const to = new Date(Math.max(Date.parse(from), Date.now()) + SERIES_LOOKAHEAD_MS).toISOString();
  const response = await api.get<ListShiftsResponse>(
    `/api/employees/${encodeURIComponent(employeeId)}/shifts`,
    { from, to, limit: 200 },
  );
  return response.shifts;
}

export function useLocations() {
  return useQuery({
    queryKey: scheduleKeys.locations,
    staleTime: 60_000,
    queryFn: async ({ signal }) =>
      (await api.get<ListLocationsResponse>("/api/locations", undefined, signal)).locations,
  });
}

export function useEmployeeSearch(search: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: scheduleKeys.employeeSearch(search),
    enabled: options.enabled ?? true,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const response = await api.get<ListEmployeesResponse>(
        "/api/employees",
        {
          search: search.trim() || undefined,
          pageSize: 50,
          sort: "lastName",
          employmentStatus: "ACTIVE",
        },
        signal,
      );
      return response.items;
    },
  });
}

export function useEmployee(id: string | null) {
  return useQuery({
    queryKey: scheduleKeys.employee(id ?? ""),
    enabled: id !== null,
    staleTime: 60_000,
    queryFn: async ({ signal }) =>
      (
        await api.get<EmployeeDetailResponse>(
          `/api/employees/${encodeURIComponent(id ?? "")}`,
          undefined,
          signal,
        )
      ).employee,
  });
}

export type { Employee, Location };

// ── Mutations ───────────────────────────────────────────────────────────────

export function invalidateShifts(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: scheduleKeys.shiftsRoot });
}

/** Replaces a shift in every cached range list (optimistic updates and server responses). */
export function replaceShiftInCache(queryClient: QueryClient, shift: Shift) {
  queryClient.setQueriesData<Shift[]>({ queryKey: scheduleKeys.shiftsRoot }, (current) =>
    current ? current.map((s) => (s.id === shift.id ? shift : s)) : current,
  );
}

export function useCreateShift() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateShiftInput) => api.post<CreateShiftResponse>("/api/shifts", input),
    onSuccess: () => invalidateShifts(queryClient),
  });
}

/** Request body for `PATCH /api/shifts/:id` (schema input type: `notes` is a transform). */
export type UpdateShiftBody = z.input<typeof updateShiftSchema>;

export interface UpdateShiftVariables {
  id: string;
  input: UpdateShiftBody;
  /** When given, the cache shows this version until the server answers (rolled back on error). */
  optimistic?: Shift | null;
}

export function useUpdateShift() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: UpdateShiftVariables) =>
      api.patch<ShiftResponse>(`/api/shifts/${encodeURIComponent(id)}`, input),
    onMutate: async ({ optimistic }) => {
      if (!optimistic) return { snapshot: null };
      await queryClient.cancelQueries({ queryKey: scheduleKeys.shiftsRoot });
      const snapshot = queryClient.getQueriesData<Shift[]>({ queryKey: scheduleKeys.shiftsRoot });
      replaceShiftInCache(queryClient, optimistic);
      return { snapshot };
    },
    onError: (_error, _variables, context) => {
      for (const [key, data] of context?.snapshot ?? []) queryClient.setQueryData(key, data);
    },
    onSuccess: (response) => {
      replaceShiftInCache(queryClient, response.shift);
    },
    onSettled: () => invalidateShifts(queryClient),
  });
}

export function useDeleteShift() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/shifts/${encodeURIComponent(id)}`),
    onSuccess: () => invalidateShifts(queryClient),
  });
}

export function useDuplicateShift() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: DuplicateShiftInput }) =>
      api.post<ShiftResponse>(`/api/shifts/${encodeURIComponent(id)}/duplicate`, input),
    onSuccess: () => invalidateShifts(queryClient),
  });
}

export function useCancelShift() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: CancelShiftInput }) =>
      api.post<ShiftResponse>(`/api/shifts/${encodeURIComponent(id)}/cancel`, input),
    onSuccess: (response) => {
      replaceShiftInCache(queryClient, response.shift);
      return invalidateShifts(queryClient);
    },
  });
}

export function useBulkShiftAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: BulkShiftActionInput) =>
      api.post<BulkShiftActionResponse>("/api/shifts/bulk", input),
    onSuccess: () => invalidateShifts(queryClient),
  });
}
