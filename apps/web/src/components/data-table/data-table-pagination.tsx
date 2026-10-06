"use client";

import type { Table } from "@tanstack/react-table";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatNumber } from "@/lib/format";

export const DEFAULT_PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

export interface DataTablePaginationProps<TData> {
  table: Table<TData>;
  pageSizeOptions?: readonly number[];
  showSelection?: boolean;
}

export function DataTablePagination<TData>({
  table,
  pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
  showSelection = false,
}: DataTablePaginationProps<TData>) {
  const pageSizeId = useId();
  const { pageIndex, pageSize } = table.getState().pagination;
  const pageCount = Math.max(table.getPageCount(), 1);
  const total = table.getRowCount();
  const selectedCount = table.getFilteredSelectedRowModel().rows.length;

  return (
    <div className="flex flex-col-reverse gap-3 px-1 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-muted-foreground text-sm" aria-live="polite">
        {showSelection && selectedCount > 0
          ? `${formatNumber(selectedCount)} of ${formatNumber(total)} selected`
          : `${formatNumber(total)} ${total === 1 ? "result" : "results"}`}
      </p>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-2">
          <label htmlFor={pageSizeId} className="text-sm font-medium whitespace-nowrap">
            Rows per page
          </label>
          <Select value={String(pageSize)} onValueChange={(value) => table.setPageSize(Number(value))}>
            <SelectTrigger id={pageSizeId} size="sm" className="w-[4.5rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent side="top">
              {pageSizeOptions.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-sm font-medium whitespace-nowrap tabular-nums">
          Page {formatNumber(Math.min(pageIndex + 1, pageCount))} of {formatNumber(pageCount)}
        </p>
        <nav className="flex items-center gap-1" aria-label="Pagination">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className="hidden sm:inline-flex"
            onClick={() => table.firstPage()}
            disabled={!table.getCanPreviousPage()}
            aria-label="First page"
          >
            <ChevronsLeft aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            aria-label="Previous page"
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            aria-label="Next page"
          >
            <ChevronRight aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className="hidden sm:inline-flex"
            onClick={() => table.lastPage()}
            disabled={!table.getCanNextPage()}
            aria-label="Last page"
          >
            <ChevronsRight aria-hidden="true" />
          </Button>
        </nav>
      </div>
    </div>
  );
}
