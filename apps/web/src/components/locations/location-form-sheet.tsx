"use client";

import type { Location } from "@clockoff/validation/locationsTeams";
import { toast } from "sonner";
import {
  SubmitButton,
  SwitchField,
  TextField,
  TextareaField,
  applyApiFieldErrors,
  useZodForm,
} from "@/components/forms/form-fields";
import { TimezoneField } from "@/components/forms/timezone-select";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { formatTimeZoneLabel } from "@/lib/format";
import {
  describeStructureConflict,
  emptyLocationForm,
  locationFormSchema,
  locationToFormValues,
  toCreateLocationInput,
  toUpdateLocationInput,
  type LocationFormValues,
} from "./locations-view-model";
import { StructureErrorAlert } from "./structure-error-alert";
import { useCreateLocation, useUpdateLocation } from "./use-locations-teams";

export interface LocationFormSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this location; omit to create a new one. */
  location?: Location | null;
  /** The organisation's zone, shown as the inherited default. */
  organisationTimezone: string;
  onSaved?: (location: Location, mode: "create" | "edit") => void;
}

/** Add / Edit location drawer: `POST /api/locations` or `PATCH /api/locations/:id` (changed fields only). */
export function LocationFormSheet({
  open,
  onOpenChange,
  location = null,
  organisationTimezone,
  onSaved,
}: LocationFormSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        {/* Keyed so switching location (or reopening) always starts from fresh values. */}
        {open ? (
          <LocationForm
            key={location?.id ?? "new"}
            location={location}
            organisationTimezone={organisationTimezone}
            onClose={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function LocationForm({
  location,
  organisationTimezone,
  onClose,
  onSaved,
}: {
  location: Location | null;
  organisationTimezone: string;
  onClose: () => void;
  onSaved?: (location: Location, mode: "create" | "edit") => void;
}) {
  const mode = location ? "edit" : "create";
  const form = useZodForm(locationFormSchema, {
    defaultValues: location
      ? locationToFormValues(location, organisationTimezone)
      : emptyLocationForm(organisationTimezone),
  });
  const create = useCreateLocation();
  const update = useUpdateLocation();
  const isPending = create.isPending || update.isPending;
  const useOrganisationTimezone = form.watch("useOrganisationTimezone");

  const onSubmit = form.handleSubmit(async (values: LocationFormValues) => {
    try {
      if (location) {
        const input = toUpdateLocationInput(values, location);
        if (!input) {
          toast.info("No changes to save");
          onClose();
          return;
        }
        const saved = await update.mutateAsync({ id: location.id, input });
        toast.success(`${saved.name} updated`);
        onClose();
        onSaved?.(saved, "edit");
      } else {
        const saved = await create.mutateAsync(toCreateLocationInput(values));
        toast.success(`${saved.name} added`);
        onClose();
        onSaved?.(saved, "create");
      }
    } catch (error) {
      // A duplicate name (409 with `details.field`) belongs on the Name field, like a validation error.
      const conflict = describeStructureConflict(error, "location");
      if (conflict?.field)
        form.setError(
          conflict.field,
          { type: "server", message: conflict.message },
          { shouldFocus: true },
        );
      else applyApiFieldErrors(form, error);
    }
  });

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
        <SheetHeader className="border-b px-6 py-5">
          <SheetTitle>{mode === "edit" ? `Edit ${location!.name}` : "Add location"}</SheetTitle>
          <SheetDescription>
            {mode === "edit"
              ? "Changes apply to shifts and employees at this location from their next sync."
              : "A site your team works at. Shifts scheduled here use its time zone."}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5">
          <StructureErrorAlert
            error={create.error ?? update.error}
            kind="location"
            title={mode === "edit" ? "Couldn't save changes" : "Couldn't add the location"}
          />
          <TextField
            control={form.control}
            name="name"
            label="Name"
            placeholder="e.g. Harbour Street"
            autoComplete="off"
            autoFocus={mode === "create"}
          />
          <SwitchField
            control={form.control}
            name="useOrganisationTimezone"
            label="Use the organisation time zone"
            description={`Currently ${formatTimeZoneLabel(organisationTimezone)}. Turn off for a site in a different zone.`}
          />
          <TimezoneField
            control={form.control}
            name="timezone"
            label="Time zone"
            description="Shift start and end times at this location are interpreted in this zone."
            disabled={useOrganisationTimezone}
          />
          <TextareaField
            control={form.control}
            name="address"
            label="Address"
            description="Optional. Shown to managers only; never sent to employees' phones."
            placeholder="Optional"
            rows={3}
          />
        </div>

        <SheetFooter className="flex-row justify-end gap-2 border-t px-6 py-4">
          <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <SubmitButton isPending={isPending} pendingLabel="Saving…">
            {mode === "edit" ? "Save changes" : "Add location"}
          </SubmitButton>
        </SheetFooter>
      </form>
    </Form>
  );
}
