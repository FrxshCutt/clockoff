"use client";

import {
  complianceEmployeesResponseSchema,
  complianceSummaryResponseSchema,
  type ComplianceEmployeesResponse,
  type ComplianceSummaryResponse,
} from "@workmode/validation/compliance";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { toComplianceApiQuery } from "@/components/activity/activity-filters";
import { parseResponse } from "@/hooks/api-shapes";
import { api, type QueryParams } from "@/lib/api-client";
import { complianceKeys, type ComplianceListParams } from "./compliance-keys";

/**
 * Queries for `/api/compliance/*`, typed by the `@workmode/validation` response schemas (every response is
 * parsed, so a contract drift surfaces as INVALID_RESPONSE naming the endpoint, never as `undefined` in the UI).
 */

/** Metric cards, upcoming shifts and integration status (`GET /api/compliance/summary`). */
export function useComplianceSummary(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: complianceKeys.summary,
    queryFn: async ({ signal }): Promise<ComplianceSummaryResponse> =>
      parseResponse(
        complianceSummaryResponseSchema,
        await api.get<unknown>("/api/compliance/summary", undefined, signal),
        "GET /api/compliance/summary",
      ),
    enabled: options.enabled ?? true,
    // Expected states move with the clock even when no device reports; realtime events refresh sooner.
    refetchInterval: 60_000,
  });
}

/** Employees behind a metric (`GET /api/compliance/employees?filter=…`), offset-paginated. */
export function useComplianceEmployees(params: ComplianceListParams, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: complianceKeys.employees(params),
    queryFn: async ({ signal }): Promise<ComplianceEmployeesResponse> =>
      parseResponse(
        complianceEmployeesResponseSchema,
        await api.get<unknown>("/api/compliance/employees", toComplianceApiQuery(params) as unknown as QueryParams, signal),
        "GET /api/compliance/employees",
      ),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });
}
