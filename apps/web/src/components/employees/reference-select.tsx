"use client";

import { Check } from "lucide-react";
import { useId, type ReactNode } from "react";
import type { Control, FieldPath, FieldValues } from "react-hook-form";
import { Checkbox } from "@/components/ui/checkbox";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Select / checkbox-group inputs over `{ id, name }` reference lists (locations, teams, policies…). Radix
 * Select cannot represent an empty value, so "none" is a sentinel item mapped back to `""`.
 */

export const NONE_VALUE = "__none__";

export interface ReferenceOption {
  id: string;
  name: string;
  hint?: ReactNode;
  disabled?: boolean;
}

export interface ReferenceSelectProps {
  value: string;
  onChange: (id: string) => void;
  options: readonly ReferenceOption[] | undefined;
  /** Label of the empty choice, e.g. "No override (inherit)". Omit to make the field required. */
  noneLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  isLoading?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
  onBlur?: () => void;
}

export function ReferenceSelect({
  value,
  onChange,
  options,
  noneLabel,
  placeholder = "Select…",
  disabled,
  isLoading,
  id,
  className,
  onBlur,
  ...aria
}: ReferenceSelectProps) {
  if (isLoading || options === undefined)
    return <Skeleton className={cn("h-9 w-full", className)} />;
  const selectValue = value === "" ? (noneLabel ? NONE_VALUE : "") : value;
  // Keep a stale id visible (as its id) rather than silently blanking the field.
  const known = options.some((o) => o.id === value);
  return (
    <Select
      value={selectValue}
      onValueChange={(next) => onChange(next === NONE_VALUE ? "" : next)}
      disabled={disabled}
    >
      <SelectTrigger id={id} className={cn("w-full", className)} onBlur={onBlur} {...aria}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {noneLabel ? (
          <SelectItem value={NONE_VALUE} className="text-muted-foreground">
            {noneLabel}
          </SelectItem>
        ) : null}
        {options.map((option) => (
          <SelectItem key={option.id} value={option.id} disabled={option.disabled}>
            {option.hint ? (
              <span className="flex flex-col">
                <span>{option.name}</span>
                <span className="text-muted-foreground text-xs">{option.hint}</span>
              </span>
            ) : (
              option.name
            )}
          </SelectItem>
        ))}
        {value && !known ? (
          <SelectItem value={value} disabled>
            Unavailable option
          </SelectItem>
        ) : null}
      </SelectContent>
    </Select>
  );
}

export interface ReferenceSelectFieldProps<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
> extends Omit<ReferenceSelectProps, "value" | "onChange" | "id" | "onBlur"> {
  control: Control<TFieldValues, unknown, unknown>;
  name: TName;
  label: ReactNode;
  description?: ReactNode;
}

export function ReferenceSelectField<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
>({
  control,
  name,
  label,
  description,
  className,
  ...selectProps
}: ReferenceSelectFieldProps<TFieldValues, TName>) {
  return (
    <FormField<TFieldValues, TName, unknown>
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <ReferenceSelect
              {...selectProps}
              value={(field.value as string | undefined) ?? ""}
              onChange={field.onChange}
              onBlur={field.onBlur}
              disabled={selectProps.disabled || field.disabled}
            />
          </FormControl>
          {description ? <FormDescription>{description}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export interface CheckboxGroupFieldProps<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
> {
  control: Control<TFieldValues, unknown, unknown>;
  name: TName;
  label: ReactNode;
  description?: ReactNode;
  options: readonly ReferenceOption[] | undefined;
  isLoading?: boolean;
  disabled?: boolean;
  /** Ids shown but not toggleable (e.g. the primary location, which is always included). */
  lockedIds?: readonly string[];
  emptyText?: string;
  className?: string;
}

/** Multi-select as an accessible checkbox list (fieldset + legend), scrolling after ~6 rows. */
export function CheckboxGroupField<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
>({
  control,
  name,
  label,
  description,
  options,
  isLoading,
  disabled,
  lockedIds = [],
  emptyText = "Nothing to choose from yet.",
  className,
}: CheckboxGroupFieldProps<TFieldValues, TName>) {
  const baseId = useId();
  return (
    <FormField<TFieldValues, TName, unknown>
      control={control}
      name={name}
      render={({ field }) => {
        const selected = new Set<string>((field.value as string[] | undefined) ?? []);
        const toggle = (id: string, checked: boolean) => {
          const next = new Set(selected);
          if (checked) next.add(id);
          else next.delete(id);
          field.onChange([...next]);
        };
        return (
          <FormItem className={className}>
            <fieldset className="space-y-2" disabled={disabled || field.disabled}>
              <legend className="flex items-center gap-2 text-sm leading-none font-medium">
                {label}
              </legend>
              {description ? <FormDescription>{description}</FormDescription> : null}
              {isLoading || options === undefined ? (
                <div className="space-y-2" aria-hidden="true">
                  <Skeleton className="h-5 w-40" />
                  <Skeleton className="h-5 w-32" />
                </div>
              ) : options.length === 0 ? (
                <p className="text-muted-foreground text-sm">{emptyText}</p>
              ) : (
                <ul className="max-h-48 space-y-1.5 overflow-y-auto rounded-md border p-3">
                  {options.map((option) => {
                    const id = `${baseId}-${option.id}`;
                    const locked = lockedIds.includes(option.id);
                    return (
                      <li key={option.id} className="flex items-center gap-2.5">
                        {locked ? (
                          <span
                            className="bg-primary text-primary-foreground flex size-4 items-center justify-center rounded-[4px]"
                            aria-hidden="true"
                          >
                            <Check className="size-3" />
                          </span>
                        ) : (
                          <Checkbox
                            id={id}
                            checked={selected.has(option.id)}
                            onCheckedChange={(checked) => toggle(option.id, checked === true)}
                            onBlur={field.onBlur}
                            disabled={option.disabled}
                          />
                        )}
                        <Label
                          htmlFor={locked ? undefined : id}
                          className={cn("font-normal", locked && "text-muted-foreground")}
                        >
                          {option.name}
                          {locked ? (
                            <span className="text-muted-foreground text-xs">(primary)</span>
                          ) : null}
                          {option.hint ? (
                            <span className="text-muted-foreground text-xs">{option.hint}</span>
                          ) : null}
                        </Label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </fieldset>
            <FormMessage />
          </FormItem>
        );
      }}
    />
  );
}
