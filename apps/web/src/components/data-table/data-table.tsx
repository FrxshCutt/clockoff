"use client";

import {
  flexRender,
  functionalUpdate,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type OnChangeFn,
  type PaginationState,
  type Row,
  type RowSelectionState,
  type SortingState,
  type Table as TanstackTable,
  type VisibilityState,
} from "@tanstack/react-table";
import { Search, X } from "lucide-react";
import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EMPTY_STATES } from "@/config/emptyStates";
import { cn } from "@/lib/utils";
import { DataTablePagination, DEFAULT_PAGE_SIZE_OPTIONS } from "./data-table-pagination";

export interface DataTableProps<TData, TValue = unknown> {
  columns: ColumnDef<TData, TValue>[];
  /** `undefined` while the first load is in flight. */
  data: readonly TData[] | undefined;
  /** Accessible name for the table (visually hidden caption), e.g. "Employees". */
  label: string;
  isLoading?: boolean;
  /** Skeleton rows while loading. */
  loadingRows?: number;
  getRowId?: (row: TData, index: number) => string;

  // ── Toolbar ──
  /** Show the built-in global search input. */
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Controlled global search (e.g. synced to the URL or sent to the server). */
  globalFilter?: string;
  onGlobalFilterChange?: (value: string) => void;
  /** Filters/actions rendered next to the search box (receives the table instance, e.g. for faceted filters). */
  toolbar?: (table: TanstackTable<TData>) => ReactNode;
  /** Right-aligned toolbar content (e.g. an "Add" button). */
  toolbarActions?: ReactNode;

  // ── Sorting / filtering / visibility ──
  initialSorting?: SortingState;
  sorting?: SortingState;
  onSortingChange?: OnChangeFn<SortingState>;
  columnFilters?: ColumnFiltersState;
  onColumnFiltersChange?: OnChangeFn<ColumnFiltersState>;
  initialColumnVisibility?: VisibilityState;
  /** Server-side sorting/filtering: the table renders `data` as given. */
  manualSorting?: boolean;
  manualFiltering?: boolean;

  // ── Pagination ──
  /** Disable pagination (render every row). */
  paginate?: boolean;
  initialPageSize?: number;
  pageSizeOptions?: readonly number[];
  /** Server-side pagination: pass `rowCount` (total rows) and control `pagination`. */
  manualPagination?: boolean;
  rowCount?: number;
  pagination?: PaginationState;
  onPaginationChange?: OnChangeFn<PaginationState>;

  // ── Selection ──
  /** Enable row selection (add `createSelectColumn()` to `columns` for checkboxes). */
  enableRowSelection?: boolean | ((row: Row<TData>) => boolean);
  onSelectionChange?: (rows: TData[]) => void;
  /** Bulk-action bar shown while rows are selected. */
  selectionActions?: (selected: TData[], clearSelection: () => void) => ReactNode;

  // ── Rows ──
  /** Makes rows interactive (click, Enter or Space). Clicks on buttons/links/checkboxes inside are ignored. */
  onRowClick?: (row: TData) => void;
  /** Accessible label for an interactive row, e.g. `(e) => \`Open ${e.name}\``. */
  getRowLabel?: (row: TData) => string;

  // ── Empty states ──
  /** Shown when there is no data at all. */
  emptyState?: ReactNode;
  /** Shown when filters/search hide every row. Defaults to "No matching results" + clear filters. */
  noResultsState?: ReactNode;

  /** Keep the header visible while the body scrolls (the table gets a max height). Default true. */
  stickyHeader?: boolean;
  className?: string;
}

const UNSIZED_COLUMN = { size: undefined };

const INTERACTIVE_SELECTOR =
  "a, button, input, select, textarea, label, [role='checkbox'], [role='menuitem'], [role='switch']";

function isFromInteractiveChild(event: MouseEvent | KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  const interactive = target?.closest(INTERACTIVE_SELECTOR);
  return Boolean(interactive && interactive !== event.currentTarget);
}

/**
 * TanStack Table v8 data grid: sorting, column + global filters, pagination, row selection, loading
 * skeleton rows, empty states, sticky header and horizontal overflow on small screens.
 */
