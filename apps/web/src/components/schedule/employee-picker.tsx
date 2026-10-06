"use client";

import { Check, ChevronsUpDown, LoaderCircle, User, X } from "lucide-react";
import { forwardRef, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { getErrorMessage } from "@/lib/errorMessages";
import { cn } from "@/lib/utils";
import { employeeName } from "./schedule-model";
import { useEmployee, useEmployeeSearch } from "./schedule-queries";

/** The minimum an employee reference needs to be shown in the picker. */
export interface EmployeeRef {
  id: string;
  firstName: string;
  lastName: string;
  jobTitle?: string | null;
  primaryLocation?: { id: string; name: string } | null;
}

export interface EmployeePickerProps {
  /** Selected employee id (null = none). */
  value: string | null;
  /** Called with the chosen employee (or null when cleared). */
  onChange: (employee: EmployeeRef | null) => void;
  /** Known details for `value` so the trigger can label it without a lookup. */
  selected?: EmployeeRef | null;
  placeholder?: string;
  /** Show an inline clear button once a value is set. Default false. */
  clearable?: boolean;
  disabled?: boolean;
  onBlur?: () => void;
  id?: string;
  className?: string;
  /** Accessible name when there is no visible label. */
  "aria-label"?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
  size?: "default" | "sm";
  /** Pre-fills the search box when the list opens (e.g. the name typed in a CSV row). */
  defaultSearch?: string;
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * Searchable employee combobox backed by `GET /api/employees?search=`. The list only loads while the
 * popover is open; when the selected id is known but its name is not (e.g. it came from the URL), the
 * employee is fetched once to label the trigger.
 */
export const EmployeePicker = forwardRef<HTMLButtonElement, EmployeePickerProps>(
  function EmployeePicker(
    {
      value,
      onChange,
      selected,
      placeholder = "Choose an employee",
      clearable = false,
      disabled,
      onBlur,
      id,
      className,
      size = "default",
      defaultSearch = "",
      ...aria
    },
    ref,
  ) {
    const [open, setOpen] = useState(false);
    const needsLookup = value !== null && (!selected || selected.id !== value);
    const lookup = useEmployee(needsLookup ? value : null);
    const current: EmployeeRef | null =
      value === null ? null : selected && selected.id === value ? selected : (lookup.data ?? null);
    const label = current
      ? employeeName(current)
      : value && lookup.isPending
        ? "Loading…"
        : value
          ? "Unknown employee"
          : null;

    return (
      <div className={cn("flex min-w-0 items-center gap-1", className)}>
        <Popover
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) onBlur?.();
          }}
        >
          <PopoverTrigger asChild>
            <Button
              ref={ref}
              id={id}
              type="button"
              variant="outline"
              size={size === "sm" ? "sm" : "default"}
              role="combobox"
              aria-expanded={open}
              aria-haspopup="listbox"
              disabled={disabled}
              className={cn(
                "min-w-0 flex-1 justify-between font-normal",
                !label && "text-muted-foreground",
              )}
              {...aria}
            >
              <span className="flex min-w-0 items-center gap-2">
                <User className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{label ?? placeholder}</span>
              </span>
              <ChevronsUpDown className="size-4 shrink-0 opacity-50" aria-hidden="true" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-(--radix-popover-trigger-width) min-w-72 p-0" align="start">
            {open ? (
              <EmployeeList
                value={value}
                defaultSearch={defaultSearch}
                onSelect={(employee) => {
                  onChange(employee);
                  setOpen(false);
                  onBlur?.();
                }}
              />
            ) : null}
          </PopoverContent>
        </Popover>
        {clearable && value ? (
          <Button
            type="button"
            variant="ghost"
            size={size === "sm" ? "icon-sm" : "icon"}
            aria-label="Clear employee"
            disabled={disabled}
            onClick={() => onChange(null)}
          >
            <X aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    );
  },
);

function EmployeeList({
  value,
  defaultSearch,
  onSelect,
}: {
  value: string | null;
  defaultSearch: string;
  onSelect: (employee: EmployeeRef) => void;
}) {
  const [search, setSearch] = useState(defaultSearch);
  const debounced = useDebounced(search, 250);
  const { data, isPending, isError, error, isFetching } = useEmployeeSearch(debounced);

  return (
    <Command shouldFilter={false}>
      <CommandInput
        value={search}
        onValueChange={setSearch}
        placeholder="Search by name, email or ID…"
        aria-label="Search employees"
      />
      <CommandList className="max-h-72">
        {isPending ? (
          <div
            className="text-muted-foreground flex items-center justify-center gap-2 py-6 text-sm"
            role="status"
          >
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            Loading employees…
          </div>
        ) : isError ? (
          <div className="text-destructive px-3 py-6 text-center text-sm" role="alert">
            {getErrorMessage(error)}
          </div>
        ) : (
          <>
            <CommandEmpty>
              {search ? "No employees match that search." : "No active employees yet."}
            </CommandEmpty>
            <CommandGroup heading={isFetching ? "Employees (updating…)" : "Employees"}>
              {(data ?? []).map((employee) => {
                const hint = [employee.jobTitle, employee.primaryLocation?.name]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <CommandItem
                    key={employee.id}
                    value={employee.id}
                    onSelect={() => onSelect(employee)}
                  >
                    <Check
                      className={cn("size-4", value === employee.id ? "opacity-100" : "opacity-0")}
                      aria-hidden="true"
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{employeeName(employee)}</span>
                      {hint ? (
                        <span className="text-muted-foreground truncate text-xs">{hint}</span>
                      ) : null}
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </Command>
  );
}
