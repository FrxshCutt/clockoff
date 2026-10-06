"use client";

import type { Department } from "@workmode/validation/locationsTeams";
import { toast } from "sonner";
import {
  SubmitButton,
  TextField,
  applyApiFieldErrors,
  useZodForm,
} from "@/components/forms/form-fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Form } from "@/components/ui/form";
import {
  departmentFormSchema,
  describeStructureConflict,
  type DepartmentFormValues,
} from "./locations-view-model";
import { StructureErrorAlert } from "./structure-error-alert";
import { useCreateDepartment, useUpdateDepartment } from "./use-locations-teams";

export interface DepartmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Rename this department; omit to create a new one. */
  department?: Department | null;
}

/** Add / rename department: `POST /api/departments` or `PATCH /api/departments/:id`. */
export function DepartmentDialog({ open, onOpenChange, department = null }: DepartmentDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open ? (
          <DepartmentForm
            key={department?.id ?? "new"}
            department={department}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DepartmentForm({
  department,
  onClose,
}: {
  department: Department | null;
  onClose: () => void;
}) {
  const form = useZodForm(departmentFormSchema, {
    defaultValues: { name: department?.name ?? "" },
  });
  const create = useCreateDepartment();
  const update = useUpdateDepartment();
  const isPending = create.isPending || update.isPending;

  const onSubmit = form.handleSubmit(async (values: DepartmentFormValues) => {
    try {
      if (department) {
        if (values.name === department.name) {
          toast.info("No changes to save");
          onClose();
          return;
        }
        const saved = await update.mutateAsync({ id: department.id, input: { name: values.name } });
        toast.success(`Department renamed to ${saved.name}`);
      } else {
        const saved = await create.mutateAsync({ name: values.name });
        toast.success(`${saved.name} added`);
      }
      onClose();
    } catch (error) {
      // A duplicate name (409 with `details.field`) belongs on the Name field, like a validation error.
      const conflict = describeStructureConflict(error, "department");
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
      <form onSubmit={onSubmit} noValidate className="space-y-5">
        <DialogHeader>
          <DialogTitle>{department ? `Rename ${department.name}` : "Add department"}</DialogTitle>
          <DialogDescription>
            Departments group employees for filtering and reporting. Names must be unique within
            your organisation.
          </DialogDescription>
        </DialogHeader>
        <StructureErrorAlert
          error={create.error ?? update.error}
          kind="department"
          title={department ? "Couldn't rename the department" : "Couldn't add the department"}
        />
        <TextField
          control={form.control}
          name="name"
          label="Name"
          placeholder="e.g. Kitchen"
          autoComplete="off"
          autoFocus
        />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <SubmitButton isPending={isPending} pendingLabel="Saving…">
            {department ? "Save" : "Add department"}
          </SubmitButton>
        </DialogFooter>
      </form>
    </Form>
  );
}
