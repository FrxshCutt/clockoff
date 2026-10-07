"use client";

import { COMPLIANCE_FILTERS } from "@clockoff/validation/compliance";
import type { ComplianceEmployeeRow } from "@clockoff/validation/compliance";
import { functionalUpdate, type OnChangeFn, type PaginationState } from "@tanstack/react-table";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { DataTable } from "@/components/data-table";
import { useDebouncedCallback } from "@/components/employees/use-debounced-callback";
import { useLocations } from "@/components/employees/employee-api";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { useComplianceEmployees } from "@/components/overview/compliance-api";
import type { ComplianceListParams } from "@/components/overview/compliance-keys";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { EMPTY_STATES } from "@/config/emptyStates";
import { ROUTES, routeFor } from "@/config/navigation";
import { useCurrentOrganisation } from "@/hooks/use-organisation";
import Link from "next/link";
import {
  COMPLIANCE_PAGE_SIZES,
  DEFAULT_COMPLIANCE_PARAMS,
  hasActiveComplianceFilters,
  isComplianceFilter,
} from "./activity-filters";
import { complianceColumns } from "./compliance-columns";
import { COMPLIANCE_FILTER_META } from "./compliance-model";

const ALL_LOCATIONS = "__all__";

export interface ComplianceTableProps {
  params: ComplianceListParams;
  onChange: (next: ComplianceListParams) => void;
}

/**
 * Every active employee with expected vs reported Work Mode state, last sync, Screen Time permission and
 * what needs attention (`GET /api/compliance/employees`). Filter chips match the overview metrics one-to-one.
 * Nothing here is exportable: it is a live operational view, not a report about people.
 */
export function ComplianceTable({ params, onChange }: ComplianceTableProps) {
  const router = useRouter();
  const query = useComplianceEmployees(params);
  const locations = useLocations();
  const timeZone = useCurrentOrganisation().data?.organisation.timezone;
  const columns = useMemo(() => complianceColumns(timeZone), [timeZone]);

  // Local echo of the search box so typing is instant while the URL (and the request) update debounced.
  const [search, setSearch] = useState({ value: params.search, source: params.search });
  if (search.source !== params.search) setSearch({ value: params.search, source: params.search });
  const pushSearch = useDebouncedCallback(
    (value: string) => onChange({ ...params, search: value, page: 1 }),
    300,
  );

  const onPaginationChange: OnChangeFn<PaginationState> = (updater) => {
    const next = functionalUpdate(updater, {
      pageIndex: params.page - 1,
      pageSize: params.pageSize,
    });
    onChange({ ...params, page: next.pageIndex + 1, pageSize: next.pageSize });
  };

  const filtersActive = hasActiveComplianceFilters(params);
  const employeesCopy = EMPTY_STATES.employees;
  const searchCopy = EMPTY_STATES.search;

  if (query.isError) {
    return (
      <ErrorState
        title="Couldn't load compliance"
        error={query.error}
        onRetry={() => void query.refetch()}
        isRetrying={query.isRefetching}
      />
    );
  }

  return (
    <div className="space-y-4">
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        spacing={2}
        value={params.filter}
        onValueChange={(next) => {
          if (isComplianceFilter(next)) onChange({ ...params, filter: next, page: 1 });
        }}
        aria-label="Compliance filter"
        className="flex-wrap"
      >
        {COMPLIANCE_FILTERS.map((filter) => (
          <ToggleGroupItem
            key={filter}
            value={filter}
            title={COMPLIANCE_FILTER_META[filter].description}
            className="h-8 rounded-full px-3 text-xs"
          >
            {COMPLIANCE_FILTER_META[filter].label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <DataTable<ComplianceEmployeeRow>
        label="Compliance"
        columns={columns}
        data={query.data?.items}
        isLoading={query.isPending}
        getRowId={(row) => row.employee.id}
        searchable
        searchPlaceholder="Search employees…"
        globalFilter={search.value}
        onGlobalFilterChange={(value) => {
          setSearch((previous) => ({ ...previous, value }));
          pushSearch(value);
        }}
        manualFiltering
        manualPagination
        rowCount={query.data?.total ?? 0}
        pagination={{ pageIndex: params.page - 1, pageSize: params.pageSize }}
        onPaginationChange={onPaginationChange}
        pageSizeOptions={COMPLIANCE_PAGE_SIZES}
        toolbar={() => (
          <Select
            value={params.locationId ?? ALL_LOCATIONS}
            onValueChange={(next) =>
              onChange({ ...params, locationId: next === ALL_LOCATIONS ? null : next, page: 1 })
            }
          >
            <SelectTrigger size="sm" className="h-9 w-44" aria-label="Filter by location">
              <SelectValue placeholder="All locations" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_LOCATIONS}>All locations</SelectItem>
              {(locations.data ?? []).map((location) => (
                <SelectItem key={location.id} value={location.id}>
                  {location.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        onRowClick={(row) => router.push(routeFor.employee(row.employee.id))}
        getRowLabel={(row) => `Open ${row.employee.firstName} ${row.employee.lastName}`}
        emptyState={
          filtersActive ? (
            <EmptyState
              icon={searchCopy.icon}
              title={searchCopy.title}
              description={searchCopy.description}
              action={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onChange(DEFAULT_COMPLIANCE_PARAMS)}
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={employeesCopy.icon}
              title={employeesCopy.title}
              description={employeesCopy.description}
              action={
                <Button asChild>
                  <Link href={ROUTES.employees}>Go to employees</Link>
                </Button>
              }
            />
          )
        }
      />
    </div>
  );
}
