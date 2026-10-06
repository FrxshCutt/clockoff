"use client";

import { useId, type ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

export interface CheckboxCardOption<V extends string> {
  readonly value: V;
  readonly label: string;
  readonly description?: ReactNode;
  readonly disabled?: boolean;
}

export interface CheckboxCardGroupProps<V extends string> {
  options: readonly CheckboxCardOption<V>[];
  value: readonly V[];
  onChange: (next: V[]) => void;
  /** Accessible name for the group (rendered as a visually hidden legend unless `showLegend`). */
  label: string;
  showLegend?: boolean;
  description?: ReactNode;
  disabled?: boolean;
  /** Id of the error message element, for `aria-describedby`. */
  errorId?: string;
  invalid?: boolean;
  columns?: 1 | 2;
  size?: "sm" | "md";
  className?: string;
}

/**
 * A fieldset of checkbox "cards" (label + description per option) for picking several enum values. The
 * value is kept in the option order so the form always sends a canonical list.
 */
export function CheckboxCardGroup<V extends string>({
  options,
  value,
  onChange,
  label,
  showLegend = false,
  description,
  disabled,
  errorId,
  invalid,
  columns = 2,
  size = "md",
  className,
}: CheckboxCardGroupProps<V>) {
  const baseId = useId();
  const selected = new Set(value);

  const toggle = (option: V, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(option);
    else next.delete(option);
    onChange(options.map((o) => o.value).filter((v) => next.has(v)));
  };

  return (
    <fieldset
      className={cn("min-w-0 space-y-3", className)}
      disabled={disabled}
      aria-describedby={errorId}
      aria-invalid={invalid || undefined}
    >
      <legend className={cn(showLegend ? "text-sm font-medium" : "sr-only")}>{label}</legend>
      {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
      <div className={cn("grid gap-2", columns === 2 && "sm:grid-cols-2")}>
        {options.map((option) => {
          const id = `${baseId}-${option.value}`;
          const checked = selected.has(option.value);
          return (
            <label
              key={option.value}
              htmlFor={id}
              className={cn(
                "has-focus-visible:ring-ring/50 flex cursor-pointer items-start gap-3 rounded-lg border transition-colors has-focus-visible:ring-[3px]",
                size === "md" ? "p-3" : "px-3 py-2",
                checked ? "border-primary/50 bg-primary/5" : "hover:bg-accent/50",
                (disabled || option.disabled) && "cursor-not-allowed opacity-60 hover:bg-transparent",
              )}
            >
              <Checkbox
                id={id}
                checked={checked}
                disabled={disabled || option.disabled}
                onCheckedChange={(state) => toggle(option.value, state === true)}
                className="mt-0.5"
              />
              <span className="min-w-0 space-y-0.5">
                <span className="block text-sm leading-5 font-medium">{option.label}</span>
                {option.description ? (
                  <span className="text-muted-foreground block text-xs leading-4">{option.description}</span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
