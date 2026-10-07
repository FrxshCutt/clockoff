"use client";

import type { ActivityEventType, InviteChannel } from "@clockoff/shared/enums";
import {
  listActivityResponseSchema,
  type ListActivityResponse,
} from "@clockoff/validation/activity";
import {
  listBreakPoliciesResponseSchema,
  type BreakPolicy,
} from "@clockoff/validation/breakPolicies";
import {
  bulkEmployeeActionResponseSchema,
  employeeDetailResponseSchema,
  employeeResponseSchema,
  employeeStateResponseSchema,
  listEmployeesResponseSchema,
  type AssignEmployeeBreakPolicyInput,
  type AssignEmployeePolicyInput,
  type BulkEmployeeActionInput,
  type BulkEmployeeActionResponse,
  type CreateEmployeeInput,
  type Employee,
  type EmployeeDetail,
  type EmployeeStateResponse,
  type ListEmployeesResponse,
  type UpdateEmployeeInput,
} from "@clockoff/validation/employees";
import {
  createEmployeeInviteResponseSchema,
  employeeInviteResponseSchema,
  inviteInstructionsResponseSchema,
  type CreateEmployeeInviteResponse,
  type EmployeeInvite,
  type InviteInstructions,
} from "@clockoff/validation/invites";
import {
  listDepartmentsResponseSchema,
  listLocationsResponseSchema,
  listTeamsResponseSchema,
  type Department,
  type Location,
  type Team,
} from "@clockoff/validation/locationsTeams";
import {
  listOverridesResponseSchema,
  overrideResponseSchema,
  type CreateOverrideInput,
  type ListOverridesResponse,
  type Override,
  type OverrideStatus,
} from "@clockoff/validation/overrides";
import { listPoliciesResponseSchema, type Policy } from "@clockoff/validation/policies";
import {
  createShiftResponseSchema,
  listShiftsResponseSchema,
  type CreateShiftInput,
  type CreateShiftResponse,
  type Shift,
} from "@clockoff/validation/shifts";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { parseResponse } from "@/hooks/api-shapes";
import { api, type QueryParams } from "@/lib/api-client";
import { toEmployeeApiQuery, type EmployeeListParams } from "./employee-filters";
import { employeeKeys, inviteKeys, overrideKeys, referenceKeys } from "./employee-keys";

/**
 * Queries and mutations for the employee domain, typed by the `@clockoff/validation` response schemas (every
 * response is parsed, so a contract drift surfaces as INVALID_RESPONSE naming the endpoint, never as
 * `undefined` in the UI).
 */

const encode = encodeURIComponent;

// ── Reads ───────────────────────────────────────────────────────────────────

export function useEmployees(params: EmployeeListParams, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: employeeKeys.list(params),
    queryFn: async ({ signal }): Promise<ListEmployeesResponse> => {
      const raw = await api.get<unknown>(
        "/api/employees",
        toEmployeeApiQuery(params) as unknown as QueryParams,
        signal,
      );
      return parseResponse(listEmployeesResponseSchema, raw, "GET /api/employees");
    },
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });
}

/** Lightweight search for the picker (first page of active employees matching `search`). */
export function useEmployeeSearch(
  search: string,
  options: { enabled?: boolean; pageSize?: number } = {},
) {
  const trimmed = search.trim();
  return useQuery({
    queryKey: employeeKeys.picker(trimmed),
    queryFn: async ({ signal }): Promise<Employee[]> => {
      const raw = await api.get<unknown>(
        "/api/employees",
        {
          page: 1,
          pageSize: options.pageSize ?? 20,
          sort: "lastName",
          employmentStatus: ["ACTIVE"],
          ...(trimmed ? { search: trimmed } : {}),
        },
        signal,
      );
      return parseResponse(listEmployeesResponseSchema, raw, "GET /api/employees").items;
    },
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
    staleTime: 30_000,
  });
}

export function useEmployee(id: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: employeeKeys.detail(id),
    queryFn: async ({ signal }): Promise<EmployeeDetail> => {
      const raw = await api.get<unknown>(`/api/employees/${encode(id)}`, undefined, signal);
      return parseResponse(employeeDetailResponseSchema, raw, "GET /api/employees/:id").employee;
    },
    enabled: options.enabled ?? true,
  });
}

/** `GET /api/employees/:id/state` — refreshed every minute while the page is open (expected state moves with the clock). */
export function useEmployeeState(
  id: string,
  window: { from: string; to: string } | null,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: employeeKeys.state(id, window),
    queryFn: async ({ signal }): Promise<EmployeeStateResponse> => {
      const raw = await api.get<unknown>(
        `/api/employees/${encode(id)}/state`,
        window ?? undefined,
        signal,
      );
      return parseResponse(employeeStateResponseSchema, raw, "GET /api/employees/:id/state");
    },
    enabled: options.enabled ?? true,
    refetchInterval: 60_000,
  });
}

export type EmployeeShiftsParams = {
  from?: string;
  to?: string;
  limit?: number;
};

