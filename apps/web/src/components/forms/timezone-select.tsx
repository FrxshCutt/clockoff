"use client";

import { Check, ChevronsUpDown, Globe } from "lucide-react";
import { forwardRef, useMemo, useState, type ReactNode } from "react";
import type { FieldPath, FieldValues } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { detectTimeZone, getTimeZones } from "@/config/timezones";
import { formatTimeZoneLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Control } from "react-hook-form";

export interface TimezoneComboboxProps {
  value: string | undefined;
  onChange: (timeZone: string) => void;
  onBlur?: () => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}

/**
 * Searchable IANA time-zone picker built from `Intl.supportedValuesOf("timeZone")`, with the current UTC
 * offset next to each zone and the viewer's detected zone pinned to the top.
 */
export const TimezoneCombobox = forwardRef<HTMLButtonElement, TimezoneComboboxProps>(function TimezoneCombobox(
  { value, onChange, onBlur, disabled, id, className, ...aria },
  ref,
) {
  const [open, setOpen] = useState(false);
  const selectedLabel = value ? formatTimeZoneLabel(value) : null;

  return (
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
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          disabled={disabled}
          className={cn("w-full justify-between font-normal", !value && "text-muted-foreground", className)}
          {...aria}
        >
          <span className="flex min-w-0 items-center gap-2">
            <Globe className="text-muted-foreground" aria-hidden="true" />
            <span className="truncate">{selectedLabel ?? "Select a time zone"}</span>
          </span>
          <ChevronsUpDown className="opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-72 p-0" align="start">
        {open ? (
          <TimezoneList
            value={value}
            onSelect={(zone) => {
              onChange(zone);
              setOpen(false);
              onBlur?.();
            }}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
});

function TimezoneList({ value, onSelect }: { value: string | undefined; onSelect: (zone: string) => void }) {
  const options = useMemo(() => {
    const detected = detectTimeZone("");
    const zones = getTimeZones();
    const all = zones.map((zone) => ({ zone, label: formatTimeZoneLabel(zone) }));
    const suggested = detected ? all.filter((o) => o.zone === detected) : [];
    return { suggested, all };
  }, []);

  const renderItem = (option: { zone: string; label: string }, keyPrefix: string) => (
    <CommandItem
      key={`${keyPrefix}-${option.zone}`}
      value={`${keyPrefix} ${option.label} ${option.zone}`}
      onSelect={() => onSelect(option.zone)}
    >
      <Check className={cn("size-4", value === option.zone ? "opacity-100" : "opacity-0")} aria-hidden="true" />
      <span className="truncate">{option.label}</span>
    </CommandItem>
  );

  return (
    <Command>
      <CommandInput placeholder="Search time zones…" aria-label="Search time zones" />
      <CommandList className="max-h-72">
        <CommandEmpty>No time zone found.</CommandEmpty>
        {options.suggested.length > 0 ? (
          <CommandGroup heading="Detected">{options.suggested.map((o) => renderItem(o, "detected"))}</CommandGroup>
        ) : null}
        <CommandGroup heading="All time zones">{options.all.map((o) => renderItem(o, "all"))}</CommandGroup>
      </CommandList>
    </Command>
  );
}

export function TimezoneField<TFieldValues extends FieldValues, TName extends FieldPath<TFieldValues>>({
  control,
  name,
  label,
  description,
  className,
  disabled,
}: {
  control: Control<TFieldValues, unknown, unknown>;
  name: TName;
  label: ReactNode;
  description?: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <FormField<TFieldValues, TName, unknown>
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <TimezoneCombobox
              ref={field.ref}
              value={(field.value as string | undefined) || undefined}
              onChange={field.onChange}
              onBlur={field.onBlur}
              disabled={disabled || field.disabled}
            />
          </FormControl>
          {description ? <FormDescription>{description}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
