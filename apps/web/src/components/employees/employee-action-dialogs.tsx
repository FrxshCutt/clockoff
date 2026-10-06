"use client";

import type { Employee } from "@workmode/validation/employees";
import type { InviteInstructions } from "@workmode/validation/invites";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CreateInviteDialog } from "@/components/invites/create-invite-dialog";
import { InviteInstructionsModal } from "@/components/invites/invite-instructions-modal";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useApiErrorToast } from "@/hooks/use-api-error-toast";
import { AssignPolicyDialog } from "./assign-policy-dialog";
import {
  useAssignEmployeeBreakPolicy,
  useAssignEmployeePolicy,
  useEmployeeLifecycleAction,
} from "./employee-api";
import { EmployeeFormSheet } from "./employee-form-sheet";
import { employeeFullName } from "./employee-view-model";

/** Row / header actions that open a dialog. "view" navigates and is handled by the caller. */
export type EmployeeDialogAction =
  | "edit"
  | "invite"
  | "assignPolicy"
  | "assignBreakPolicy"
  | "deactivate"
  | "reactivate"
  | "archive";

export interface EmployeeActionRequest {
  action: EmployeeDialogAction;
  employee: Employee;
}

export interface EmployeeActionDialogsProps {
  request: EmployeeActionRequest | null;
  onClose: () => void;
  /** Called after the action succeeded (e.g. to navigate away after archiving). */
  onCompleted?: (request: EmployeeActionRequest, result: Employee | null) => void;
}

/**
 * One instance per page hosts every employee action dialog (edit sheet, invite → instructions, assign
 * policy/break rules, deactivate with reason, reactivate, archive), so tables and headers only emit requests.
 */
export function EmployeeActionDialogs({
  request,
  onClose,
  onCompleted,
}: EmployeeActionDialogsProps) {
  const lifecycle = useEmployeeLifecycleAction();
  const assignPolicy = useAssignEmployeePolicy();
  const assignBreakPolicy = useAssignEmployeeBreakPolicy();
  const toastError = useApiErrorToast();
  const [deactivateReason, setDeactivateReason] = useState("");
  const [instructions, setInstructions] = useState<InviteInstructions | null>(null);

  const employee = request?.employee ?? null;
  const name = employee ? employeeFullName(employee) : "";
  const is = (action: EmployeeDialogAction) => request?.action === action;

  const closeIf = (open: boolean) => {
    if (!open) onClose();
  };

  const runLifecycle = async (action: "deactivate" | "reactivate" | "archive", success: string) => {
    if (!request) return;
    try {
      const result = await lifecycle.mutateAsync({
        id: request.employee.id,
        action,
        reason: deactivateReason,
      });
      toast.success(success);
      setDeactivateReason("");
      onCompleted?.(request, result);
    } catch (error) {
      toastError(error, { title: "Couldn't update the employee" });
      throw error;
    }
  };

  return (
    <>
      <EmployeeFormSheet
        open={is("edit")}
        onOpenChange={closeIf}
        employee={employee}
        onSaved={(saved) => request && onCompleted?.(request, saved)}
      />

      {employee ? (
        <CreateInviteDialog
          open={is("invite")}
          onOpenChange={closeIf}
          employee={employee}
          onCreated={(result) => {
            setInstructions(result.instructions);
            if (request) onCompleted?.(request, null);
          }}
        />
      ) : null}
      <InviteInstructionsModal
        open={instructions !== null}
        onOpenChange={(open) => (open ? undefined : setInstructions(null))}
        instructions={instructions}
      />

      {employee ? (
        <AssignPolicyDialog
          open={is("assignPolicy")}
          onOpenChange={closeIf}
          kind="policy"
          title={`Work Policy for ${name}`}
          description="An employee-level assignment overrides the team, location and organisation policies."
          currentId={employee.policyOverride?.id ?? null}
          isPending={assignPolicy.isPending}
          error={assignPolicy.error}
          onSubmit={async (policyId) => {
            try {
              const result = await assignPolicy.mutateAsync({ id: employee.id, policyId });
              toast.success(
                policyId ? `Policy assigned to ${name}` : `Policy override removed for ${name}`,
              );
              if (request) onCompleted?.(request, result);
            } catch (error) {
              toastError(error, { title: "Couldn't assign the policy" });
              throw error;
            }
          }}
        />
      ) : null}

      {employee ? (
        <AssignPolicyDialog
          open={is("assignBreakPolicy")}
          onOpenChange={closeIf}
          kind="breakPolicy"
          title={`Break Rules for ${name}`}
          description="An employee-level assignment overrides the team, location and organisation Break Rules."
          currentId={employee.breakPolicyOverride?.id ?? null}
          isPending={assignBreakPolicy.isPending}
          error={assignBreakPolicy.error}
          onSubmit={async (breakPolicyId) => {
            try {
              const result = await assignBreakPolicy.mutateAsync({
                id: employee.id,
                breakPolicyId,
              });
              toast.success(
                breakPolicyId
                  ? `Break Rules assigned to ${name}`
                  : `Break Rules override removed for ${name}`,
              );
              if (request) onCompleted?.(request, result);
            } catch (error) {
              toastError(error, { title: "Couldn't assign the Break Rules" });
              throw error;
            }
          }}
        />
      ) : null}

      <ConfirmDialog
        open={is("deactivate")}
        onOpenChange={(open) => {
          if (!open) {
            setDeactivateReason("");
            onClose();
          }
        }}
        title={`Deactivate ${name}?`}
        description="Their phone stops syncing and pending invites are cancelled. Work Mode no longer switches on for their shifts. You can reactivate them later; they will need to join again from the app."
        confirmLabel="Deactivate"
        destructive
        onConfirm={() => runLifecycle("deactivate", `${name} deactivated`)}
      >
        <div className="space-y-2">
          <Label htmlFor="deactivate-reason" className="text-sm font-normal">
            Reason (optional, kept in the audit log)
          </Label>
          <Textarea
            id="deactivate-reason"
            value={deactivateReason}
            onChange={(event) => setDeactivateReason(event.target.value)}
            maxLength={500}
            rows={2}
            placeholder="e.g. Left the company"
          />
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={is("reactivate")}
        onOpenChange={closeIf}
        title={`Reactivate ${name}?`}
        description="They become active again and can be invited to connect their phone. Their previous device must join again from the app."
        confirmLabel="Reactivate"
        onConfirm={() => runLifecycle("reactivate", `${name} reactivated`)}
      />

      <ConfirmDialog
        open={is("archive")}
        onOpenChange={closeIf}
        title={`Archive ${name}?`}
        description="Archiving deactivates the employee and removes them from every list. Their history is kept for audit. This can't be undone from the dashboard."
        confirmLabel="Archive employee"
        destructive
        onConfirm={() => runLifecycle("archive", `${name} archived`)}
      />
    </>
  );
}