export function useEmployeeShifts(
  id: string,
  params: EmployeeShiftsParams,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: employeeKeys.shifts(id, params),
    queryFn: async ({ signal }): Promise<Shift[]> => {
      const raw = await api.get<unknown>(`/api/employees/${encode(id)}/shifts`, params, signal);
      return parseResponse(listShiftsResponseSchema, raw, "GET /api/employees/:id/shifts").shifts;
    },
    enabled: options.enabled ?? true,
  });
}

export type EmployeeActivityParams = {
  type?: readonly ActivityEventType[];
  from?: string;
  to?: string;
  limit?: number;
};

export function useEmployeeActivity(
  id: string,
  params: EmployeeActivityParams,
  options: { enabled?: boolean } = {},
) {
  return useInfiniteQuery({
    queryKey: employeeKeys.activity(id, params),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }): Promise<ListActivityResponse> => {
      const raw = await api.get<unknown>(
        `/api/employees/${encode(id)}/activity`,
        { ...params, limit: params.limit ?? 25, ...(pageParam ? { cursor: pageParam } : {}) },
        signal,
      );
      return parseResponse(listActivityResponseSchema, raw, "GET /api/employees/:id/activity");
    },
    getNextPageParam: (last) => last.nextCursor,
    enabled: options.enabled ?? true,
  });
}

export type OverridesParams = {
  employeeId?: string;
  status?: readonly OverrideStatus[];
  limit?: number;
};

export function useOverrides(params: OverridesParams, options: { enabled?: boolean } = {}) {
  return useInfiniteQuery({
    queryKey: overrideKeys.list(params),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }): Promise<ListOverridesResponse> => {
      const raw = await api.get<unknown>(
        "/api/overrides",
        { ...params, limit: params.limit ?? 50, ...(pageParam ? { cursor: pageParam } : {}) },
        signal,
      );
      return parseResponse(listOverridesResponseSchema, raw, "GET /api/overrides");
    },
    getNextPageParam: (last) => last.nextCursor,
    enabled: options.enabled ?? true,
  });
}

export function useInviteInstructions(
  inviteId: string | null,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: inviteKeys.instructions(inviteId ?? ""),
    queryFn: async ({ signal }): Promise<InviteInstructions> => {
      const raw = await api.get<unknown>(
        `/api/invites/${encode(inviteId ?? "")}/instructions`,
        undefined,
        signal,
      );
      return parseResponse(
        inviteInstructionsResponseSchema,
        raw,
        "GET /api/invites/:id/instructions",
      ).instructions;
    },
    enabled: (options.enabled ?? true) && inviteId !== null,
  });
}

// ── Reference lists ─────────────────────────────────────────────────────────

const REFERENCE_STALE_MS = 60_000;

export function usePolicies(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: referenceKeys.policies,
    queryFn: async ({ signal }): Promise<Policy[]> => {
      const raw = await api.get<unknown>("/api/policies", undefined, signal);
      return parseResponse(listPoliciesResponseSchema, raw, "GET /api/policies").policies;
    },
    staleTime: REFERENCE_STALE_MS,
    enabled: options.enabled ?? true,
  });
}

export function useBreakPolicies(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: referenceKeys.breakPolicies,
    queryFn: async ({ signal }): Promise<BreakPolicy[]> => {
      const raw = await api.get<unknown>("/api/break-policies", undefined, signal);
      return parseResponse(listBreakPoliciesResponseSchema, raw, "GET /api/break-policies")
        .breakPolicies;
    },
    staleTime: REFERENCE_STALE_MS,
    enabled: options.enabled ?? true,
  });
}

export function useLocations(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: referenceKeys.locations,
    queryFn: async ({ signal }): Promise<Location[]> => {
      const raw = await api.get<unknown>("/api/locations", undefined, signal);
      return parseResponse(listLocationsResponseSchema, raw, "GET /api/locations").locations;
    },
    staleTime: REFERENCE_STALE_MS,
    enabled: options.enabled ?? true,
  });
}

export function useDepartments(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: referenceKeys.departments,
    queryFn: async ({ signal }): Promise<Department[]> => {
      const raw = await api.get<unknown>("/api/departments", undefined, signal);
      return parseResponse(listDepartmentsResponseSchema, raw, "GET /api/departments").departments;
    },
    staleTime: REFERENCE_STALE_MS,
    enabled: options.enabled ?? true,
  });
}

export function useTeams(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: referenceKeys.teams,
    queryFn: async ({ signal }): Promise<Team[]> => {
      const raw = await api.get<unknown>("/api/teams", undefined, signal);
      return parseResponse(listTeamsResponseSchema, raw, "GET /api/teams").teams;
    },
    staleTime: REFERENCE_STALE_MS,
    enabled: options.enabled ?? true,
  });
}

// ── Mutations ───────────────────────────────────────────────────────────────

/** Everything derived from employees (lists, detail, state, shifts, activity) is refetched after a mutation. */
export async function invalidateEmployees(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: employeeKeys.all });
}

function parseEmployee(raw: unknown, endpoint: string): Employee {
  return parseResponse(employeeResponseSchema, raw, endpoint).employee;
}

