"use client";

import type { ColumnDef, FilterFn, Row } from "@tanstack/react-table";
import { Checkbox } from "@/components/ui/checkbox";

/** Column filter for faceted (multi-select) filters: keeps rows whose value is one of the selected strings. */
export function facetedFilterFn<TData>(row: Row<TData>, columnId: string, filterValue: unknown): boolean {
  if (!Array.isArray(filterValue) || filterValue.length === 0) return true;
  const value = row.getValue<unknown>(columnId);
  if (Array.isArray(value)) return value.some((v) => filterValue.includes(String(v)));
  return filterValue.includes(String(value));
}
facetedFilterFn.autoRemove = (value: unknown) => !Array.isArray(value) || value.length === 0;

/** Typed alias so columns can write `filterFn: facetedFilter<Row>()`. */
export function facetedFilter<TData>(): FilterFn<TData> {
  return facetedFilterFn as FilterFn<TData>;
}

/**
 * Checkbox column for row selection. The header checkbox selects every row on the current page;
 * labels use `getRowLabel` so screen readers announce which row a checkbox selects.
 */
export function createSelectColumn<TData>(options: { getRowLabel?: (row: TData) => string } = {}): ColumnDef<TData> {
  return {
    id: "select",
    enableSorting: false,
    enableHiding: false,
    enableColumnFilter: false,
    enableGlobalFilter: false,
    size: 40,
    header: ({ table }) => (
      <Checkbox
        checked={table.getIsAllPageRowsSelected() || (table.getIsSomePageRowsSelected() ? "indeterminate" : false)}
        onCheckedChange={(value) => table.toggleAllPageRowsSelected(value === true)}
        aria-label="Select all rows on this page"
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        disabled={!row.getCanSelect()}
        onCheckedChange={(value) => row.toggleSelected(value === true)}
        aria-label={options.getRowLabel ? `Select ${options.getRowLabel(row.original)}` : "Select row"}
      />
    ),
  };
}
