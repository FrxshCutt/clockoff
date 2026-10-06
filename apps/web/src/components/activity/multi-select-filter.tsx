"use client";

import { Check, CirclePlus } from "lucide-react";
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

export interface MultiSelectOption<V extends string> {
  readonly value: V;
  readonly label: string;
  /** Group key; options with the same group render under one heading (see `groupLabels`). */
  readonly group?: string;
}

export interface MultiSelectFilterProps<V extends string> {
  /** Button label, e.g. "Type". */
  title: string;
  options: readonly MultiSelectOption<V>[];
  value: readonly V[];
  onChange: (next: V[]) => void;
  groupLabels?: Readonly<Record<string, string>>;
  searchPlaceholder?: string;
  emptyText?: string;
  className?: string;
}

/**
 * Standalone multi-select filter (same look as `DataTableFacetedFilter`, but controlled by the caller rather
 * than a table column — for filters sent to the server). Keyboard: type to search, Enter toggles.
 */
export function MultiSelectFilter<V extends string>({
  title,
  options,
  value,
  onChange,
  groupLabels = {},
  searchPlaceholder,
  emptyText = "No matches.",
  className,
}: MultiSelectFilterProps<V>) {
  const selected = new Set<V>(value);
  const toggle = (option: V) => {
    const next = new Set(selected);
    if (next.has(option)) next.delete(option);
    else next.add(option);
    // Preserve option order so the URL and the chips are stable.
    onChange(options.filter((o) => next.has(o.value)).map((o) => o.value));
  };

  const groups = new Map<string, MultiSelectOption<V>[]>();
  for (const option of options) {
    const key = option.group ?? "";
    const list = groups.get(key);
    if (list) list.push(option);
    else groups.set(key, [option]);
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className={cn("h-9 border-dashed", className)} aria-label={`${title} filter`}>
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
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder={searchPlaceholder ?? `Filter ${title.toLowerCase()}…`} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {[...groups.entries()].map(([group, items]) => (
              <CommandGroup key={group || "ungrouped"} heading={group ? (groupLabels[group] ?? group) : undefined}>
                {items.map((option) => {
                  const isSelected = selected.has(option.value);
                  return (
                    <CommandItem key={option.value} value={`${option.label} ${option.value}`} onSelect={() => toggle(option.value)} aria-checked={isSelected} role="menuitemcheckbox">
                      <span
                        aria-hidden="true"
                        className={cn(
                          "border-input flex size-4 items-center justify-center rounded-[4px] border",
                          isSelected ? "bg-primary text-primary-foreground border-primary" : "opacity-60",
                        )}
                      >
                        {isSelected ? <Check className="size-3" /> : null}
                      </span>
                      <span>{option.label}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
            {selected.size > 0 ? (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem onSelect={() => onChange([])} className="justify-center text-center">
                    Clear {title.toLowerCase()} filter
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
