"use client";

import type { ImportRow, UpdateImportRowInput } from "@clockoff/validation/imports";
import {
  Building2,
  ChevronDown,
  LoaderCircle,
  MapPinOff,
  MapPinPlus,
  UserPlus,
} from "lucide-react";
import { useState } from "react";
import {
  FormErrorAlert,
  SubmitButton,
  TextField,
  applyApiFieldErrors,
  useZodForm,
} from "@/components/forms/form-fields";
import { InlineAlert } from "@/components/inline-alert";
import { EmployeePicker, type EmployeeRef } from "@/components/schedule/employee-picker";
import { employeeName } from "@/components/schedule/schedule-model";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Form } from "@/components/ui/form";
import { hasErrorCode } from "@/lib/api-client";
import {
  createEmployeeFormDefaults,
  createEmployeeFormSchema,
  prefillCreateEmployee,
  rowEmployeeLabel,
  toCreateEmployeeRowInput,
  type CreateEmployeeFormValues,
} from "./import-wizard-model";

/** Runs the `PATCH /api/imports/:id/rows/:rowId`; rejects on failure so the dialog can stay open. */
export type SubmitRowFix = (input: UpdateImportRowInput) => Promise<unknown>;

// ── Choose an existing employee ─────────────────────────────────────────────

export interface ChooseEmployeeDialogProps {
  row: ImportRow | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: SubmitRowFix;
}

/** MULTIPLE_MATCHES / EMPLOYEE_NOT_FOUND: pick the employee the row belongs to. */
export function ChooseEmployeeDialog({ row, onOpenChange, onSubmit }: ChooseEmployeeDialogProps) {
  return (
    <Dialog open={row !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {row ? (
          <ChooseEmployeeBody
            key={row.id}
            row={row}
            onSubmit={onSubmit}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ChooseEmployeeBody({
  row,
  onSubmit,
  onDone,
}: {
  row: ImportRow;
  onSubmit: SubmitRowFix;
  onDone: () => void;
}) {
  const [selected, setSelected] = useState<EmployeeRef | null>(
    row.matchedEmployee ? { ...row.matchedEmployee } : null,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const label = rowEmployeeLabel(row);
  const candidates = row.problems.find((p) => p.code === "MULTIPLE_MATCHES")?.details?.candidateIds;
  const candidateCount = Array.isArray(candidates) ? candidates.length : 0;

  const submit = async () => {
    if (!selected) return;
    setPending(true);
    setError(null);
    try {
      await onSubmit({ matchedEmployeeId: selected.id });
      onDone();
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Choose the employee for row {row.rowNumber}</DialogTitle>
        <DialogDescription>
          The file says <span className="text-foreground font-medium">{label.label}</span>
          {candidateCount > 1
            ? `, which matches ${candidateCount} employees.`
            : ", which doesn't match anyone exactly."}{" "}
          Pick who this shift is for.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <EmployeePicker
          value={selected?.id ?? null}
          selected={selected}
          onChange={setSelected}
          defaultSearch={row.parsed?.employeeName ?? row.parsed?.email ?? ""}
          aria-label="Employee"
          className="w-full"
        />
        {selected ? (
          <p className="text-muted-foreground text-sm">
            Row {row.rowNumber} will be imported for {employeeName(selected)}.
          </p>
        ) : null}
        {error ? <FormErrorAlert error={error} title="Couldn't match the row" /> : null}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={() => void submit()}
          disabled={!selected || pending}
          aria-busy={pending || undefined}
        >
          {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
          Use this employee
        </Button>
      </DialogFooter>
    </>
  );
}

// ── Create a new employee ───────────────────────────────────────────────────

export interface CreateEmployeeDialogProps {
  row: ImportRow | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: SubmitRowFix;
}

/** EMPLOYEE_NOT_FOUND: create the employee from the row (name, email and ID pre-filled) and match it. */
export function CreateEmployeeDialog({ row, onOpenChange, onSubmit }: CreateEmployeeDialogProps) {
  return (
    <Dialog open={row !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {row ? (
          <CreateEmployeeBody
            key={row.id}
            row={row}
            onSubmit={onSubmit}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function CreateEmployeeBody({
  row,
  onSubmit,
  onDone,
}: {
  row: ImportRow;
  onSubmit: SubmitRowFix;
  onDone: () => void;
}) {
  const form = useZodForm(createEmployeeFormSchema, {
    defaultValues: createEmployeeFormDefaults(prefillCreateEmployee(row)),
  });
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  const submit = form.handleSubmit(async (values: CreateEmployeeFormValues) => {
    setPending(true);
    setError(null);
    try {
      await onSubmit(toCreateEmployeeRowInput(values));
      onDone();
    } catch (cause) {
      if (!applyApiFieldErrors(form, cause)) setError(cause);
    } finally {
      setPending(false);
    }
  });

  return (
    <Form {...form}>
      <form onSubmit={submit} noValidate className="contents">
        <DialogHeader>
          <DialogTitle>Create employee for row {row.rowNumber}</DialogTitle>
          <DialogDescription>
            The employee is created now and this row (and others with the same identifier) are
            matched to them.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              control={form.control}
              name="firstName"
              label="First name"
              autoComplete="off"
            />
            <TextField
              control={form.control}
              name="lastName"
              label="Last name"
              autoComplete="off"
            />
          </div>
          <TextField
            control={form.control}
            name="email"
            label="Email"
            type="email"
            autoComplete="off"
            description="Optional. Used to match future imports and to invite them."
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              control={form.control}
              name="externalEmployeeId"
              label="Employee ID"
              autoComplete="off"
              description="Optional. Your payroll / rota ID."
            />
            <TextField
              control={form.control}
              name="jobTitle"
              label="Job title"
              autoComplete="off"
              description="Optional."
            />
          </div>
          {error ? (
            hasErrorCode(error, "CONFLICT") ? (
              <InlineAlert
                variant="danger"
                title="An employee with this email or ID already exists"
              >
                Choose them with &ldquo;Choose employee&rdquo; instead, or change the email / ID.
              </InlineAlert>
            ) : (
              <FormErrorAlert error={error} title="Couldn't create the employee" />
            )
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDone} disabled={pending}>
            Cancel
          </Button>
          <SubmitButton isPending={pending} pendingLabel="Creating…">
            <UserPlus aria-hidden="true" />
            Create and match
          </SubmitButton>
        </DialogFooter>
      </form>
    </Form>
  );
}

// ── Unknown location ────────────────────────────────────────────────────────

export interface LocationFixMenuProps {
  locationName: string | null;
  disabled?: boolean;
  onAction: (action: "CREATE" | "IGNORE") => void;
}

/** UNKNOWN_LOCATION: create the location with that name, or import the row without a location. */
export function LocationFixMenu({ locationName, disabled, onAction }: LocationFixMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="xs" disabled={disabled}>
          <Building2 aria-hidden="true" />
          Location
          <ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="truncate font-normal">
          Unknown location{locationName ? `: ${locationName}` : ""}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onAction("CREATE")}>
          <MapPinPlus aria-hidden="true" />
          Create this location
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAction("IGNORE")}>
          <MapPinOff aria-hidden="true" />
          Import without a location
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
