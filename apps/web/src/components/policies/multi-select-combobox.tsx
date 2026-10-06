"use client";

import { Check, ChevronsUpDown, LoaderCircle, type LucideIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface MultiSelectOption {
  readonly id: string;
  readonly name: string;
  readonly hint?: string;
}

export interface MultiSelectComboboxProps {
  label: string;
  description?: ReactNode;
  icon?: LucideIcon;
  options: readonly MultiSelectOption[] | undefined;
  isLoading?: boolean;
  /** Ids currently selected. */
  selectedIds: ReadonlySet<string>;
  /** Ids with a request in flight (shown with a spinner, not clickable). */
  pendingIds?: ReadonlySet<string>;
  /** Called with the option and whether it should now be selected. */
  onToggle: (option: MultiSelectOption, selected: boolean) => void;
  disabled?: boolean;
  /** Why the control is disabled (shown under it). */
  disabledReason?: string;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  /** Noun for the trigger summary, e.g. "location" → "2 of 5 locations". */
  noun: string;
  nounPlural?: string;
}

/**
 * Checkbox-style multi-select in a popover (Command list). Each toggle fires immediately so callers can bind
 * it straight to create/remove mutations; items stay visible with a spinner while their request runs.
 */
export function MultiSelectCombobox({
  label,
  description,
  icon: Icon,
  options,
  isLoading = false,
  selectedIds,
  pendingIds,
  onToggle,
  disabled,
  disabledReason,
  placeholder,
  searchPlaceholder = "Search…",
  emptyText = "Nothing found.",
  noun,
  nounPlural = `${noun}s`,
}: MultiSelectComboboxProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const total = options?.length ?? 0;
  const selectedCount = options ? options.filter((o) => selectedIds.has(o.id)).length : 0;
  const summary =
    total === 0
      ? (placeholder ?? `No ${nounPlural} yet`)
      : selectedCount === 0
        ? (placeholder ?? `Choose ${nounPlural}…`)
        : `${selectedCount} of ${total} ${total === 1 ? noun : nounPlural}`;
  const isDisabled = disabled || isLoading || total === 0;

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            disabled={isDisabled}
            className={cn("w-full justify-between font-normal", selectedCount === 0 && "text-muted-foreground")}
          >
            <span className="flex min-w-0 items-center gap-2">
              {Icon ? <Icon className="text-muted-foreground" aria-hidden="true" /> : null}
              {isLoading ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
              <span className="truncate">{isLoading ? "Loading…" : summary}</span>
            </span>
            <ChevronsUpDown className="opacity-50" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) min-w-72 p-0" align="start">
          <Command>
            <CommandInput placeholder={searchPlaceholder} aria-label={searchPlaceholder} />
            <CommandList className="max-h-64">
              <CommandEmpty>{emptyText}</CommandEmpty>
              <CommandGroup>
                {(options ?? []).map((option) => {
                  const selected = selectedIds.has(option.id);
                  const pending = pendingIds?.has(option.id) ?? false;
                  return (
                    <CommandItem
                      key={option.id}
                      value={`${option.name} ${option.hint ?? ""} ${option.id}`}
                      disabled={pending}
                      onSelect={() => onToggle(option, !selected)}
                      aria-selected={selected}
                    >
                      <span
                        className={cn(
                          "flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
                          selected ? "border-primary bg-primary text-primary-foreground" : "border-input",
                        )}
                        aria-hidden="true"
                      >
                        {pending ? (
                          <LoaderCircle className="size-3 animate-spin" />
                        ) : selected ? (
                          <Check className="size-3" />
                        ) : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{option.name}</span>
                        {option.hint ? <span className="text-muted-foreground block truncate text-xs">{option.hint}</span> : null}
                      </span>
                      <span className="sr-only">{selected ? "(assigned)" : "(not assigned)"}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {disabledReason && disabled ? (
        <p className="text-muted-foreground text-xs">{disabledReason}</p>
      ) : description ? (
        <p className="text-muted-foreground text-xs">{description}</p>
      ) : null}
    </div>
  );
}
