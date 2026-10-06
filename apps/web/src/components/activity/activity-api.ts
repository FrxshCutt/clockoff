"use client";

import { listActivityResponseSchema, type ActivityEvent, type ListActivityResponse } from "@workmode/validation/activity";
import { listAuditLogsResponseSchema, type ListAuditLogsResponse } from "@workmode/validation/auditLogs";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { parseResponse } from "@/hooks/api-shapes";
import { api, type QueryParams } from "@/lib/api-client";
import type { DateInput } from "@/lib/format";
import { resolveDateRange, toActivityApiQuery, type ActivityFeedParams, type DateRangePreset } from "./activity-filters";
import { activityKeys, auditLogKeys } from "./activity-keys";

/**
 * Queries for the organisation activity feed (`GET /api/activity`) and the audit log (`GET /api/audit-logs`).
 * Both are cursor-paginated, newest first; responses are parsed against the validation schemas.
 */

export const ACTIVITY_PAGE_SIZE = 25;

/**
 * Infinite feed for `/activity`. Rolling presets ("last 7 days") are resolved to instants at fetch time, so
 * the query key stays stable while the window keeps up with the clock on each refetch.
 */
export function useActivityFeed(
  feed: ActivityFeedParams,
  timeZone: string,
  options: { enabled?: boolean; limit?: number } = {},
) {
  const limit = options.limit ?? ACTIVITY_PAGE_SIZE;
  return useInfiniteQuery({
    queryKey: activityKeys.feed({ ...feed, timeZone, limit }),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }): Promise<ListActivityResponse> => {
      const query = toActivityApiQuery(feed, Date.now(), timeZone, limit);
      const raw = await api.get<unknown>(
        "/api/activity",
        { ...query, ...(pageParam ? { cursor: pageParam } : {}) } as unknown as QueryParams,
        signal,
      );
      return parseResponse(listActivityResponseSchema, raw, "GET /api/activity");
    },
    getNextPageParam: (last) => last.nextCursor,
    enabled: options.enabled ?? true,
  });
}

/** The newest `limit` events for the overview card. */
export function useRecentActivity(limit = 20, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: activityKeys.feed({ recent: true, limit }),
    queryFn: async ({ signal }): Promise<ActivityEvent[]> =>
      parseResponse(listActivityResponseSchema, await api.get<unknown>("/api/activity", { limit }, signal), "GET /api/activity").items,
    enabled: options.enabled ?? true,
  });
}

export interface AuditLogListParams {
  readonly entityType: string | null;
  readonly action: string | null;
  readonly actorUserId: string | null;
  readonly range: DateRangePreset;
  /** `YYYY-MM-DD` in the organisation's zone; only used with `range: "custom"`. */
  readonly from: string | null;
  readonly to: string | null;
}

export const DEFAULT_AUDIT_LOG_PARAMS: AuditLogListParams = {
  entityType: null,
  action: null,
  actorUserId: null,
  range: "30d",
  from: null,
  to: null,
};

export const AUDIT_LOG_PAGE_SIZE = 50;

export function hasActiveAuditLogFilters(params: AuditLogListParams): boolean {
  return (
    Boolean(params.entityType?.trim()) ||
    Boolean(params.action?.trim()) ||
    params.actorUserId !== null ||
    params.range !== DEFAULT_AUDIT_LOG_PARAMS.range
  );
}

export function toAuditLogApiQuery(
  params: AuditLogListParams,
  now: DateInput,
  timeZone: string,
  limit: number,
): Record<string, string | number> {
  const query: Record<string, string | number> = { limit };
  if (params.entityType?.trim()) query.entityType = params.entityType.trim();
  if (params.action?.trim()) query.action = params.action.trim();
  if (params.actorUserId) query.actorUserId = params.actorUserId;
  const range = resolveDateRange(params, now, timeZone);
  if (range.from) query.from = range.from;
  if (range.to) query.to = range.to;
  return query;
}

/** Infinite audit log for `/audit-logs` (requires `audit:read`; the API answers FORBIDDEN otherwise). */
export function useAuditLogs(
  params: AuditLogListParams,
  timeZone: string,
  options: { enabled?: boolean; limit?: number } = {},
) {
  const limit = options.limit ?? AUDIT_LOG_PAGE_SIZE;
  return useInfiniteQuery({
    queryKey: auditLogKeys.list({ ...params, timeZone, limit }),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }): Promise<ListAuditLogsResponse> => {
      const raw = await api.get<unknown>(
        "/api/audit-logs",
        { ...toAuditLogApiQuery(params, Date.now(), timeZone, limit), ...(pageParam ? { cursor: pageParam } : {}) },
        signal,
      );
      return parseResponse(listAuditLogsResponseSchema, raw, "GET /api/audit-logs");
    },
    getNextPageParam: (last) => last.nextCursor,
    enabled: options.enabled ?? true,
  });
}
