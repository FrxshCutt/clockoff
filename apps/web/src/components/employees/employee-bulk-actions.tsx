"use client";

import type {
  BulkEmployeeActionInput,
  BulkEmployeeActionResponse,
  Employee,
} from "@clockoff/validation/employees";
import { MapPin, Power, PowerOff, Send, ShieldCheck, Users } from "lucide-react";
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
import { useBulkEmployeeAction, useLocations, useTeams } from "./employee-api";
import { employeeFullName } from "./employee-view-model";
import { ReferenceSelect, referenceOptions } from "./reference-select";

export interface EmployeeBulkActionsProps {
  selected: readonly Employee[];
  clearSelection: () => void;
}

type BulkDialog = "policy" | "location" | "team" | "invite" | "deactivate" | "reactivate" | null;

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

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** " 2 selected employees are already inactive and will be skipped." (or "" when nothing is skipped). */
function skippedNote(skipped: number, why: string): string {
  if (skipped === 0) return "";
  return ` ${skipped} selected ${skipped === 1 ? "employee is" : "employees are"} ${why} and will be skipped.`;
}

/**
 * Bulk actions bar content for the employees table: assign policy, assign location, add to team, send
 * invites, deactivate and reactivate, each via one `POST /api/employees/bulk` call whose per-employee
 * result is toasted (`summariseBulkResult`). Employees the action cannot apply to are left out of the
 * request and the confirmation says so, so the toast only reports real failures.
 */
export function EmployeeBulkActions({ selected, clearSelection }: EmployeeBulkActionsProps) {
  const [dialog, setDialog] = useState<BulkDialog>(null);
  const bulk = useBulkEmployeeAction();
  const toastError = useApiErrorToast();
  const ids = useId();
  const locations = useLocations({ enabled: dialog === "location" });
  const teams = useTeams({ enabled: dialog === "team" });
  const [locationId, setLocationId] = useState("");
  const [teamId, setTeamId] = useState("");

  const employeeIds = selected.map((e) => e.id);
  const count = selected.length;
  const noun = count === 1 ? "employee" : "employees";
  const active = selected.filter((e) => e.employmentStatus === "ACTIVE");
  const inactive = selected.filter((e) => e.employmentStatus === "INACTIVE");
  const invitable = active.filter(
    (e) => e.inviteStatus === "NOT_INVITED" || e.inviteStatus === "INVITED",
  );

  // Every dialog starts clean: no error from a previous batch, no stale selection.
  const openDialog = (next: Exclude<BulkDialog, null>) => {
    bulk.reset();
    setLocationId("");
    setTeamId("");
    setDialog(next);
  };

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
      <Button type="button" size="sm" variant="outline" onClick={() => openDialog("policy")}>
        <ShieldCheck aria-hidden="true" />
        Assign policy
      </Button>
      <Button type="button" size="sm" variant="outline" onClick={() => openDialog("location")}>
        <MapPin aria-hidden="true" />
        Assign location
      </Button>
      <Button type="button" size="sm" variant="outline" onClick={() => openDialog("team")}>
        <Users aria-hidden="true" />
        Add to team
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => openDialog("invite")}
        disabled={invitable.length === 0}
        title={
          invitable.length === 0
            ? "None of the selected employees can be invited (already joined or inactive)"
            : undefined
        }
      >
        <Send aria-hidden="true" />
        Send invites
      </Button>
      {active.length > 0 ? (
        <Button type="button" size="sm" variant="outline" onClick={() => openDialog("deactivate")}>
          <PowerOff aria-hidden="true" />
          Deactivate
        </Button>
      ) : null}
      {inactive.length > 0 ? (
        <Button type="button" size="sm" variant="outline" onClick={() => openDialog("reactivate")}>
          <Power aria-hidden="true" />
          Reactivate
        </Button>
      ) : null}

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
                options={referenceOptions(locations, (l) => ({ id: l.id, name: l.name }))}
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

      <Dialog open={dialog === "team"} onOpenChange={close}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Add {count} {noun} to a team
            </DialogTitle>
            <DialogDescription>
              Adds each selected employee to the team (their other teams are kept). Team-level
              policies apply to every member.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-5"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (!teamId) return;
              void run(
                { action: "ADD_TO_TEAM", employeeIds, payload: { teamId } },
                "Couldn't add to the team",
              ).catch(() => undefined);
            }}
          >
            <FormErrorAlert error={bulk.error} title="Couldn't add to the team" />
            <div className="space-y-2">
              <Label htmlFor={`${ids}-team`}>Team</Label>
              <ReferenceSelect
                id={`${ids}-team`}
                value={teamId}
                onChange={setTeamId}
                options={referenceOptions(teams, (t) => ({
                  id: t.id,
                  name: t.name,
                  hint: t.location?.name,
                }))}
                isLoading={teams.isPending}
                placeholder="Choose a team"
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
              <SubmitButton isPending={bulk.isPending} pendingLabel="Adding…" disabled={!teamId}>
                Add to team
              </SubmitButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={dialog === "invite"}
        onOpenChange={close}
        title={`Send invites to ${plural(invitable.length, "employee")}?`}
        description={
          <>
            Each employee gets a new personal code; any previous pending code is cancelled. Invites
            are created as share-it-yourself links — open an employee to copy their instructions.
            {skippedNote(count - invitable.length, "already joined or inactive")}
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
        title={`Deactivate ${plural(active.length, "employee")}?`}
        description={`Their phones stop syncing and pending invites are cancelled. Work Mode no longer switches on for their shifts. You can reactivate them later; they will need to join again from the app.${skippedNote(inactive.length, "already inactive")}`}
        confirmLabel="Deactivate"
        destructive
        onConfirm={() =>
          run(
            { action: "DEACTIVATE", employeeIds: active.map((e) => e.id) },
            "Couldn't deactivate the employees",
          )
        }
      />

      <ConfirmDialog
        open={dialog === "reactivate"}
        onOpenChange={close}
        title={`Reactivate ${plural(inactive.length, "employee")}?`}
        description={`They become active again and can be invited to connect their phones; previous devices must join again from the app. Counts towards your plan's active-employee limit.${skippedNote(active.length, "already active")}`}
        confirmLabel="Reactivate"
        onConfirm={() =>
          run(
            { action: "REACTIVATE", employeeIds: inactive.map((e) => e.id) },
            "Couldn't reactivate the employees",
          )
        }
      />
    </>
  );
}
