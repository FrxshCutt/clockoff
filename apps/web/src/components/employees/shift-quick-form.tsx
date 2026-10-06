"use client";

import type { CreateShiftResponse } from "@workmode/validation/shifts";
import { useState } from "react";
import { toast } from "sonner";
import {
  FormErrorAlert,
  SubmitButton,
  TextField,
  TextareaField,
  applyApiFieldErrors,
  useZodForm,
} from "@/components/forms/form-fields";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Form } from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentOrganisation } from "@/hooks/use-organisation";
import { hasErrorCode } from "@/lib/api-client";
import { formatTimeZoneLabel } from "@/lib/format";
import { useCreateShift, useLocations } from "./employee-api";
import { ReferenceSelectField, referenceOptions } from "./reference-select";
import {
  defaultShiftQuickFormValues,
  isOvernightRange,
  shiftQuickFormSchema,
  toCreateShiftInput,
  type ShiftQuickFormValues,
} from "./shift-quick-form-model";
import { useNow } from "./use-now";

export interface ShiftQuickFormEmployee {
  id: string;
  firstName: string;
  lastName: string;
  primaryLocation: { id: string; name: string } | null;
}

export interface ShiftQuickFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee: ShiftQuickFormEmployee;
  onCreated?: (response: CreateShiftResponse) => void;
}

/**
 * "Add shift" from the employee page: date, start and end wall-clock times (an end at or before the start is
 * overnight), optional location and notes → `POST /api/shifts` (local-time form). Recurrence and scheduled
 * breaks live in the full shift editor on the Schedule page.
 */
export function ShiftQuickFormDialog({
  open,
  onOpenChange,
  employee,
  onCreated,
}: ShiftQuickFormDialogProps) {
  const now = useNow();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Add a shift for {employee.firstName} {employee.lastName}
          </DialogTitle>
          <DialogDescription>
            Work Mode switches on when the shift starts and off when it ends. Times are local to the
            shift&apos;s location.
          </DialogDescription>
        </DialogHeader>
        {open && now !== null ? (
          <ShiftQuickForm
            key={employee.id}
            now={now}
            employee={employee}
            onClose={() => onOpenChange(false)}
            onCreated={onCreated}
          />
        ) : (
          <div className="space-y-4" aria-busy="true">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ShiftQuickForm({
  now,
  employee,
  onClose,
  onCreated,
}: {
  now: number;
  employee: ShiftQuickFormEmployee;
  onClose: () => void;
  onCreated?: (response: CreateShiftResponse) => void;
}) {
  const organisation = useCurrentOrganisation();
  const locations = useLocations();
  const create = useCreateShift();
  const [allowOverlap, setAllowOverlap] = useState(false);
  const organisationTimezone = organisation.data?.organisation.timezone ?? "UTC";

  const form = useZodForm(shiftQuickFormSchema, {
    defaultValues: defaultShiftQuickFormValues(
      new Date(now),
      organisationTimezone,
      employee.primaryLocation?.id ?? null,
    ),
  });
  const [startTime, endTime, locationId] = form.watch(["startTime", "endTime", "locationId"]);
  const overnight = isOvernightRange(startTime, endTime);
  const location = locations.data?.find((l) => l.id === locationId);
  const timezone = location?.timezone ?? organisationTimezone;
  const overlapError = hasErrorCode(create.error, "SHIFT_OVERLAP");

  const onSubmit = form.handleSubmit(async (values: ShiftQuickFormValues) => {
    try {
      const input = toCreateShiftInput(values, employee.id);
      const response = await create.mutateAsync(
        allowOverlap ? { ...input, allowOverlap: true } : input,
      );
      const first = response.shifts[0];
      toast.success("Shift added", { description: first ? first.displayRange : undefined });
      for (const warning of response.warnings.slice(0, 3)) toast.warning(warning.message);
      onClose();
      onCreated?.(response);
    } catch (error) {
      applyApiFieldErrors(form, error);
    }
  });

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} noValidate className="space-y-5">
        <FormErrorAlert error={create.error} title="Couldn't add the shift" />
        {overlapError ? (
          <div className="flex items-start gap-2.5 rounded-lg border p-3">
            <Checkbox
              id="shift-allow-overlap"
              checked={allowOverlap}
              onCheckedChange={(v) => setAllowOverlap(v === true)}
              className="mt-0.5"
            />
            <Label htmlFor="shift-allow-overlap" className="font-normal">
              Add it anyway. This employee is deliberately double-booked for this time.
            </Label>
          </div>
        ) : null}

        <TextField control={form.control} name="date" label="Date" type="date" autoComplete="off" />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            control={form.control}
            name="startTime"
            label="Starts"
            type="time"
            step={300}
            autoComplete="off"
          />
          <TextField
            control={form.control}
            name="endTime"
            label="Ends"
            type="time"
            step={300}
            autoComplete="off"
            description={overnight ? "Ends the next day (overnight shift)." : undefined}
          />
        </div>
        <ReferenceSelectField
          control={form.control}
          name="locationId"
          label="Location"
          options={referenceOptions(locations, (l) => ({
            id: l.id,
            name: l.name,
            hint: l.timezone ? formatTimeZoneLabel(l.timezone, now) : undefined,
          }))}
          isLoading={locations.isPending}
          noneLabel="No location"
          description={`Times are in ${formatTimeZoneLabel(timezone, now)}.`}
        />
        <TextareaField
          control={form.control}
          name="notes"
          label="Notes"
          placeholder="Optional, e.g. covering for Sam"
          rows={2}
        />

        <InlineAlert variant="info">
          Need repeats or scheduled breaks? Use the full editor on the Schedule page.
        </InlineAlert>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <SubmitButton isPending={create.isPending} pendingLabel="Adding…">
            Add shift
          </SubmitButton>
        </DialogFooter>
      </form>
    </Form>
  );
}
