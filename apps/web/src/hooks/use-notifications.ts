"use client";

import { useQuery } from "@tanstack/react-query";
import { api, hasErrorCode } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-client";
import { EMPTY_NOTIFICATIONS, normalizeNotifications, type NotificationsFeed } from "./api-shapes";

export interface NotificationsState extends NotificationsFeed {
  /** False while `GET /api/notifications` does not exist on the server yet (404 / 501). */
  available: boolean;
}

/** In-app notifications for the bell. Degrades to an empty, "unavailable" feed until the endpoint ships. */
export function useNotifications(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.notifications,
    enabled: options.enabled ?? true,
    queryFn: async ({ signal }): Promise<NotificationsState> => {
      try {
        const raw = await api.get<unknown>("/api/notifications", undefined, signal);
        return { ...normalizeNotifications(raw), available: true };
      } catch (error) {
        if (hasErrorCode(error, "NOT_FOUND", "COMING_SOON")) return { ...EMPTY_NOTIFICATIONS, available: false };
        throw error;
      }
    },
    refetchInterval: (query) => (query.state.data?.available === false ? false : 60_000),
  });
}
