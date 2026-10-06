"use client";

import type { Column } from "@tanstack/react-table";
import { Check, CirclePlus } from "lucide-react";
import type { ComponentType } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

export interface FacetOption {
  label: string;
  value: string;
  icon?: ComponentType<{ className?: string }>;
}

export interface DataTableFacetedFilterProps<TData, TValue> {
  column: Column<TData, TValue> | undefined;
  title: string;
  options: readonly FacetOption[];
}

/**
 * Multi-select filter for one column (use with `filterFn: facetedFilter()`). Shows per-option counts from
 * the table's faceted row model.
 */
export function DataTableFacetedFilter<TData, TValue>({ column, title, options }: DataTableFacetedFilterProps<TData, TValue>) {
  if (!column) return null;
  const facets = column.getFacetedUniqueValues();
  const current = column.getFilterValue();
  const selected = new Set(Array.isArray(current) ? current.map(String) : []);

  const toggle = (value: string) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    column.setFilterValue(next.size > 0 ? [...next] : undefined);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-9 border-dashed">
          <CirclePlus aria-hidden="true" />
          {title}
          {selected.size > 0 ? (
            <>
              <Separator orientation="vertical" className="mx-1 h-4" />
              <Badge variant="secondary" className="rounded-sm px-1 font-normal lg:hidden">
                {selected.size}
              </Badge>
              <span className="hidden gap-1 lg:flex">
                {selected.size > 2 ? (
                  <Badge variant="secondary" className="rounded-sm px-1 font-normal">
                    {selected.size} selected
                  </Badge>
                ) : (
                  options
                    .filter((o) => selected.has(o.value))
                    .map((o) => (
                      <Badge key={o.value} variant="secondary" className="rounded-sm px-1 font-normal">
                        {o.label}
                      </Badge>
                    ))
                )}
              </span>
            </>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-0" align="start">
        <Command>
          <CommandInput placeholder={title} aria-label={`Filter ${title}`} />
          <CommandList>
            <CommandEmpty>No options.</CommandEmpty>
            <CommandGroup>
              {options.map((option) => {
                const isSelected = selected.has(option.value);
                const count = facets.get(option.value);
                return (
                  <CommandItem key={option.value} value={option.label} onSelect={() => toggle(option.value)}>
                    <span
                      className={cn(
                        "border-primary flex size-4 items-center justify-center rounded-[4px] border",
                        isSelected ? "bg-primary text-primary-foreground" : "opacity-50 [&_svg]:invisible",
                      )}
                      aria-hidden="true"
                    >
                      <Check className="size-3.5 text-current" />
                    </span>
                    {option.icon ? <option.icon className="text-muted-foreground size-4" /> : null}
                    <span>{option.label}</span>
                    <span className="sr-only">{isSelected ? "(selected)" : ""}</span>
                    {count !== undefined ? (
                      <span className="text-muted-foreground ml-auto font-mono text-xs tabular-nums">{count}</span>
                    ) : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
            {selected.size > 0 ? (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem onSelect={() => column.setFilterValue(undefined)} className="justify-center text-center">
                    Clear filter
                  </CommandItem>
                </CommandGroup>
              </>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
