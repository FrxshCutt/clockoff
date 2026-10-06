"use client";

import { RESTRICTION_CONFIG_LIMITS, type Policy } from "@workmode/validation/policies";
import { Info, RotateCcw } from "lucide-react";
import { useId } from "react";
import { useWatch } from "react-hook-form";
import { toast } from "sonner";
import { BreakBehaviourField } from "@/components/breakPolicies/break-behaviour-field";
import {
  FormErrorAlert,
  SubmitButton,
  TextField,
  TextareaField,
  applyApiFieldErrors,
  useZodForm,
} from "@/components/forms/form-fields";
import { InlineAlert } from "@/components/inline-alert";
import { SectionCard } from "@/components/section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentOrganisation } from "@/hooks/use-organisation";
import { cn } from "@/lib/utils";
import { AlwaysAllowedEditor } from "./always-allowed-editor";
import { CheckboxCardGroup } from "./checkbox-card-group";
import { NumberField } from "./number-field";
import {
  ACTIVATION_MODE_OPTIONS,
  OTHER_SELECTED_CALLOUT,
  RESTRICTION_CATEGORY_OPTIONS,
  policyFormSchema,
  requiresEmployeeAppSelection,
  saveHintText,
  toCreatePolicyInput,
  toPolicyFormValues,
  toUpdatePolicyInput,
  type PolicyFormValues,
} from "./policy-view-model";
import { DEFAULT_SHIELD_PREVIEW_MESSAGE, ShieldPreview } from "./shield-preview";
import { useCreatePolicy, useUpdatePolicy } from "./use-policies";

export interface PolicyBuilderProps {
  /** The policy being edited, or null to build a new one. */
  policy: Policy | null;
  /** When false every control is disabled (no `policies:write`, or the policy is archived). */
  canEdit: boolean;
  /** Shown above the form when `canEdit` is false. */
  readOnlyReason?: string;
  onSaved?: (policy: Policy, mode: "create" | "update") => void;
}

/**
 * The Work Policy builder: name, restricted categories, employee app selection, the always-available list,
 * shield message (with a live preview), activation, pre-shift warning and the default break behaviour.
 * Saving creates the policy (draft v1) or PATCHes it; config changes become an unpublished draft version
 * that the detail page's Publish button rolls out.
 */
