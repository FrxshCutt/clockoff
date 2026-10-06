"use client";

import type { BreakRestrictionBehaviour, RestrictionCategory } from "@workmode/shared/enums";
import { useId } from "react";
import { useFormContext, useWatch } from "react-hook-form";
import { CheckboxCardGroup } from "@/components/policies/checkbox-card-group";
import { RESTRICTION_CATEGORY_OPTIONS } from "@/components/policies/policy-view-model";
import { InlineAlert } from "@/components/inline-alert";
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import { BREAK_BEHAVIOUR_OPTIONS, RELAX_CATEGORIES_DEVICE_NOTE } from "./break-policy-view-model";

/** The two fields this component edits. Both the policy builder and the break rules form carry them. */
export interface BreakBehaviourFieldValues {
  restrictionBehaviour: BreakRestrictionBehaviour;
  relaxedCategories: RestrictionCategory[];
}

export interface BreakBehaviourFieldProps {
  disabled?: boolean;
  /** Which categories can be relaxed; defaults to every restriction category. */
  categoryOptions?: readonly RestrictionCategory[];
  legend?: string;
  description?: string;
}

/**
 * Break behaviour picker: three explained options, plus the relaxed-categories multi-select (with the on-device
 * note) when "Relax some categories" is chosen. Reads `restrictionBehaviour` / `relaxedCategories` from the
 * surrounding react-hook-form context.
 */
export function BreakBehaviourField({
  disabled,
  categoryOptions,
  legend = "During a break",
  description = "What happens to restricted apps while an employee is on a break.",
}: BreakBehaviourFieldProps) {
  const { control } = useFormContext<BreakBehaviourFieldValues>();
  const behaviour = useWatch({ control, name: "restrictionBehaviour" });
  const legendId = useId();
  const options = categoryOptions
    ? RESTRICTION_CATEGORY_OPTIONS.filter((option) => categoryOptions.includes(option.value))
    : RESTRICTION_CATEGORY_OPTIONS;

  return (
    <div className="space-y-4">
      <FormField
        control={control}
        name="restrictionBehaviour"
        render={({ field }) => (
          <FormItem>
            <FormLabel id={legendId}>{legend}</FormLabel>
            <p className="text-muted-foreground -mt-1 text-sm">{description}</p>
            <FormControl>
              <RadioGroup
                value={field.value}
                onValueChange={field.onChange}
                onBlur={field.onBlur}
                disabled={disabled || field.disabled}
                aria-labelledby={legendId}
                className="gap-2"
              >
                {BREAK_BEHAVIOUR_OPTIONS.map((option) => {
                  const id = `${legendId}-${option.value}`;
                  const checked = field.value === option.value;
                  return (
                    <label
                      key={option.value}
                      htmlFor={id}
                      className={cn(
                        "has-focus-visible:ring-ring/50 flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors has-focus-visible:ring-[3px]",
                        checked ? "border-primary/50 bg-primary/5" : "hover:bg-accent/50",
                        disabled && "cursor-not-allowed opacity-60 hover:bg-transparent",
                      )}
                    >
                      <RadioGroupItem id={id} value={option.value} className="mt-0.5" />
                      <span className="min-w-0 space-y-0.5">
                        <span className="block text-sm leading-5 font-medium">{option.label}</span>
                        <span className="text-muted-foreground block text-xs leading-4">{option.description}</span>
                      </span>
                    </label>
                  );
                })}
              </RadioGroup>
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      {behaviour === "RELAX_CATEGORIES" ? (
        <FormField
          control={control}
          name="relaxedCategories"
          render={({ field, fieldState }) => {
            const messageId = `${legendId}-relaxed-message`;
            return (
              <FormItem className="rounded-lg border p-4">
                <CheckboxCardGroup
                  label="Categories available on breaks"
                  showLegend
                  description="Everything you don't tick stays restricted for the whole break."
                  options={options.map((option) => ({ value: option.value, label: option.label }))}
                  value={field.value}
                  onChange={field.onChange}
                  disabled={disabled || field.disabled}
                  invalid={fieldState.invalid}
                  errorId={fieldState.error ? messageId : undefined}
                  size="sm"
                />
                <FormMessage id={messageId} />
                <InlineAlert variant="info" className="mt-2">
                  {RELAX_CATEGORIES_DEVICE_NOTE}
                </InlineAlert>
              </FormItem>
            );
          }}
        />
      ) : null}
    </div>
  );
}
