"use client";

import type { Employee } from "@workmode/validation/employees";
import { Check, ChevronsUpDown, LoaderCircle, UserRound, X } from "lucide-react";
import { useState } from "react";
import { StatusBadge } from "@/components/status/status-badge";
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
import { useEmployeeSearch } from "./employee-api";
import { EMPLOYEE_EMPTY_STATES } from "./employee-copy";
import { employeeFullName } from "./employee-view-model";
import { useDebouncedCallback } from "./use-debounced-callback";

/** What the picker needs to show a selection without re-fetching (a `Shift.employee` summary satisfies it). */
export interface EmployeePickerValue {
  id: string;
  firstName: string;
  lastName: string;
  jobTitle?: string | null;
}

export interface EmployeePickerProps {
  value: EmployeePickerValue | null;
  /** Receives the full employee row on select, `null` on clear. */
  onChange: (employee: Employee | null) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Hide the clear (×) button. */
  allowClear?: boolean;
  /** Employees to leave out (e.g. already added). */
  excludeIds?: readonly string[];
  id?: string;
  className?: string;
  "aria-label"?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}

/**
 * Searchable employee combobox backed by `GET /api/employees?search=` (active employees, first 20 matches).
 * Exported for the schedule page's shift forms.
 */
export function EmployeePicker({
  value,
  onChange,
  disabled,
  placeholder = "Choose an employee",
  allowClear = true,
  excludeIds = [],
  id,
  className,
  ...aria
}: EmployeePickerProps) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const debounceSearch = useDebouncedCallback((next: string) => setSearch(next), 250);
  const query = useEmployeeSearch(search, { enabled: open });

  const items = (query.data ?? []).filter((e) => !excludeIds.includes(e.id));
  const label = value ? employeeFullName(value) : null;

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            disabled={disabled}
            className={cn("w-full justify-between font-normal", !value && "text-muted-foreground")}
            {...aria}
          >
            <span className="flex min-w-0 items-center gap-2">
              <UserRound className="text-muted-foreground" aria-hidden="true" />
              <span className="truncate">{label ?? placeholder}</span>
            </span>
            <ChevronsUpDown className="opacity-50" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) min-w-80 p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search by name, email or employee ID…"
              aria-label="Search employees"
              value={input}
              onValueChange={(next) => {
                setInput(next);
                debounceSearch(next);
              }}
            />
            <CommandList>
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
                    <p className="font-medium">{EMPLOYEE_EMPTY_STATES.picker.title}</p>
                    <p className="text-muted-foreground text-xs">
                      {EMPLOYEE_EMPTY_STATES.picker.description}
                    </p>
                  </CommandEmpty>
                  <CommandGroup>
                    {items.map((employee) => {
                      const selected = value?.id === employee.id;
                      return (
                        <CommandItem
                          key={employee.id}
                          value={employee.id}
                          onSelect={() => {
                            onChange(employee);
                            setOpen(false);
                          }}
                          className="items-start gap-2 py-2"
                        >
                          <Check
                            className={cn(
                              "mt-1 size-4 shrink-0",
                              selected ? "opacity-100" : "opacity-0",
                            )}
                            aria-hidden="true"
                          />
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate font-medium">
                              {employeeFullName(employee)}
                            </span>
                            <span className="text-muted-foreground truncate text-xs">
                              {[employee.jobTitle, employee.primaryLocation?.name]
                                .filter(Boolean)
                                .join(" · ") || "No role or location set"}
                            </span>
                          </span>
                          <StatusBadge
                            kind="inviteStatus"
                            value={employee.inviteStatus}
                            size="sm"
                            describe={false}
                            hideIcon
                          />
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {allowClear && value && !disabled ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => onChange(null)}
          aria-label="Clear selected employee"
        >
          <X aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}