export function useCreateEmployee() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateEmployeeInput) =>
      parseEmployee(await api.post<unknown>("/api/employees", input), "POST /api/employees"),
    onSuccess: () => invalidateEmployees(queryClient),
  });
}

export function useUpdateEmployee() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: UpdateEmployeeInput }) =>
      parseEmployee(
        await api.patch<unknown>(`/api/employees/${encode(id)}`, input),
        "PATCH /api/employees/:id",
      ),
    onSuccess: () => invalidateEmployees(queryClient),
  });
}

export type EmployeeLifecycleAction = "deactivate" | "reactivate" | "archive";

export function useEmployeeLifecycleAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      action,
      reason,
    }: {
      id: string;
      action: EmployeeLifecycleAction;
      reason?: string;
    }) => {
      const body = action === "deactivate" && reason?.trim() ? { reason: reason.trim() } : {};
      return parseEmployee(
        await api.post<unknown>(`/api/employees/${encode(id)}/${action}`, body),
        `POST /api/employees/:id/${action}`,
      );
    },
    onSuccess: () => invalidateEmployees(queryClient),
  });
}

export function useAssignEmployeePolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, policyId }: { id: string } & AssignEmployeePolicyInput) =>
      parseEmployee(
        await api.post<unknown>(`/api/employees/${encode(id)}/assign-policy`, { policyId }),
        "POST /api/employees/:id/assign-policy",
      ),
    onSuccess: () => invalidateEmployees(queryClient),
  });
}

export function useAssignEmployeeBreakPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, breakPolicyId }: { id: string } & AssignEmployeeBreakPolicyInput) =>
      parseEmployee(
        await api.post<unknown>(`/api/employees/${encode(id)}/assign-break-policy`, {
          breakPolicyId,
        }),
        "POST /api/employees/:id/assign-break-policy",
      ),
    onSuccess: () => invalidateEmployees(queryClient),
  });
}

export function useBulkEmployeeAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: BulkEmployeeActionInput): Promise<BulkEmployeeActionResponse> =>
      parseResponse(
        bulkEmployeeActionResponseSchema,
        await api.post<unknown>("/api/employees/bulk", input),
        "POST /api/employees/bulk",
      ),
    onSuccess: () => invalidateEmployees(queryClient),
  });
}

export function useCreateInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      employeeId,
      channel,
    }: {
      employeeId: string;
      channel: InviteChannel;
    }): Promise<CreateEmployeeInviteResponse> =>
      parseResponse(
        createEmployeeInviteResponseSchema,
        await api.post<unknown>(`/api/employees/${encode(employeeId)}/invites`, { channel }),
        "POST /api/employees/:id/invites",
      ),
    onSuccess: () => invalidateEmployees(queryClient),
  });
}

export function useResendInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      inviteId,
      channel,
    }: {
      inviteId: string;
      channel?: InviteChannel;
    }): Promise<EmployeeInvite> =>
      parseResponse(
        employeeInviteResponseSchema,
        await api.post<unknown>(
          `/api/invites/${encode(inviteId)}/resend`,
          channel ? { channel } : {},
        ),
        "POST /api/invites/:id/resend",
      ).invite,
    onSuccess: async (_invite, { inviteId }) => {
      await Promise.all([
        invalidateEmployees(queryClient),
        queryClient.invalidateQueries({ queryKey: inviteKeys.instructions(inviteId) }),
      ]);
    },
  });
}

export function useRevokeInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ inviteId }: { inviteId: string }): Promise<EmployeeInvite> =>
      parseResponse(
        employeeInviteResponseSchema,
        await api.post<unknown>(`/api/invites/${encode(inviteId)}/revoke`, {}),
        "POST /api/invites/:id/revoke",
      ).invite,
    onSuccess: () => invalidateEmployees(queryClient),
  });
}

export function useCreateOverride() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateOverrideInput): Promise<Override> =>
      parseResponse(
        overrideResponseSchema,
        await api.post<unknown>("/api/overrides", input),
        "POST /api/overrides",
      ).override,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: overrideKeys.all }),
        invalidateEmployees(queryClient),
      ]);
    },
  });
}

export function useRevokeOverride() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason?: string }): Promise<Override> =>
      parseResponse(
        overrideResponseSchema,
        await api.post<unknown>(
          `/api/overrides/${encode(id)}/revoke`,
          reason?.trim() ? { reason: reason.trim() } : {},
        ),
        "POST /api/overrides/:id/revoke",
      ).override,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: overrideKeys.all }),
        invalidateEmployees(queryClient),
      ]);
    },
  });
}

export function useCreateShift() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateShiftInput): Promise<CreateShiftResponse> =>
      parseResponse(
        createShiftResponseSchema,
        await api.post<unknown>("/api/shifts", input),
        "POST /api/shifts",
      ),
    onSuccess: async () => {
      await Promise.all([
        invalidateEmployees(queryClient),
        // The schedule page caches shifts under its own keys; refresh anything organisation-scoped that lists them.
        queryClient.invalidateQueries({ queryKey: ["org", "shifts"] }),
      ]);
    },
  });
}
