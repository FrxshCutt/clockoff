"use client";

import type {
  BulkEmployeeActionInput,
  BulkEmployeeActionResponse,
  Employee,
} from "@workmode/validation/employees";
import { MapPin, PowerOff, Send, ShieldCheck } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { FormErrorAlert, SubmitButton } from "@/components/forms/form-fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useApiErrorToast } from "@/hooks/use-api-error-toast";
import { AssignPolicyDialog } from "./assign-policy-dialog";
import { summariseBulkResult } from "./bulk-result";
import { useBulkEmployeeAction, useLocations } from "./employee-api";
import { employeeFullName } from "./employee-view-model";
import { ReferenceSelect } from "./reference-select";

export interface EmployeeBulkActionsProps {
  selected: readonly Employee[];
  clearSelection: () => void;
}

type BulkDialog = "policy" | "location" | "invite" | "deactivate" | null;

/** Shows the per-item outcome of a bulk call as one toast (success / partial / failed). */
export function toastBulkResult(
  result: BulkEmployeeActionResponse,
  employees: readonly Employee[],
): void {
  const byId = new Map(employees.map((e) => [e.id, employeeFullName(e)]));
  const summary = summariseBulkResult(result, (id) => byId.get(id) ?? null);
  const options = summary.description ? { description: summary.description } : undefined;
  if (summary.tone === "success") toast.success(summary.title, options);
  else if (summary.tone === "warning") toast.warning(summary.title, options);
  else toast.error(summary.title, options);
}

/**
 * Bulk actions bar content for the employees table: assign policy, assign location, resend invites and
 * deactivate, each via one `POST /api/employees/bulk` call whose per-employee result is toasted.
 */
export function EmployeeBulkActions({ selected, clearSelection }: EmployeeBulkActionsProps) {
  const [dialog, setDialog] = useState<BulkDialog>(null);
  const bulk = useBulkEmployeeAction();
  const toastError = useApiErrorToast();
  const ids = useId();
  const locations = useLocations({ enabled: dialog === "location" });
  const [locationId, setLocationId] = useState("");

  const employeeIds = selected.map((e) => e.id);
  const count = selected.length;
  const noun = count === 1 ? "employee" : "employees";
  const invitable = selected.filter(
    (e) =>
      e.employmentStatus === "ACTIVE" &&
      (e.inviteStatus === "NOT_INVITED" || e.inviteStatus === "INVITED"),
  );

  const run = async (input: BulkEmployeeActionInput, failTitle: string) => {
    try {
      const result = await bulk.mutateAsync(input);
      toastBulkResult(result, selected);
      clearSelection();
      setDialog(null);
    } catch (error) {
      toastError(error, { title: failTitle });
      throw error;
    }
  };

  const close = (open: boolean) => {
    if (!open && !bulk.isPending) setDialog(null);
  };

  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setDialog("policy")}>
        <ShieldCheck aria-hidden="true" />
        Assign policy
      </Button>
      <Button type="button" size="sm" variant="outline" onClick={() => setDialog("location")}>
        <MapPin aria-hidden="true" />
        Assign location
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setDialog("invite")}
        disabled={invitable.length === 0}
        title={invitable.length === 0 ? "None of the selected employees can be invited" : undefined}
      >
        <Send aria-hidden="true" />
        Resend invites
      </Button>
      <Button type="button" size="sm" variant="outline" onClick={() => setDialog("deactivate")}>
        <PowerOff aria-hidden="true" />
        Deactivate
      </Button>

      <AssignPolicyDialog
        open={dialog === "policy"}
        onOpenChange={close}
        kind="policy"
        title={`Assign a Work Policy to ${count} ${noun}`}
        description="Sets an employee-level override on each selected employee. It wins over their team, location and organisation policies."
        allowClear={false}
        isPending={bulk.isPending}
        error={bulk.error}
        onSubmit={(policyId) => {
          if (!policyId) return Promise.reject(new Error("Choose a policy"));
          return run(
            { action: "ASSIGN_POLICY", employeeIds, payload: { policyId } },
            "Couldn't assign the policy",
          );
        }}
      />

      <Dialog open={dialog === "location"} onOpenChange={close}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Assign a primary location to {count} {noun}
            </DialogTitle>
            <DialogDescription>
              Each selected employee&apos;s primary location is replaced. Location-level policies
              apply through it.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-5"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                {
                  action: "ASSIGN_LOCATION",
                  employeeIds,
                  payload: { primaryLocationId: locationId || null },
                },
                "Couldn't assign the location",
              ).catch(() => undefined);
            }}
          >
            <FormErrorAlert error={bulk.error} title="Couldn't assign the location" />
            <div className="space-y-2">
              <Label htmlFor={`${ids}-location`}>Primary location</Label>
              <ReferenceSelect
                id={`${ids}-location`}
                value={locationId}
                onChange={setLocationId}
                options={locations.data?.map((l) => ({ id: l.id, name: l.name }))}
                isLoading={locations.isPending}
                noneLabel="No primary location"
                placeholder="Choose a location"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialog(null)}
                disabled={bulk.isPending}
              >
                Cancel
              </Button>
              <SubmitButton isPending={bulk.isPending} pendingLabel="Assigning…">
                {locationId ? "Assign location" : "Clear primary location"}
              </SubmitButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={dialog === "invite"}
        onOpenChange={close}
        title={`Send invites to ${invitable.length} ${invitable.length === 1 ? "employee" : "employees"}?`}
        description={
          <>
            Each employee gets a new personal code; any previous pending code is cancelled. Invites
            are created as share-it-yourself links — open an employee to copy their instructions.
            {invitable.length < count
              ? ` ${count - invitable.length} selected ${count - invitable.length === 1 ? "employee has" : "employees have"} already joined or ${count - invitable.length === 1 ? "is" : "are"} inactive and will be skipped.`
              : ""}
          </>
        }
        confirmLabel="Send invites"
        onConfirm={() =>
          run(
            {
              action: "INVITE",
              employeeIds: invitable.map((e) => e.id),
              payload: { channel: "LINK" },
            },
            "Couldn't send the invites",
          )
        }
      />

      <ConfirmDialog
        open={dialog === "deactivate"}
        onOpenChange={close}
        title={`Deactivate ${count} ${noun}?`}
        description="Their phones stop syncing and pending invites are cancelled. Work Mode no longer switches on for their shifts. You can reactivate them later."
        confirmLabel="Deactivate"
        destructive
        onConfirm={() =>
          run({ action: "DEACTIVATE", employeeIds }, "Couldn't deactivate the employees")
        }
      />
    </>
  );
}