export function PolicyBuilder({ policy, canEdit, readOnlyReason, onSaved }: PolicyBuilderProps) {
  const form = useZodForm(policyFormSchema, { defaultValues: toPolicyFormValues(policy) });
  const create = useCreatePolicy();
  const update = useUpdatePolicy();
  const organisation = useCurrentOrganisation();
  const activationId = useId();
  const categoriesErrorId = useId();
  const alwaysAllowedErrorId = useId();

  const disabled = !canEdit;
  const isPending = create.isPending || update.isPending;
  const mutationError = create.error ?? update.error;
  const categories = useWatch({ control: form.control, name: "categories" });
  const shieldMessage = useWatch({ control: form.control, name: "shieldMessage" });
  const otherSelected = requiresEmployeeAppSelection(categories);

  const onSubmit = form.handleSubmit(async (values: PolicyFormValues) => {
    try {
      if (policy) {
        const input = toUpdatePolicyInput(values, policy);
        if (!input) {
          toast.info("No changes to save");
          return;
        }
        const saved = await update.mutateAsync({ id: policy.id, input });
        form.reset(toPolicyFormValues(saved));
        if (saved.draftVersion && (input.restrictionConfig || input.breakBehaviourDefault)) {
          toast.success(`Saved as draft v${saved.draftVersion.versionNumber}`, {
            description: "Publish it to send the changes to devices.",
          });
        } else {
          toast.success("Policy updated");
        }
        onSaved?.(saved, "update");
      } else {
        const saved = await create.mutateAsync(toCreatePolicyInput(values));
        toast.success(`${saved.name} created as a draft`, { description: "Publish it when you're ready to roll it out." });
        onSaved?.(saved, "create");
      }
    } catch (error) {
      applyApiFieldErrors(form, error);
    }
  });

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} noValidate className="space-y-6" aria-busy={isPending || undefined}>
        {disabled && readOnlyReason ? (
          <InlineAlert variant="info" title="View only">
            {readOnlyReason}
          </InlineAlert>
        ) : null}

        <SectionCard title="Basics" description="How the policy appears in the dashboard and in the Work Mode app.">
          <div className="space-y-5">
            <TextField
              control={form.control}
              name="name"
              label="Name"
              placeholder="e.g. Front of house"
              maxLength={120}
              autoComplete="off"
              disabled={disabled}
            />
            <TextareaField
              control={form.control}
              name="description"
              label={
                <>
                  Description <span className="text-muted-foreground font-normal">(optional)</span>
                </>
              }
              placeholder="Who this policy is for and why."
              rows={2}
              maxLength={500}
              disabled={disabled}
            />
          </div>
        </SectionCard>

        <SectionCard title="Restricted categories" description="Which kinds of apps the phone shields while Work Mode is on.">
          <div className="space-y-5">
            <FormField
              control={form.control}
              name="categories"
              render={({ field, fieldState }) => (
                <FormItem>
                  <CheckboxCardGroup
                    label="Restricted categories"
                    options={RESTRICTION_CATEGORY_OPTIONS.map((option) => ({
                      value: option.value,
                      label: option.label,
                      description: option.description,
                    }))}
                    value={field.value}
                    onChange={field.onChange}
                    disabled={disabled}
                    invalid={fieldState.invalid}
                    errorId={fieldState.error ? categoriesErrorId : undefined}
                  />
                  <FormMessage id={categoriesErrorId} />
                </FormItem>
              )}
            />
            {otherSelected ? (
              <InlineAlert variant="info" icon={Info} title="Other selected apps">
                {OTHER_SELECTED_CALLOUT}
              </InlineAlert>
            ) : null}
            <FormField
              control={form.control}
              name="requireEmployeeAppSelection"
              render={({ field }) => (
                <FormItem className="flex items-start justify-between gap-4 rounded-lg border p-4">
                  <div className="space-y-1">
                    <FormLabel>Employees choose their own apps</FormLabel>
                    <FormDescription>
                      {otherSelected
                        ? "Required while “Other selected apps” is restricted."
                        : "Recommended. Each employee picks which of their apps fall under these categories in the Screen Time picker on their phone; the employer never sees the list."}
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch
                      checked={otherSelected || Boolean(field.value)}
                      onCheckedChange={field.onChange}
                      onBlur={field.onBlur}
                      disabled={disabled || otherSelected}
                      ref={field.ref}
                    />
                  </FormControl>
                </FormItem>
              )}
            />
          </div>
        </SectionCard>

        <SectionCard
          title="Always available"
          description="A reminder, shown to employees in the app, of what they can still use on shift. It's informational only and doesn't change what the phone restricts."
        >
          <FormField
            control={form.control}
            name="alwaysAllowedNote"
            render={({ field, fieldState }) => (
              <FormItem>
                <AlwaysAllowedEditor
                  value={field.value}
                  onChange={field.onChange}
                  disabled={disabled}
                  maxItems={RESTRICTION_CONFIG_LIMITS.alwaysAllowedNoteMaxItems}
                  maxLength={RESTRICTION_CONFIG_LIMITS.alwaysAllowedNoteMaxLength}
                  errorId={fieldState.error ? alwaysAllowedErrorId : undefined}
                />
                <FormMessage id={alwaysAllowedErrorId} />
              </FormItem>
            )}
          />
        </SectionCard>

        <SectionCard title="Shield message" description="What employees read when they open a restricted app during a shift.">
          <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_16rem] md:items-start">
            <FormField
              control={form.control}
              name="shieldMessage"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Message <span className="text-muted-foreground font-normal">(optional)</span>
                  </FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      value={field.value ?? ""}
                      rows={3}
                      maxLength={RESTRICTION_CONFIG_LIMITS.shieldMessageMaxLength}
                      placeholder={DEFAULT_SHIELD_PREVIEW_MESSAGE}
                      disabled={disabled}
                    />
                  </FormControl>
                  <FormDescription className="flex items-start justify-between gap-4">
                    <span>Keep it short and friendly. Leave it empty to use the app’s default.</span>
                    <span className="shrink-0 tabular-nums">
                      {(field.value ?? "").length} / {RESTRICTION_CONFIG_LIMITS.shieldMessageMaxLength}
                    </span>
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <ShieldPreview message={shieldMessage ?? ""} organisationName={organisation.data?.organisation.name} />
          </div>
        </SectionCard>

        <SectionCard title="Activation" description="When Work Mode switches on, and how much warning employees get.">
          <div className="space-y-5">
            <FormField
              control={form.control}
              name="activationMode"
              render={({ field }) => (
                <FormItem>
                  <FormLabel id={activationId}>Activation mode</FormLabel>
                  <FormControl>
                    <RadioGroup
                      value={field.value}
                      onValueChange={field.onChange}
                      onBlur={field.onBlur}
                      disabled={disabled}
                      aria-labelledby={activationId}
                      className="gap-2 sm:grid-cols-2"
                    >
                      {ACTIVATION_MODE_OPTIONS.map((option) => {
                        const id = `${activationId}-${option.value}`;
                        const checked = field.value === option.value;
                        return (
                          <label
                            key={option.value}
                            htmlFor={id}
                            className={cn(
                              "has-focus-visible:ring-ring/50 flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors has-focus-visible:ring-[3px]",
                              checked ? "border-primary/50 bg-primary/5" : "hover:bg-accent/50",
                              (disabled || option.disabled) && "cursor-not-allowed opacity-60 hover:bg-transparent",
                            )}
                          >
                            <RadioGroupItem id={id} value={option.value} disabled={option.disabled} className="mt-0.5" />
                            <span className="min-w-0 space-y-0.5">
                              <span className="flex flex-wrap items-center gap-2 text-sm leading-5 font-medium">
                                {option.label}
                                {option.hint ? (
                                  <Badge variant="outline" className="font-normal">
                                    {option.hint}
                                  </Badge>
                                ) : null}
                              </span>
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
            <NumberField
              control={form.control}
              name="preShiftWarningMinutes"
              label="Pre-shift warning"
              description="How many minutes before a shift the phone shows “starting soon”. 0 turns the warning off."
              unit="min"
              min={0}
              max={RESTRICTION_CONFIG_LIMITS.preShiftWarningMaxMinutes}
              disabled={disabled}
              className="max-w-xs"
            />
          </div>
        </SectionCard>

        <SectionCard
          title="Breaks"
          description="What happens to restricted apps during a break when no Break Rules apply to the employee. Break Rules always take precedence over this default."
        >
          <BreakBehaviourField
            disabled={disabled}
            categoryOptions={categories}
            legend="Default break behaviour"
            description="Used only for employees without Break Rules."
          />
        </SectionCard>

        <FormErrorAlert error={mutationError} title={policy ? "Couldn't save the policy" : "Couldn't create the policy"} />

        {disabled ? null : (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-muted-foreground text-sm">{saveHintText(policy)}</p>
            <div className="flex items-center gap-2">
              {policy && form.formState.isDirty ? (
                <Button type="button" variant="ghost" onClick={() => form.reset(toPolicyFormValues(policy))} disabled={isPending}>
                  <RotateCcw aria-hidden="true" />
                  Discard changes
                </Button>
              ) : null}
              <SubmitButton isPending={isPending} pendingLabel={policy ? "Saving…" : "Creating…"}>
                {policy ? "Save changes" : "Create policy"}
              </SubmitButton>
            </div>
          </div>
        )}
      </form>
    </Form>
  );
}
