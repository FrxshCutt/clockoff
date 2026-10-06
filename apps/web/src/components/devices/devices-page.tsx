"use client";

import { PERMISSION_STATES } from "@workmode/shared/enums";
import type { DeviceWithEmployee } from "@workmode/validation/devices";
import { functionalUpdate, type OnChangeFn, type PaginationState } from "@tanstack/react-table";
import { X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useMemo } from "react";
import { MultiSelectFilter } from "@/components/activity/multi-select-filter";
import { useUrlState } from "@/components/activity/use-url-state";
import { DataTable } from "@/components/data-table";
import { PERMISSION_STATE_GUIDANCE } from "@/components/employees/employee-view-model";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { TableSkeleton } from "@/components/loading-skeletons";
import { PageHeader } from "@/components/page-header";
import { RealtimeProvider, RealtimeStatusIndicator } from "@/components/realtime";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EMPTY_STATES } from "@/config/emptyStates";
import { routeFor } from "@/config/navigation";
import { useDevices } from "./device-api";
import { deviceColumns } from "./device-columns";
import {
  DEFAULT_DEVICE_LIST_PARAMS,
  DEVICE_ACTIVE_FILTERS,
  DEVICE_ACTIVE_FILTER_LABELS,
  DEVICE_PAGE_SIZES,
  hasActiveDeviceFilters,
  isDeviceActiveFilter,
  parseDeviceListParams,
  serializeDeviceListParams,
  type DeviceListParams,
} from "./device-model";

const PERMISSION_OPTIONS = PERMISSION_STATES.map((value) => ({ value, label: PERMISSION_STATE_GUIDANCE[value].label }));

/**
 * `/devices`: every phone that has joined, with the operational signals a manager may see (§12). The page
 * frame renders straight away; the table reads its filters from the URL, so it sits behind its own Suspense
 * boundary (as Next requires for `useSearchParams`). Rows open the device page.
 */
export function DevicesPage() {
  return (
    <RealtimeProvider>
      <PageHeader
        title="Devices"
        description="Phones connected to Work Mode, with Screen Time permission and sync status."
        actions={<RealtimeStatusIndicator />}
      />
      <Suspense fallback={<TableSkeleton />}>
        <DevicesTable />
      </Suspense>
    </RealtimeProvider>
  );
}

/** The filterable, server-paginated table; owns the URL state (`?active=&permission=&employee=&location=&page=&pageSize=`). */
function DevicesTable() {
  const router = useRouter();
  const [params, setParams] = useUrlState<DeviceListParams>(parseDeviceListParams, serializeDeviceListParams);
  const query = useDevices(params);
  const columns = useMemo(() => deviceColumns(), []);

  const onPaginationChange: OnChangeFn<PaginationState> = (updater) => {
    const next = functionalUpdate(updater, { pageIndex: params.page - 1, pageSize: params.pageSize });
    setParams({ ...params, page: next.pageIndex + 1, pageSize: next.pageSize });
  };

  const filtersActive = hasActiveDeviceFilters(params);
  const copy = EMPTY_STATES.devices;
  const searchCopy = EMPTY_STATES.search;

  if (query.isError) {
    return <ErrorState title="Couldn't load devices" error={query.error} onRetry={() => void query.refetch()} isRetrying={query.isRefetching} />;
  }

  return (
    <div className="space-y-4">
      <DataTable<DeviceWithEmployee>
        label="Devices"
        columns={columns}
        data={query.data?.items}
        isLoading={query.isPending}
        getRowId={(row) => row.device.id}
        manualFiltering
        manualPagination
        rowCount={query.data?.total ?? 0}
        pagination={{ pageIndex: params.page - 1, pageSize: params.pageSize }}
        onPaginationChange={onPaginationChange}
        pageSizeOptions={DEVICE_PAGE_SIZES}
        toolbar={() => (
          <>
            <Select
              value={params.active}
              onValueChange={(next) => {
                if (isDeviceActiveFilter(next)) setParams({ ...params, active: next, page: 1 });
              }}
            >
              <SelectTrigger size="sm" className="h-9 w-48" aria-label="Show active or deactivated devices">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DEVICE_ACTIVE_FILTERS.map((filter) => (
                  <SelectItem key={filter} value={filter}>
                    {DEVICE_ACTIVE_FILTER_LABELS[filter]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <MultiSelectFilter
              title="Permission"
              options={PERMISSION_OPTIONS}
              value={params.permission}
              onChange={(permission) => setParams({ ...params, permission, page: 1 })}
            />
            {filtersActive ? (
              <Button type="button" variant="ghost" size="sm" className="h-9" onClick={() => setParams(DEFAULT_DEVICE_LIST_PARAMS)}>
                Reset
                <X aria-hidden="true" />
              </Button>
            ) : null}
          </>
        )}
        onRowClick={(row) => router.push(routeFor.device(row.device.id))}
        getRowLabel={(row) => `Open ${row.employee.firstName} ${row.employee.lastName}'s device`}
        emptyState={
          filtersActive ? (
            <EmptyState
              icon={searchCopy.icon}
              title={searchCopy.title}
              description={searchCopy.description}
              action={
                <Button type="button" variant="outline" size="sm" onClick={() => setParams(DEFAULT_DEVICE_LIST_PARAMS)}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={copy.icon}
              title={copy.title}
              description={copy.description}
              action={
                copy.action?.href ? (
                  <Button asChild>
                    <Link href={copy.action.href}>{copy.action.label}</Link>
                  </Button>
                ) : undefined
              }
            />
          )
        }
      />
      <p className="text-muted-foreground text-xs">
        Devices report operational status only: setup, permission, selection counts, sync and app version. Work Mode never
        receives which apps were chosen, messages, browsing, location or anything else on the phone.
      </p>
    </div>
  );
}
