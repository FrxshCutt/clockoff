"use client";

import { DATE_FORMATS } from "@workmode/shared/enums";
import {
  TIME_FORMATS,
  WEEK_STARTS,
  organisationSettingsSchema,
  updateOrganisationSchema,
  type UpdateOrganisationInput,
} from "@workmode/validation/organisation";
import { toast } from "sonner";
import type { z } from "zod";
import { ErrorState } from "@/components/error-state";
import {
  FormErrorAlert,
  SelectField,
  SubmitButton,
  SwitchField,
  TextField,
  applyApiFieldErrors,
  useZodForm,
  type SelectOption,
} from "@/components/forms/form-fields";
import { TimezoneField } from "@/components/forms/timezone-select";
import { InlineAlert } from "@/components/inline-alert";
import { FormSkeleton } from "@/components/loading-skeletons";
import { SectionCard } from "@/components/section";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import type { OrganisationSummary } from "@/hooks/api-shapes";
import { usePermission } from "@/hooks/use-current-user";
import { useCurrentOrganisation, useUpdateOrganisation } from "@/hooks/use-organisation";
import { DATE_FORMAT_LABELS } from "@/lib/format";

/**
 * The API's `PATCH /api/organisations/current` schema with every field required (the form always shows and
 * sends the full set), so client validation can never drift from the server's.
 */
export const organisationSettingsFormSchema = updateOrganisationSchema
  .required()
  .extend({ settings: organisationSettingsSchema });
export type OrganisationSettingsFormValues = z.infer<typeof organisationSettingsFormSchema>;

const DATE_FORMAT_OPTIONS: SelectOption[] = DATE_FORMATS.map((format) => ({
  value: format,
  label: DATE_FORMAT_LABELS[format].label,
  hint: DATE_FORMAT_LABELS[format].example,
}));

const WEEK_START_LABELS: Record<(typeof WEEK_STARTS)[number], string> = {
  MONDAY: "Monday",
  SUNDAY: "Sunday",
};
const WEEK_START_OPTIONS: SelectOption[] = WEEK_STARTS.map((value) => ({
  value,
  label: WEEK_START_LABELS[value],
}));

const TIME_FORMAT_LABELS: Record<(typeof TIME_FORMATS)[number], { label: string; hint: string }> = {
  H24: { label: "24-hour", hint: "14:30" },
  H12: { label: "12-hour", hint: "2:30 pm" },
};
const TIME_FORMAT_OPTIONS: SelectOption[] = TIME_FORMATS.map((value) => ({
  value,
  label: TIME_FORMAT_LABELS[value].label,
  hint: TIME_FORMAT_LABELS[value].hint,
}));

export function toOrganisationFormValues(
  organisation: OrganisationSummary,
): OrganisationSettingsFormValues {
  return {
    name: organisation.name,
    timezone: organisation.timezone,
    dateFormat: organisation.dateFormat,
    settings: { ...organisation.settings },
  };
}

/** Settings → Organisation: `GET` / `PATCH /api/organisations/current`. */
export function OrganisationSettings() {
  const { data, isPending, isError, error, refetch, isRefetching } = useCurrentOrganisation();
  const canEdit = usePermission("org:manage");

  if (isPending) {
    return (
      <SectionCard title="Organisation details">
        <FormSkeleton fields={4} />
      </SectionCard>
    );
  }
  if (isError) {
    return (
      <ErrorState
        title="Couldn't load organisation settings"
        error={error}
        onRetry={() => void refetch()}
        isRetrying={isRefetching}
      />
    );
  }
  // Re-mount when switching organisation so the form never shows the previous organisation's values.
  return (
    <OrganisationSettingsForm
      key={data.organisation.id}
      organisation={data.organisation}
      canEdit={canEdit}
    />
  );
}

function OrganisationSettingsForm({
  organisation,
  canEdit,
}: {
  organisation: OrganisationSummary;
  canEdit: boolean;
}) {
  const update = useUpdateOrganisation();
  const form = useZodForm(organisationSettingsFormSchema, {
    defaultValues: toOrganisationFormValues(organisation),
  });
  const { isDirty } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    const input: UpdateOrganisationInput = {
      name: values.name,
      timezone: values.timezone,
      dateFormat: values.dateFormat,
      settings: values.settings,
    };
    try {
      await update.mutateAsync(input);
      form.reset(values);
      toast.success("Organisation settings saved");
    } catch (error) {
      applyApiFieldErrors(form, error);
    }
  });

  const disabled = !canEdit || update.isPending;

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} noValidate className="space-y-6">
        {canEdit ? null : (
          <InlineAlert variant="info" title="View only">
            Only owners and admins can change organisation settings.
          </InlineAlert>
        )}
        <SectionCard
          title="Organisation details"
          description="Your organisation's name and regional preferences."
          footer={
            canEdit ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={!isDirty || update.isPending}
                  onClick={() => {
                    form.reset();
                    update.reset();
                  }}
                >
                  Discard changes
                </Button>
                <SubmitButton
                  isPending={update.isPending}
                  pendingLabel="Saving…"
                  disabled={!isDirty}
                >
                  Save changes
                </SubmitButton>
              </>
            ) : undefined
          }
        >
          <div className="space-y-5">
            <FormErrorAlert error={update.error} title="Couldn't save changes" />
            <TextField
              control={form.control}
              name="name"
              label="Organisation name"
              autoComplete="organization"
              disabled={disabled}
            />
            <TimezoneField
              control={form.control}
              name="timezone"
              label="Time zone"
              description="Shift times, breaks and reports use this zone."
              disabled={disabled}
            />
            <div className="grid gap-5 sm:grid-cols-3">
              <SelectField
                control={form.control}
                name="dateFormat"
                label="Date format"
                options={DATE_FORMAT_OPTIONS}
                disabled={disabled}
              />
              <SelectField
                control={form.control}
                name="settings.timeFormat"
                label="Time format"
                options={TIME_FORMAT_OPTIONS}
                disabled={disabled}
              />
              <SelectField
                control={form.control}
                name="settings.weekStartsOn"
                label="Week starts on"
                options={WEEK_START_OPTIONS}
                disabled={disabled}
              />
            </div>
            <SwitchField
              control={form.control}
              name="settings.requireInviteCodeToJoin"
              label="Require a personal invite code to join"
              description="When on, employees must enter the invite code you send them as well as the company join code, even if their name matches exactly one employee."
              disabled={disabled}
            />
          </div>
        </SectionCard>
      </form>
    </Form>
  );
}
