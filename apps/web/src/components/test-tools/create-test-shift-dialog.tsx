"use client";

import {
  TEST_SHIFT_LIMITS,
  createTestShiftResponseSchema,
  type CreateTestShiftInput,
  type CreateTestShiftResponse,
} from "@clockoff/validation/testTools";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FlaskConical } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { invalidateEmployees } from "@/components/employees/employee-api";
import { useNow } from "@/components/employees/use-now";
import { FormErrorAlert, SubmitButton } from "@/components/forms/form-fields";
import { EmployeePicker, type EmployeeRef } from "@/components/schedule/employee-picker";
import { invalidateShifts } from "@/components/schedule/schedule-queries";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseResponse } from "@/hooks/api-shapes";
import { useCurrentMembership } from "@/hooks/use-current-user";
import { api } from "@/lib/api-client";
import { getFieldErrors } from "@/lib/errorMessages";
import { formatTime } from "@/lib/format";
import {
  DEFAULT_TEST_SHIFT_VALUES,
  TEST_SHIFT_COPY,
  buildTestShiftInput,
  previewTestShift,
  testShiftSuccessDescription,
  type TestShiftField,
} from "./test-shift-model";

/** `POST /api/test-tools/test-shift`; refreshes everything that lists shifts. */
export function useCreateTestShift() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateTestShiftInput): Promise<CreateTestShiftResponse> =>
      parseResponse(
        createTestShiftResponseSchema,
        await api.post<unknown>("/api/test-tools/test-shift", input),
        "POST /api/test-tools/test-shift",
      ),
    onSuccess: async () => {
      await Promise.all([invalidateEmployees(queryClient), invalidateShifts(queryClient)]);
    },
  });
}

export interface CreateTestShiftDialogProps {
  /** The employee the shift is for. With `chooseEmployee`, only the initial choice. */
  employee: EmployeeRef | null;
  /** Show an employee picker (the schedule page); otherwise the shift is always for `employee`. */
  chooseEmployee?: boolean;
  /** The element that opens the dialog. */
  trigger: ReactNode;
}

/**
 * "Create test shift…" (phone testing): a shift starting N minutes from now so a tester can watch
 * Work Mode switch on and off on a real iPhone. Render it only when `useCanCreateTestShift()` (the
 * organisation has the test tools and the manager has `schedule:write`); the API answers 404 for
 * organisations without the test tools.
 */
export function CreateTestShiftDialog({
  employee,
  chooseEmployee = false,
  trigger,
}: CreateTestShiftDialogProps) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {/* Remount per opening so the form always starts from the defaults. */}
        {open ? (
          <CreateTestShiftForm
            employee={employee}
            chooseEmployee={chooseEmployee}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** The dialog body (exported for render tests). */
export function CreateTestShiftForm({
  employee: initialEmployee,
  chooseEmployee,
  onClose,
}: {
  employee: EmployeeRef | null;
  chooseEmployee: boolean;
  onClose: () => void;
}) {
  const ids = useId();
  const now = useNow();
  const membership = useCurrentMembership();
  const create = useCreateTestShift();
  const [employee, setEmployee] = useState<EmployeeRef | null>(initialEmployee);
  const [startsIn, setStartsIn] = useState(DEFAULT_TEST_SHIFT_VALUES.startsIn);
  const [duration, setDuration] = useState(DEFAULT_TEST_SHIFT_VALUES.duration);
  const [fieldError, setFieldError] = useState<{ field: TestShiftField; message: string } | null>(
    null,
  );

  const timeZone = membership?.timezone;
  const preview = now === null ? null : previewTestShift({ startsIn, duration }, new Date(now));
  const employeeName = employee ? `${employee.firstName} ${employee.lastName}` : null;
  const errorFor = (field: TestShiftField) =>
    fieldError?.field === field ? fieldError.message : null;

  const submit = async () => {
    setFieldError(null);
    const built = buildTestShiftInput({ employeeId: employee?.id ?? null, startsIn, duration });
    if (!built.ok) {
      setFieldError({ field: built.field, message: built.message });
      return;
    }
    try {
      const { shift } = await create.mutateAsync(built.input);
      toast.success(TEST_SHIFT_COPY.successTitle, {
        description: testShiftSuccessDescription(
          `${shift.employee.firstName} ${shift.employee.lastName}`,
          shift.displayRange,
        ),
      });
      onClose();
    } catch (error) {
      const fields = getFieldErrors(error);
      if (fields.durationMinutes !== undefined)
        setFieldError({ field: "duration", message: fields.durationMinutes });
      else if (fields.startsInMinutes !== undefined)
        setFieldError({ field: "startsIn", message: fields.startsInMinutes });
      else if (fields.employeeId !== undefined)
        setFieldError({ field: "employee", message: fields.employeeId });
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <FlaskConical className="text-muted-foreground size-5" aria-hidden="true" />
          {!chooseEmployee && employeeName
            ? `${TEST_SHIFT_COPY.title} for ${employeeName}`
            : TEST_SHIFT_COPY.title}
        </DialogTitle>
        <DialogDescription>{TEST_SHIFT_COPY.description}</DialogDescription>
      </DialogHeader>

      <form
        className="space-y-5"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <FormErrorAlert
          error={fieldError ? null : create.error}
          title={TEST_SHIFT_COPY.errorTitle}
        />

        {chooseEmployee ? (
          <div className="space-y-1.5">
            <Label htmlFor={`${ids}-employee`}>{TEST_SHIFT_COPY.employeeLabel}</Label>
            <EmployeePicker
              id={`${ids}-employee`}
              value={employee?.id ?? null}
              selected={employee}
              onChange={setEmployee}
              placeholder={TEST_SHIFT_COPY.employeePlaceholder}
              aria-invalid={errorFor("employee") ? true : undefined}
              className="w-full"
            />
            {errorFor("employee") ? (
              <p className="text-destructive text-xs" role="alert">
                {errorFor("employee")}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <MinutesField
            id={`${ids}-starts-in`}
            label={TEST_SHIFT_COPY.startsInLabel}
            value={startsIn}
            onChange={setStartsIn}
            min={TEST_SHIFT_LIMITS.minStartsInMinutes}
            max={TEST_SHIFT_LIMITS.maxStartsInMinutes}
            error={errorFor("startsIn")}
          />
          <MinutesField
            id={`${ids}-duration`}
            label={TEST_SHIFT_COPY.durationLabel}
            value={duration}
            onChange={setDuration}
            min={TEST_SHIFT_LIMITS.minDurationMinutes}
            max={TEST_SHIFT_LIMITS.maxDurationMinutes}
            error={errorFor("duration")}
          />
        </div>

        <div className="space-y-1">
          <p className="text-muted-foreground text-xs">{TEST_SHIFT_COPY.note}</p>
          {preview ? (
            <p className="text-sm" aria-live="polite">
              Starts at <strong>{formatTime(preview.startsAt, { timeZone })}</strong> and ends at{" "}
              <strong>{formatTime(preview.endsAt, { timeZone })}</strong>.
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={create.isPending}>
            {TEST_SHIFT_COPY.cancel}
          </Button>
          <SubmitButton isPending={create.isPending} pendingLabel={TEST_SHIFT_COPY.pending}>
            {TEST_SHIFT_COPY.submit}
          </SubmitButton>
        </DialogFooter>
      </form>
    </>
  );
}

function MinutesField({
  id,
  label,
  value,
  onChange,
  min,
  max,
  error,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  min: number;
  max: number;
  error: string | null;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      {error ? (
        <p id={`${id}-error`} className="text-destructive text-xs" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
