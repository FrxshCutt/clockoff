"use client";

import type { Employee } from "@workmode/validation/employees";
import type { PaginationState, SortingState } from "@tanstack/react-table";
import { UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EMPTY_STATES } from "@/config/emptyStates";
import { routeFor } from "@/config/navigation";
import { usePermission } from "@/hooks/use-current-user";
import { useCurrentOrganisation } from "@/hooks/use-organisation";
import {
  EmployeeActionDialogs,
  type EmployeeActionRequest,
  type EmployeeDialogAction,
} from "./employee-action-dialogs";
import { useEmployees } from "./employee-api";
import { EmployeeBulkActions } from "./employee-bulk-actions";
import { buildEmployeeColumns } from "./employee-columns";
import { EmployeeFilterBar } from "./employee-filter-bar";
import {
  EMPLOYEE_PAGE_SIZES,
  columnSortingToSortKey,
  hasActiveEmployeeFilters,
  parseEmployeeListParams,
  serializeEmployeeListParams,
  sortKeyToColumnSorting,
  type EmployeeListParams,
} from "./employee-filters";
import { EmployeeFormSheet } from "./employee-form-sheet";
import { employeeFullName } from "./employee-view-model";
import { useDebouncedCallback } from "./use-debounced-callback";
import { useNow } from "./use-now";

export interface EmployeesPageProps {
  /** The raw `searchParams` of the request; parsed once, then the page owns the state and mirrors it to the URL. */
  initialSearch: Readonly<Record<string, string | readonly string[] | undefined>>;
}

/**
 * /employees — server-paginated, filterable list. Filters, search, paging and sort live in component state
 * and are mirrored to the URL (`?filter=needsAttention&q=…&page=2`) so views can be linked from Overview.
 */
export function EmployeesPage({ initialSearch }: EmployeesPageProps) {
  const router = useRouter();
  const [params, setParams] = useState<EmployeeListParams>(() =>
    parseEmployeeListParams(initialSearch),
  );
  const [searchInput, setSearchInput] = useState(params.search);
  const [request, setRequest] = useState<EmployeeActionRequest | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const canWrite = usePermission("employees:write");
  const organisation = useCurrentOrganisation();
  const now = useNow();
  const query = useEmployees(params);

  // Mirror state → URL without a navigation (no server round trip, no scroll reset). Skipped on first render
  // because the URL already matches the parsed state.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const qs = serializeEmployeeListParams(params);
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${qs ? `?${qs}` : ""}`,
    );
  }, [params]);

  const update = useCallback(
    (patch: Partial<EmployeeListParams>) => setParams((current) => ({ ...current, ...patch })),
    [],
  );
  const pushSearch = useDebouncedCallback(
    (value: string) => update({ search: value.trim().slice(0, 100), page: 1 }),
    300,
  );
  const onSearchInputChange = (value: string) => {
    setSearchInput(value);
    pushSearch(value);
  };
  const clearFilters = () => {
    setSearchInput("");
    update({
      filter: null,
      search: "",
      locationId: null,
      departmentId: null,
      teamId: null,
      policyId: null,
      page: 1,
    });
  };

  const onAction = useCallback(
    (action: EmployeeDialogAction, employee: Employee) => setRequest({ action, employee }),
    [],
  );

  const columns = useMemo(
    () =>
      buildEmployeeColumns({
        timeZone: organisation.data?.organisation.timezone,
        dateFormat: organisation.data?.organisation.dateFormat,
        now,
        canWrite,
        onAction,
      }),
    [
      organisation.data?.organisation.timezone,
      organisation.data?.organisation.dateFormat,
      now,
      canWrite,
      onAction,
    ],
  );

  const sorting = useMemo(() => sortKeyToColumnSorting(params.sort), [params.sort]);
  const pagination = useMemo<PaginationState>(
    () => ({ pageIndex: params.page - 1, pageSize: params.pageSize }),
    [params.page, params.pageSize],
  );

  const onSortingChange = (updater: SortingState | ((old: SortingState) => SortingState)) => {
    const next = typeof updater === "function" ? updater(sorting) : updater;
    update({ sort: columnSortingToSortKey(next), page: 1 });
  };
  const onPaginationChange = (
    updater: PaginationState | ((old: PaginationState) => PaginationState),
  ) => {
    const next = typeof updater === "function" ? updater(pagination) : updater;
    update({ page: next.pageIndex + 1, pageSize: next.pageSize });
  };

  const filtersActive = hasActiveEmployeeFilters(params) || searchInput.trim() !== "";
  const data = query.data;
  const total = data?.total ?? 0;

  const addButton = canWrite ? (
    <Button type="button" onClick={() => setAddOpen(true)}>
      <UserPlus aria-hidden="true" />
      Add employee
    </Button>
  ) : null;

  return (
    <>
      <PageHeader
        title="Employees"
        description="Everyone who works shifts, their invite status and whether their phone is connected."
        actions={addButton}
      />

      <div className="space-y-4">
        <EmployeeFilterBar
          params={params}
          searchInput={searchInput}
          onSearchInputChange={onSearchInputChange}
          onChange={update}
          onClear={clearFilters}
        />

        {query.isError ? (
          <ErrorState
            title="Couldn't load employees"
            error={query.error}
            onRetry={() => void query.refetch()}
            isRetrying={query.isRefetching}
          />
        ) : (
          <DataTable<Employee>
            label="Employees"
            columns={columns}
            data={data?.items}
            isLoading={query.isPending}
            loadingRows={Math.min(params.pageSize, 8)}
            getRowId={(row) => row.id}
            manualSorting
            manualFiltering
            sorting={sorting}
            onSortingChange={onSortingChange}
            manualPagination
            rowCount={total}
            pagination={pagination}
            onPaginationChange={onPaginationChange}
            pageSizeOptions={EMPLOYEE_PAGE_SIZES}
            enableRowSelection={canWrite}
            selectionActions={
              canWrite
                ? (selected, clearSelection) => (
                    <EmployeeBulkActions selected={selected} clearSelection={clearSelection} />
                  )
                : undefined
            }
            onRowClick={(employee) => router.push(routeFor.employee(employee.id))}
            getRowLabel={(employee) => `Open ${employeeFullName(employee)}`}
            emptyState={
              filtersActive ? (
                <EmptyState
                  icon={EMPTY_STATES.search.icon}
                  title={EMPTY_STATES.search.title}
                  description={EMPTY_STATES.search.description}
                  action={
                    <Button type="button" variant="outline" onClick={clearFilters}>
                      Clear filters
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon={EMPTY_STATES.employees.icon}
                  title={EMPTY_STATES.employees.title}
                  description={EMPTY_STATES.employees.description}
                  action={
                    canWrite ? (
                      <Button type="button" onClick={() => setAddOpen(true)}>
                        <UserPlus aria-hidden="true" />
                        {EMPTY_STATES.employees.action.label}
                      </Button>
                    ) : undefined
                  }
                />
              )
            }
          />
        )}
      </div>

      <EmployeeFormSheet open={addOpen} onOpenChange={setAddOpen} />
      <EmployeeActionDialogs request={request} onClose={() => setRequest(null)} />
    </>
  );
}
