"use client";

import type { ReactNode } from "react";
import type { Control, FieldPath, FieldValues } from "react-hook-form";
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface NumberFieldProps<TFieldValues extends FieldValues, TName extends FieldPath<TFieldValues>> {
  control: Control<TFieldValues, unknown, unknown>;
  name: TName;
  label: ReactNode;
  description?: ReactNode;
  /** Short unit shown inside the input, e.g. "min". */
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  className?: string;
}

/**
 * Whole-number input bound to a `z.number()` field. The form value is a real number (NaN while the box is
 * empty so the schema can say "enter a number"), never a string.
 */
export function NumberField<TFieldValues extends FieldValues, TName extends FieldPath<TFieldValues>>({
  control,
  name,
  label,
  description,
  unit,
  min,
  max,
  step = 1,
  disabled,
  className,
}: NumberFieldProps<TFieldValues, TName>) {
  return (
    <FormField<TFieldValues, TName, unknown>
      control={control}
      name={name}
      render={({ field }) => {
        const value = field.value as number | undefined;
        return (
          <FormItem className={className}>
            <FormLabel>{label}</FormLabel>
            <div className="relative">
              <FormControl>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={min}
                  max={max}
                  step={step}
                  name={field.name}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  disabled={disabled || field.disabled}
                  value={value === undefined || Number.isNaN(value) ? "" : String(value)}
                  onChange={(event) => {
                    const next = event.target.value;
                    field.onChange(next === "" ? Number.NaN : Number(next));
                  }}
                  className={cn(unit && "pr-14", "tabular-nums")}
                />
              </FormControl>
              {unit ? (
                <span
                  className="text-muted-foreground pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm"
                  aria-hidden="true"
                >
                  {unit}
                </span>
              ) : null}
            </div>
            {description ? <FormDescription>{description}</FormDescription> : null}
            <FormMessage />
          </FormItem>
        );
      }}
    />
  );
}
