"use client";

import {
  deviceResponseSchema,
  listDevicesResponseSchema,
  type DeviceWithEmployee,
  type ListDevicesResponse,
} from "@workmode/validation/devices";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { employeeKeys } from "@/components/employees/employee-keys";
import { complianceKeys } from "@/components/overview/compliance-keys";
import { parseResponse } from "@/hooks/api-shapes";
import { api, type QueryParams } from "@/lib/api-client";
import { deviceKeys } from "./device-keys";
import { toDeviceApiQuery, type DeviceListParams } from "./device-model";

/** Queries and mutations for `/api/devices`, parsed against the validation schemas (§12 fields only). */

const encode = encodeURIComponent;

export function useDevices(params: DeviceListParams, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: deviceKeys.list({ ...params }),
    queryFn: async ({ signal }): Promise<ListDevicesResponse> =>
      parseResponse(
        listDevicesResponseSchema,
        await api.get<unknown>(
          "/api/devices",
          toDeviceApiQuery(params) as unknown as QueryParams,
          signal,
        ),
        "GET /api/devices",
      ),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });
}

export function useDevice(id: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: deviceKeys.detail(id),
    queryFn: async ({ signal }): Promise<DeviceWithEmployee> =>
      parseResponse(
        deviceResponseSchema,
        await api.get<unknown>(`/api/devices/${encode(id)}`, undefined, signal),
        "GET /api/devices/:id",
      ),
    enabled: options.enabled ?? true,
  });
}

/**
 * `POST /api/devices/:id/deactivate`: revokes the phone's tokens so it must join again. Everything that
 * shows device state (device lists, employee rows, compliance metrics) is refetched afterwards.
 */
export function useDeactivateDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      reason,
    }: {
      id: string;
      reason?: string;
    }): Promise<DeviceWithEmployee> => {
      const trimmed = reason?.trim();
      return parseResponse(
        deviceResponseSchema,
        await api.post<unknown>(
          `/api/devices/${encode(id)}/deactivate`,
          trimmed ? { reason: trimmed } : {},
        ),
        "POST /api/devices/:id/deactivate",
      );
    },
    onSuccess: async (result, { id }) => {
      queryClient.setQueryData(deviceKeys.detail(id), result);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: deviceKeys.all }),
        queryClient.invalidateQueries({ queryKey: employeeKeys.all }),
        queryClient.invalidateQueries({ queryKey: complianceKeys.all }),
      ]);
    },
  });
}
