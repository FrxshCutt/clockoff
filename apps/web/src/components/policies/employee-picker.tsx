"use client";

import type { Employee } from "@workmode/validation/employees";
import { Check, ChevronsUpDown, LoaderCircle, UserRound } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { getErrorMessage } from "@/lib/errorMessages";
import { cn } from "@/lib/utils";
import { EMPLOYEE_SEARCH_PAGE_SIZE, useEmployeeSearch } from "./use-assignment-targets";

/** Waits `delayMs` after the last change before exposing `value`. */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function formatEmployeeName(employee: Pick<Employee, "firstName" | "lastName">): string {
  return `${employee.firstName} ${employee.lastName}`.trim();
}

export function formatEmployeeHint(
  employee: Pick<Employee, "jobTitle" | "primaryLocation">,
): string | undefined {
  const parts = [employee.jobTitle, employee.primaryLocation?.name].filter((p): p is string =>
    Boolean(p),
  );
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export interface EmployeePickerProps {
  label?: string;
  description?: string;
  /** Employee ids that already have an assignment. */
  selectedIds: ReadonlySet<string>;
  pendingIds?: ReadonlySet<string>;
  onToggle: (employee: Pick<Employee, "id" | "firstName" | "lastName">, selected: boolean) => void;
  disabled?: boolean;
  disabledReason?: string;
}

/**
 * Server-searched employee combobox (`GET /api/employees?search=`). Selecting an unassigned employee assigns
 * them; selecting an assigned one removes the assignment. Only the first page of matches is shown, so the
 * hint asks for a narrower search when there are more.
 */
export function EmployeePicker({
  label = "Employees",
  description = "Direct assignments beat team, location and organisation ones.",
  selectedIds,
  pendingIds,
  onToggle,
  disabled,
  disabledReason,
}: EmployeePickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const debounced = useDebouncedValue(search, 250);
  const id = useId();
  const query = useEmployeeSearch(debounced, { enabled: open });
  const results = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const summary =
    selectedIds.size === 0
      ? "Choose employees…"
      : `${selectedIds.size} ${selectedIds.size === 1 ? "employee" : "employees"} assigned`;

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setSearch("");
        }}
      >
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            disabled={disabled}
            className={cn(
              "w-full justify-between font-normal",
              selectedIds.size === 0 && "text-muted-foreground",
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              <UserRound className="text-muted-foreground" aria-hidden="true" />
              <span className="truncate">{summary}</span>
            </span>
            <ChevronsUpDown className="opacity-50" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) min-w-72 p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              value={search}
              onValueChange={setSearch}
              placeholder="Search by name, email or job title…"
              aria-label="Search employees"
            />
            <CommandList className="max-h-64">
              {query.isPending ? (
                <div
                  className="text-muted-foreground flex items-center justify-center gap-2 py-6 text-sm"
                  role="status"
                >
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                  Searching…
                </div>
              ) : query.isError ? (
                <div className="text-destructive px-3 py-6 text-center text-sm" role="alert">
                  {getErrorMessage(query.error)}
                </div>
              ) : (
                <>
                  <CommandEmpty>
                    {debounced.trim() === ""
                      ? "No employees yet."
                      : "No employees match that search."}
                  </CommandEmpty>
                  <CommandGroup>
                    {results.map((employee) => {
                      const selected = selectedIds.has(employee.id);
                      const pending = pendingIds?.has(employee.id) ?? false;
                      const name = formatEmployeeName(employee);
                      const hint = formatEmployeeHint(employee);
                      return (
                        <CommandItem
                          key={employee.id}
                          value={employee.id}
                          disabled={pending}
                          onSelect={() => onToggle(employee, !selected)}
                          aria-selected={selected}
                        >
                          <span
                            className={cn(
                              "flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
                              selected
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-input",
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
                            <span className="block truncate">{name}</span>
                            {hint ? (
                              <span className="text-muted-foreground block truncate text-xs">
                                {hint}
                              </span>
                            ) : null}
                          </span>
                          <span className="sr-only">
                            {selected ? "(assigned)" : "(not assigned)"}
                          </span>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                  {total > EMPLOYEE_SEARCH_PAGE_SIZE ? (
                    <p className="text-muted-foreground border-t px-3 py-2 text-xs">
                      Showing the first {EMPLOYEE_SEARCH_PAGE_SIZE} of {total}. Keep typing to
                      narrow it down.
                    </p>
                  ) : null}
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <p className="text-muted-foreground text-xs">
        {disabled && disabledReason ? disabledReason : description}
      </p>
    </div>
  );
}
