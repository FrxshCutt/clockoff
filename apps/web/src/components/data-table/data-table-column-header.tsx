"use client";

import type { Column } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface DataTableColumnHeaderProps<TData, TValue> {
  column: Column<TData, TValue>;
  title: string;
  className?: string;
}

/** Sortable column header: click (or Enter/Space) cycles ascending → descending → unsorted. */
export function DataTableColumnHeader<TData, TValue>({ column, title, className }: DataTableColumnHeaderProps<TData, TValue>) {
  if (!column.getCanSort()) {
    return <span className={cn("text-muted-foreground text-xs font-medium tracking-wide uppercase", className)}>{title}</span>;
  }
  const sorted = column.getIsSorted();
  const Icon = sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : ArrowUpDown;
  const next = sorted === false ? "ascending" : sorted === "asc" ? "descending" : "unsorted";
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        "text-muted-foreground hover:text-foreground data-[sorted=true]:text-foreground -ml-2.5 h-8 px-2.5 text-xs font-medium tracking-wide uppercase",
        className,
      )}
      data-sorted={sorted !== false}
      onClick={column.getToggleSortingHandler()}
      aria-label={`${title}: sort ${next}`}
    >
      {title}
      <Icon className={cn("size-3.5", sorted === false && "opacity-50")} aria-hidden="true" />
    </Button>
  );
}
