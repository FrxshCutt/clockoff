"use client";

import type { Employee } from "@workmode/validation/employees";
import { toast } from "sonner";
import {
  FormErrorAlert,
  SubmitButton,
  TextField,
  applyApiFieldErrors,
  useZodForm,
} from "@/components/forms/form-fields";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  useBreakPolicies,
  useCreateEmployee,
  useDepartments,
  useLocations,
  usePolicies,
  useTeams,
  useUpdateEmployee,
} from "./employee-api";
import {
  EMPTY_EMPLOYEE_FORM,
  employeeFormSchema,
  employeeToFormValues,
  toCreateEmployeeInput,
  toUpdateEmployeeInput,
  type EmployeeFormValues,
} from "./employee-form";
import { employeeFullName } from "./employee-view-model";
import { CheckboxGroupField, ReferenceSelectField, referenceOptions } from "./reference-select";

export interface EmployeeFormSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this employee; omit to create a new one. */
  employee?: Employee | null;
  onSaved?: (employee: Employee, mode: "create" | "edit") => void;
}

/** Add / Edit employee drawer: `POST /api/employees` or `PATCH /api/employees/:id` (changed fields only). */
export function EmployeeFormSheet({
  open,
  onOpenChange,
  employee = null,
  onSaved,
}: EmployeeFormSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        {/* Keyed so switching employee (or reopening) always starts from fresh values. */}
        {open ? (
          <EmployeeForm
            key={employee?.id ?? "new"}
            employee={employee}
            onClose={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function EmployeeForm({
  employee,
  onClose,
  onSaved,
}: {
  employee: Employee | null;
  onClose: () => void;
  onSaved?: (employee: Employee, mode: "create" | "edit") => void;
}) {
  const mode = employee ? "edit" : "create";
  const form = useZodForm(employeeFormSchema, {
    defaultValues: employee ? employeeToFormValues(employee) : EMPTY_EMPLOYEE_FORM,
  });
  const create = useCreateEmployee();
  const update = useUpdateEmployee();
  const locations = useLocations();
  const departments = useDepartments();
  const teams = useTeams();
  const policies = usePolicies();
  const breakPolicies = useBreakPolicies();

  const isPending = create.isPending || update.isPending;
  const mutationError = create.error ?? update.error;
  const primaryLocationId = form.watch("primaryLocationId");

  const onSubmit = form.handleSubmit(async (values: EmployeeFormValues) => {
    try {
      if (employee) {
        const input = toUpdateEmployeeInput(values, employee);
        if (!input) {
          toast.info("No changes to save");
          onClose();
          return;
        }
        const saved = await update.mutateAsync({ id: employee.id, input });
        toast.success(`${employeeFullName(saved)} updated`);
        onClose();
        onSaved?.(saved, "edit");
      } else {
        const saved = await create.mutateAsync(toCreateEmployeeInput(values));
        toast.success(`${employeeFullName(saved)} added`, {
          description: "Invite them so they can connect their phone.",
        });
        onClose();
        onSaved?.(saved, "create");
      }
    } catch (error) {
      applyApiFieldErrors(form, error);
    }
  });

  const locationOptions = referenceOptions(locations, (l) => ({ id: l.id, name: l.name }));
  const teamOptions = referenceOptions(teams, (t) => ({
    id: t.id,
    name: t.name,
    hint: t.location?.name,
  }));
  const departmentOptions = referenceOptions(departments, (d) => ({ id: d.id, name: d.name }));
  const policyOptions = referenceOptions(
    { data: policies.data?.filter((p) => p.status !== "ARCHIVED"), isError: policies.isError },
    (p) => ({
      id: p.id,
      name: p.name,
      hint: p.status === "ACTIVE" ? undefined : "Draft — publish first",
      disabled: p.status !== "ACTIVE",
    }),
  );
  const breakPolicyOptions = referenceOptions(
    {
      data: breakPolicies.data?.filter((p) => p.status !== "ARCHIVED"),
      isError: breakPolicies.isError,
    },
    (p) => ({ id: p.id, name: p.name, disabled: p.status !== "ACTIVE" }),
  );
  // Names and contact details can still be saved when a reference list fails; say so instead of hiding it.
  const referenceError =
    locations.error ?? departments.error ?? teams.error ?? policies.error ?? breakPolicies.error;

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
        <SheetHeader className="border-b px-6 py-5">
          <SheetTitle>
            {mode === "edit" ? `Edit ${employeeFullName(employee!)}` : "Add employee"}
          </SheetTitle>
          <SheetDescription>
            {mode === "edit"
              ? "Changes apply straight away. Policy changes reach the phone on its next sync."
              : "Add the person first, then invite them to connect their phone from the Work Mode app."}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5">
          <FormErrorAlert
            error={mutationError}
            title={mode === "edit" ? "Couldn't save changes" : "Couldn't add the employee"}
          />
          {referenceError ? (
            <FormErrorAlert
              error={referenceError}
              title="Couldn't load locations, teams or policies — you can still save the other details"
            />
          ) : null}

          <section className="space-y-4" aria-labelledby="employee-form-identity">
            <h3 id="employee-form-identity" className="text-sm font-semibold">
              Details
            </h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                control={form.control}
                name="firstName"
                label="First name"
                autoComplete="off"
                autoFocus={mode === "create"}
              />
              <TextField
                control={form.control}
                name="lastName"
                label="Last name"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                control={form.control}
                name="email"
                label="Email"
                type="email"
                inputMode="email"
                autoComplete="off"
                placeholder="Optional"
                description="Needed to send invites by email."
              />
              <TextField
                control={form.control}
                name="phone"
                label="Phone"
                type="tel"
                inputMode="tel"
                autoComplete="off"
                placeholder="Optional"
                description="For SMS invites (coming soon)."
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                control={form.control}
                name="externalEmployeeId"
                label="Employee ID"
                autoComplete="off"
                placeholder="Optional"
                description="Matches rota imports and integrations."
              />
              <TextField
                control={form.control}
                name="jobTitle"
                label="Job title"
                autoComplete="off"
                placeholder="Optional"
              />
            </div>
          </section>

          <Separator />

          <section className="space-y-4" aria-labelledby="employee-form-place">
            <h3 id="employee-form-place" className="text-sm font-semibold">
              Where they work
            </h3>
            <ReferenceSelectField
              control={form.control}
              name="departmentId"
              label="Department"
              options={departmentOptions}
              isLoading={departments.isPending}
              noneLabel="No department"
            />
            <ReferenceSelectField
              control={form.control}
              name="primaryLocationId"
              label="Primary location"
              options={locationOptions}
              isLoading={locations.isPending}
              noneLabel="No primary location"
              description="Location-level policies apply through the primary location."
            />
            <CheckboxGroupField
              control={form.control}
              name="locationIds"
              label="Additional locations"
              options={locationOptions}
              isLoading={locations.isPending}
              lockedIds={primaryLocationId ? [primaryLocationId] : []}
              emptyText="No locations yet. Add them under Locations & Teams."
            />
            <CheckboxGroupField
              control={form.control}
              name="teamIds"
              label="Teams"
              options={teamOptions}
              isLoading={teams.isPending}
              emptyText="No teams yet. Add them under Locations & Teams."
              description="Team-level policies apply to every member."
            />
          </section>

          <Separator />

          <section className="space-y-4" aria-labelledby="employee-form-policy">
            <div className="space-y-1">
              <h3 id="employee-form-policy" className="text-sm font-semibold">
                Policy overrides
              </h3>
              <p className="text-muted-foreground text-xs">
                Leave these empty to inherit from the team, location or organisation. An
                employee-level override always wins.
              </p>
            </div>
            <ReferenceSelectField
              control={form.control}
              name="policyId"
              label="Work Policy override"
              options={policyOptions}
              isLoading={policies.isPending}
              noneLabel="No override (inherit)"
            />
            <ReferenceSelectField
              control={form.control}
              name="breakPolicyId"
              label="Break Rules override"
              options={breakPolicyOptions}
              isLoading={breakPolicies.isPending}
              noneLabel="No override (inherit)"
            />
          </section>
        </div>

        <SheetFooter className="flex-row justify-end gap-2 border-t px-6 py-4">
          <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <SubmitButton
            isPending={isPending}
            pendingLabel={mode === "edit" ? "Saving…" : "Adding…"}
          >
            {mode === "edit" ? "Save changes" : "Add employee"}
          </SubmitButton>
        </SheetFooter>
      </form>
    </Form>
  );
}
