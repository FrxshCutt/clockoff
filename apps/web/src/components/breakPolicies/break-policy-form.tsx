"use client";

import type { BreakPolicy } from "@workmode/validation/breakPolicies";
import { Coffee } from "lucide-react";
import { useId, useState } from "react";
import { useWatch } from "react-hook-form";
import { toast } from "sonner";
import {
  FormErrorAlert,
  SubmitButton,
  SwitchField,
  TextField,
  TextareaField,
  applyApiFieldErrors,
  useZodForm,
} from "@/components/forms/form-fields";
import { NumberField } from "@/components/policies/number-field";
import { SectionCard } from "@/components/section";
import { StatusBadge } from "@/components/status/status-badge";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { BreakBehaviourField } from "./break-behaviour-field";
import {
  BREAK_POLICY_PRESETS,
  BREAK_RULE_FIELD_META,
  breakPolicyFormSchema,
  previewBreakSummary,
  summariseBreakPolicy,
  toBreakPolicyFormValues,
  toCreateBreakPolicyInput,
  toUpdateBreakPolicyInput,
  type BreakPolicyFormValues,
} from "./break-policy-view-model";
import { useCreateBreakPolicy, useUpdateBreakPolicy } from "./use-break-policies";

export interface BreakPolicyFormProps {
  /** Existing Break Rules to edit; null creates new ones (with the preset chooser). */
  policy: BreakPolicy | null;
  /** "sheet" renders Sheet header/footer chrome; "page" renders a card with a plain footer. */
  variant: "sheet" | "page";
  onSaved?: (policy: BreakPolicy, mode: "create" | "update") => void;
  onCancel?: () => void;
}

const CUSTOM_PRESET_ID = "custom";

const PRESET_OPTIONS = [
  ...BREAK_POLICY_PRESETS.map((preset) => ({
    id: preset.id,
    name: preset.name,
    description: preset.description,
    summary: summariseBreakPolicy(preset.rules) as string | null,
  })),
  {
    id: CUSTOM_PRESET_ID,
    name: "Custom",
    description: "Start from the defaults and set every rule yourself.",
    summary: null,
  },
];

const NUMERIC_FIELDS = [
  "maxBreaksPerShift",
  "maxBreakDurationMinutes",
  "maxTotalBreakMinutes",
  "minGapBetweenBreaksMinutes",
  "minMinutesAfterShiftStart",
] as const;

/**
 * Create / edit form for Break Rules: presets (create only), name, description, every rule, the behaviour
 * picker and a live summary line. `POST /api/break-policies` or `PATCH /api/break-policies/:id` (the full
 * rule set, so the server re-validates one consistent set).
 */