export function DataTable<TData, TValue = unknown>({
  columns,
  data,
  label,
  isLoading = false,
  loadingRows = 5,
  getRowId,
  searchable = false,
  searchPlaceholder = "Search…",
  globalFilter: globalFilterProp,
  onGlobalFilterChange,
  toolbar,
  toolbarActions,
  initialSorting = [],
  sorting: sortingProp,
  onSortingChange,
  columnFilters: columnFiltersProp,
  onColumnFiltersChange,
  initialColumnVisibility = {},
  manualSorting = false,
  manualFiltering = false,
  paginate = true,
  initialPageSize = 25,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  manualPagination = false,
  rowCount,
  pagination: paginationProp,
  onPaginationChange,
  enableRowSelection = false,
  onSelectionChange,
  selectionActions,
  onRowClick,
  getRowLabel,
  emptyState,
  noResultsState,
  stickyHeader = true,
  className,
}: DataTableProps<TData, TValue>) {
  const [sortingState, setSortingState] = useState<SortingState>(initialSorting);
  const [columnFiltersState, setColumnFiltersState] = useState<ColumnFiltersState>([]);
  const [globalFilterState, setGlobalFilterState] = useState("");
  const [columnVisibility, setColumnVisibility] =
    useState<VisibilityState>(initialColumnVisibility);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [paginationState, setPaginationState] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: initialPageSize,
  });

  const sorting = sortingProp ?? sortingState;
  const columnFilters = columnFiltersProp ?? columnFiltersState;
  const globalFilter = globalFilterProp ?? globalFilterState;
  const pagination = paginationProp ?? paginationState;

  const rows = (data ?? []) as TData[];

  // TanStack Table v8 returns a mutable instance the React Compiler cannot memoise; the compiler skips this
  // component, which is the documented, intended behaviour for TanStack Table.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable<TData>({
    data: rows,
    columns: columns as ColumnDef<TData, unknown>[],
    getRowId,
    // TanStack gives every column `size: 150` by default; clear it so only columns that declare a size get a
    // fixed width (the rest share the remaining space).
    defaultColumn: UNSIZED_COLUMN,
    state: {
      sorting,
      columnFilters,
      globalFilter,
      columnVisibility,
      rowSelection,
      ...(paginate ? { pagination } : {}),
    },
    enableRowSelection,
    manualSorting,
    manualFiltering,
    manualPagination,
    rowCount: manualPagination ? rowCount : undefined,
    autoResetPageIndex: false,
    onSortingChange: onSortingChange ?? setSortingState,
    onColumnFiltersChange: (updater) => {
      // Any filter change returns to the first page.
      (onColumnFiltersChange ?? setColumnFiltersState)(updater);
      if (!manualPagination) setPaginationState((p) => ({ ...p, pageIndex: 0 }));
    },
    onGlobalFilterChange: (updater: unknown) => {
      const next = String(
        functionalUpdate(updater as string | ((old: string) => string), globalFilter) ?? "",
      );
      if (onGlobalFilterChange) onGlobalFilterChange(next);
      else setGlobalFilterState(next);
      if (!manualPagination) setPaginationState((p) => ({ ...p, pageIndex: 0 }));
    },
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: (updater) => {
      const next = functionalUpdate(updater, rowSelection);
      setRowSelection(next);
      if (onSelectionChange) {
        const selected: TData[] = [];
        for (const id of Object.keys(next)) {
          if (!next[id]) continue;
          const row = table.getRow(id, true);
          if (row) selected.push(row.original);
        }
        onSelectionChange(selected);
      }
    },
    onPaginationChange: onPaginationChange ?? setPaginationState,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: manualSorting ? undefined : getSortedRowModel(),
    getFilteredRowModel: manualFiltering ? undefined : getFilteredRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    getPaginationRowModel: paginate && !manualPagination ? getPaginationRowModel() : undefined,
  });

  const visibleColumnCount = table.getVisibleLeafColumns().length;
  const headerRowCount = table.getHeaderGroups().length;
  // aria-rowcount/aria-rowindex let screen readers announce "row 31 of 120" across pages.
  const firstRowIndex =
    headerRowCount + 1 + (paginate ? pagination.pageIndex * pagination.pageSize : 0);
  const hasFilters = globalFilter.trim() !== "" || columnFilters.length > 0;
  const showLoading = isLoading || data === undefined;
  const pageRows = table.getRowModel().rows;
  const selectedRows = table.getSelectedRowModel().rows.map((r) => r.original);

  const clearFilters = () => {
    table.resetColumnFilters();
    table.setGlobalFilter("");
  };
  const clearSelection = () => table.resetRowSelection();

  const showToolbar = searchable || toolbar !== undefined || toolbarActions !== undefined;
  const isEmptyDataset = !showLoading && rows.length === 0 && !(manualFiltering && hasFilters);

  if (isEmptyDataset && emptyState && !hasFilters) {
    return (
      <div className={cn("space-y-4", className)}>
        {toolbarActions ? <div className="flex justify-end">{toolbarActions}</div> : null}
        {emptyState}
      </div>
    );
  }

  return (
    <div className={cn("space-y-4", className)}>
      {showToolbar ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-1 flex-wrap items-center gap-2">
            {searchable ? (
              <div className="relative w-full sm:w-72">
                <Search
                  className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
                  aria-hidden="true"
                />
                <Input
                  type="search"
                  value={globalFilter}
                  onChange={(event) => table.setGlobalFilter(event.target.value)}
                  placeholder={searchPlaceholder}
                  aria-label={`Search ${label.toLowerCase()}`}
                  className="h-9 pl-9"
                />
              </div>
            ) : null}
            {toolbar?.(table)}
            {hasFilters ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-9"
                onClick={clearFilters}
              >
                Reset
                <X aria-hidden="true" />
              </Button>
            ) : null}
          </div>
          {toolbarActions ? (
            <div className="flex flex-wrap items-center gap-2">{toolbarActions}</div>
          ) : null}
        </div>
      ) : null}

      {selectionActions && selectedRows.length > 0 ? (
        <div
          className="bg-primary/5 border-primary/20 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-2.5"
          role="region"
          aria-label="Bulk actions"
        >
          <p className="text-sm font-medium">{selectedRows.length} selected</p>
          <div className="flex flex-wrap items-center gap-2">
            {selectionActions(selectedRows, clearSelection)}
            <Button type="button" variant="ghost" size="sm" onClick={clearSelection}>
              Clear selection
            </Button>
          </div>
        </div>
      ) : null}

      <div className="bg-card overflow-hidden rounded-xl border shadow-xs">
        <Table
          aria-busy={showLoading || undefined}
          aria-rowcount={showLoading ? undefined : table.getRowCount() + headerRowCount}
          containerClassName={cn(stickyHeader && "max-h-[min(70vh,52rem)] overflow-auto")}
        >
          <TableCaption className="sr-only">{label}</TableCaption>
          <TableHeader
            className={cn("bg-muted/60 backdrop-blur", stickyHeader && "sticky top-0 z-10")}
          >
            {table.getHeaderGroups().map((headerGroup, headerIndex) => (
              <TableRow
                key={headerGroup.id}
                className="hover:bg-transparent"
                aria-rowindex={headerIndex + 1}
              >
                {headerGroup.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  return (
                    <TableHead
                      key={header.id}
                      colSpan={header.colSpan}
                      scope="col"
                      aria-sort={
                        header.column.getCanSort()
                          ? sorted === "asc"
                            ? "ascending"
                            : sorted === "desc"
                              ? "descending"
                              : "none"
                          : undefined
                      }
                      className="h-11 px-4 first:pl-4"
                      style={
                        header.column.columnDef.size !== undefined
                          ? { width: header.getSize() }
                          : undefined
                      }
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {showLoading ? (
              Array.from({ length: loadingRows }, (_, r) => (
                <TableRow key={`skeleton-${r}`} className="hover:bg-transparent" aria-hidden="true">
                  {Array.from({ length: visibleColumnCount }, (_, c) => (
                    <TableCell key={c} className="px-4 py-3.5">
                      <Skeleton
                        className={cn("h-4", c === 0 ? "w-3/4 max-w-48" : "w-full max-w-32")}
                      />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : pageRows.length > 0 ? (
              pageRows.map((row, rowIndex) => {
                const interactive = onRowClick !== undefined;
                return (
                  <TableRow
                    key={row.id}
                    aria-rowindex={firstRowIndex + rowIndex}
                    data-state={row.getIsSelected() ? "selected" : undefined}
                    tabIndex={interactive ? 0 : undefined}
                    aria-label={interactive && getRowLabel ? getRowLabel(row.original) : undefined}
                    className={cn(
                      interactive &&
                        "focus-visible:bg-accent/60 focus-visible:ring-ring/50 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset",
                    )}
                    onClick={
                      interactive
                        ? (event) => {
                            if (!isFromInteractiveChild(event)) onRowClick(row.original);
                          }
                        : undefined
                    }
                    onKeyDown={
                      interactive
                        ? (event) => {
                            if (
                              (event.key === "Enter" || event.key === " ") &&
                              !isFromInteractiveChild(event)
                            ) {
                              event.preventDefault();
                              onRowClick(row.original);
                            }
                          }
                        : undefined
                    }
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id} className="px-4 py-3">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })
            ) : (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={visibleColumnCount} className="p-0 whitespace-normal">
                  {hasFilters
                    ? (noResultsState ?? (
                        <EmptyState
                          icon={EMPTY_STATES.search.icon}
                          title={EMPTY_STATES.search.title}
                          description={EMPTY_STATES.search.description}
                          size="sm"
                          bordered={false}
                          headingLevel={3}
                          action={
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={clearFilters}
                            >
                              Clear filters
                            </Button>
                          }
                        />
                      ))
                    : (emptyState ?? (
                        <EmptyState
                          title="Nothing here yet"
                          size="sm"
                          bordered={false}
                          headingLevel={3}
                        />
                      ))}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {paginate && !showLoading && table.getRowCount() > 0 ? (
        <DataTablePagination
          table={table}
          pageSizeOptions={pageSizeOptions}
          showSelection={enableRowSelection !== false}
        />
      ) : null}
    </div>
  );
}
