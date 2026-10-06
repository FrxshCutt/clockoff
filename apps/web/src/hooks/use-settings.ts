"use client";

import type { NotificationPreferences, UpdateNotificationPreferencesInput } from "@workmode/validation/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, hasErrorCode } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-client";
import { normalizeBilling, normalizeNotificationPreferences, type BillingSummary } from "./api-shapes";

/**
 * `/api/settings` (the caller's notification preferences) and `/api/settings/billing`. Both endpoints may not
 * be deployed yet; a 404 / 501 resolves to `{ available: false }` so the UI can explain instead of erroring.
 */

export type Availability<T> = { available: true; data: T } | { available: false; data: null };

function isMissingEndpoint(error: unknown): boolean {
  return hasErrorCode(error, "NOT_FOUND", "COMING_SOON");
}

export function useNotificationPreferences(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.notificationPreferences,
    enabled: options.enabled ?? true,
    queryFn: async ({ signal }): Promise<Availability<NotificationPreferences>> => {
      try {
        const raw = await api.get<unknown>("/api/settings", undefined, signal);
        return { available: true, data: normalizeNotificationPreferences(raw) };
      } catch (error) {
        if (isMissingEndpoint(error)) return { available: false, data: null };
        throw error;
      }
    },
  });
}

/** `PATCH /api/settings { notificationPreferences }` — only ever changes the caller's own preferences. */
export function useUpdateNotificationPreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch: UpdateNotificationPreferencesInput) => {
      const raw = await api.patch<unknown>("/api/settings", { notificationPreferences: patch });
      return normalizeNotificationPreferences(raw);
    },
    onSuccess: (preferences) => {
      queryClient.setQueryData<Availability<NotificationPreferences>>(queryKeys.notificationPreferences, {
        available: true,
        data: preferences,
      });
    },
  });
}

export function useBilling(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.billing,
    enabled: options.enabled ?? true,
    queryFn: async ({ signal }): Promise<Availability<BillingSummary>> => {
      try {
        const raw = await api.get<unknown>("/api/settings/billing", undefined, signal);
        return { available: true, data: normalizeBilling(raw) };
      } catch (error) {
        if (isMissingEndpoint(error)) return { available: false, data: null };
        throw error;
      }
    },
  });
}