export function BreakPolicyForm({ policy, variant, onSaved, onCancel }: BreakPolicyFormProps) {
  const initialPreset = policy ? null : (BREAK_POLICY_PRESETS[0] ?? null);
  const [presetId, setPresetId] = useState<string>(initialPreset?.id ?? CUSTOM_PRESET_ID);
  const form = useZodForm(breakPolicyFormSchema, {
    defaultValues: toBreakPolicyFormValues(policy, initialPreset),
  });
  const create = useCreateBreakPolicy();
  const update = useUpdateBreakPolicy();
  const presetLegendId = useId();

  const watched = useWatch({ control: form.control });
  const summary = previewBreakSummary(watched);
  const breaksEnabled = watched.breaksEnabled ?? true;
  const isPending = create.isPending || update.isPending;
  const mutationError = create.error ?? update.error;

  const applyPreset = (id: string) => {
    setPresetId(id);
    const preset = BREAK_POLICY_PRESETS.find((candidate) => candidate.id === id) ?? null;
    const next = toBreakPolicyFormValues(null, preset);
    // Keep a name the manager typed themselves; presets only fill in the rules.
    const typedName = form.getValues("name").trim();
    const keepName =
      typedName !== "" && !BREAK_POLICY_PRESETS.some((candidate) => candidate.name === typedName);
    form.reset(keepName ? { ...next, name: typedName } : next);
  };

  const onSubmit = form.handleSubmit(async (values: BreakPolicyFormValues) => {
    try {
      if (policy) {
        if (!form.formState.isDirty) {
          toast.info("No changes to save");
          onCancel?.();
          return;
        }
        const saved = await update.mutateAsync({
          id: policy.id,
          input: toUpdateBreakPolicyInput(values),
        });
        toast.success(`${saved.name} updated`, {
          description: "Breaks already in progress keep the rules they started with.",
        });
        onSaved?.(saved, "update");
      } else {
        const saved = await create.mutateAsync(toCreateBreakPolicyInput(values));
        toast.success(`${saved.name} created`, {
          description:
            "Assign them to locations, teams or employees, or make them the organisation default.",
        });
        onSaved?.(saved, "create");
      }
    } catch (error) {
      applyApiFieldErrors(form, error);
    }
  });

  const fields = (
    <div className="space-y-6">
      {policy ? null : (
        <fieldset className="space-y-3">
          <legend id={presetLegendId} className="text-sm font-medium">
            Start from
          </legend>
          <RadioGroup
            value={presetId}
            onValueChange={applyPreset}
            aria-labelledby={presetLegendId}
            className="gap-2 sm:grid-cols-2"
          >
            {PRESET_OPTIONS.map((option) => {
              const id = `${presetLegendId}-${option.id}`;
              const checked = presetId === option.id;
              return (
                <label
                  key={option.id}
                  htmlFor={id}
                  className={cn(
                    "has-focus-visible:ring-ring/50 flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors has-focus-visible:ring-[3px]",
                    checked ? "border-primary/50 bg-primary/5" : "hover:bg-accent/50",
                  )}
                >
                  <RadioGroupItem id={id} value={option.id} className="mt-0.5" />
                  <span className="min-w-0 space-y-0.5">
                    <span className="block text-sm leading-5 font-medium">{option.name}</span>
                    {option.summary ? (
                      <span className="text-muted-foreground block text-xs leading-4 tabular-nums">
                        {option.summary}
                      </span>
                    ) : null}
                    <span className="text-muted-foreground block text-xs leading-4">
                      {option.description}
                    </span>
                  </span>
                </label>
              );
            })}
          </RadioGroup>
        </fieldset>
      )}

      <TextField
        control={form.control}
        name="name"
        label="Name"
        placeholder="e.g. Standard Break"
        maxLength={120}
        autoComplete="off"
      />
      <TextareaField
        control={form.control}
        name="description"
        label={
          <>
            Description <span className="text-muted-foreground font-normal">(optional)</span>
          </>
        }
        placeholder="When these rules apply and why."
        rows={2}
        maxLength={500}
      />

      {policy ? (
        <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">Status</p>
            <p className="text-muted-foreground text-sm">
              Break Rules apply as soon as they’re saved; there is no publish step.
            </p>
          </div>
          <StatusBadge kind="policyStatus" value={policy.status} />
        </div>
      ) : null}

      <SwitchField
        control={form.control}
        name="breaksEnabled"
        label="Breaks allowed"
        description="Turn off to allow no breaks at all under these rules. Everything below is kept for when you turn them back on."
      />

      <div className={cn("grid gap-4 sm:grid-cols-2", !breaksEnabled && "opacity-60")}>
        {NUMERIC_FIELDS.map((name) => {
          const meta = BREAK_RULE_FIELD_META[name];
          return (
            <NumberField
              key={name}
              control={form.control}
              name={name}
              label={meta.label}
              description={meta.description}
              unit={meta.unit}
              min={meta.min}
              max={meta.max}
              disabled={!breaksEnabled}
            />
          );
        })}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <SwitchField
          control={form.control}
          name="employeeTriggeredAllowed"
          label="Employees can start breaks"
          description="From the Work Mode app on their phone."
          disabled={!breaksEnabled}
        />
        <SwitchField
          control={form.control}
          name="scheduledBreaksAllowed"
          label="Scheduled breaks"
          description="Breaks planned on a shift start automatically."
          disabled={!breaksEnabled}
        />
      </div>

      <BreakBehaviourField disabled={!breaksEnabled} />

      <div className="bg-muted/40 flex items-start gap-3 rounded-lg border p-4">
        <Coffee className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-sm font-medium">Summary</p>
          <p className="text-muted-foreground text-sm tabular-nums" aria-live="polite">
            {summary ?? "Finish the rules above to see the summary."}
          </p>
        </div>
      </div>

      <FormErrorAlert
        error={mutationError}
        title={policy ? "Couldn't save the Break Rules" : "Couldn't create the Break Rules"}
      />
    </div>
  );

  const description = policy
    ? "Changes apply from the next break an employee starts."
    : "Set how long breaks last, how often they can be taken and what relaxes during them.";
  const actions = (
    <>
      {onCancel ? (
        <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
          Cancel
        </Button>
      ) : null}
      <SubmitButton isPending={isPending} pendingLabel={policy ? "Saving…" : "Creating…"}>
        {policy ? "Save changes" : "Create Break Rules"}
      </SubmitButton>
    </>
  );

  if (variant === "sheet") {
    return (
      <Form {...form}>
        <form
          onSubmit={onSubmit}
          noValidate
          className="flex h-full min-h-0 flex-col"
          aria-busy={isPending || undefined}
        >
          <SheetHeader className="border-b px-6 py-5">
            <SheetTitle>{policy ? `Edit ${policy.name}` : "New Break Rules"}</SheetTitle>
            <SheetDescription>{description}</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{fields}</div>
          <SheetFooter className="flex-row justify-end gap-2 border-t px-6 py-4">
            {actions}
          </SheetFooter>
        </form>
      </Form>
    );
  }

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} noValidate className="space-y-6" aria-busy={isPending || undefined}>
        <SectionCard title="Rules" description={description}>
          {fields}
        </SectionCard>
        <div className="flex justify-end gap-2">{actions}</div>
      </form>
    </Form>
  );
}
