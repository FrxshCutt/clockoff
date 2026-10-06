"use client";

import type { BreakPolicy } from "@workmode/validation/breakPolicies";
import { Eye, MoreHorizontal, Pencil, Star, StarOff, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useNow } from "@/components/employees/use-now";
import { InlineAlert } from "@/components/inline-alert";
import { AssignmentList } from "@/components/policies/assignments-panel";
import { openAssignments } from "@/components/policies/policy-view-model";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { routeFor } from "@/config/navigation";
import { useApiErrorToast } from "@/hooks/use-api-error-toast";
import { getErrorMessage } from "@/lib/errorMessages";
import { breakPolicyDeleteGuard, breakPolicySetDefaultGuard } from "./break-policy-view-model";
import {
  useBreakPolicyAssignments,
  useDeleteBreakPolicy,
  useRemoveBreakPolicyAssignment,
  useSetDefaultBreakPolicy,
} from "./use-break-policies";

/** Set / clear the organisation default Break Rules with toasts. `toggle` is referentially stable (safe in memo deps). */
export function useToggleDefaultBreakPolicy() {
  const { mutateAsync, isPending } = useSetDefaultBreakPolicy();
  const toastError = useApiErrorToast();
  const toggle = useCallback(
    async (policy: BreakPolicy) => {
      try {
        if (policy.isDefault) {
          await mutateAsync({ breakPolicyId: null });
          toast.success(`${policy.name} are no longer the organisation default`);
        } else {
          await mutateAsync({ breakPolicyId: policy.id });
          toast.success(`${policy.name} are now the organisation default Break Rules`);
        }
      } catch (err) {
        toastError(err, { title: "Couldn't change the default Break Rules" });
      }
    },
    [mutateAsync, toastError],
  );
  return { isPending, toggle };
}

export interface BreakPolicyMenuProps {
  policy: BreakPolicy;
  canEdit: boolean;
  onEdit: (policy: BreakPolicy) => void;
  onDelete: (policy: BreakPolicy) => void;
  onToggleDefault: (policy: BreakPolicy) => void;
  defaultPending?: boolean;
  /** Hide the "View" entry (on the detail page). */
  hideView?: boolean;
  align?: "start" | "end";
}

/** Row / header menu: view, edit, set as default, delete. */
export function BreakPolicyMenu({
  policy,
  canEdit,
  onEdit,
  onDelete,
  onToggleDefault,
  defaultPending = false,
  hideView = false,
  align = "end",
}: BreakPolicyMenuProps) {
  const defaultGuard = breakPolicySetDefaultGuard(policy);
  const archived = policy.status === "ARCHIVED";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Actions for ${policy.name}`}
        >
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-64">
        {hideView ? null : (
          <DropdownMenuItem asChild>
            <Link href={routeFor.breakRule(policy.id)}>
              <Eye aria-hidden="true" />
              View
            </Link>
          </DropdownMenuItem>
        )}
        {canEdit ? (
          <>
            <DropdownMenuItem onSelect={() => onEdit(policy)} disabled={archived}>
              <Pencil aria-hidden="true" />
              Edit
            </DropdownMenuItem>
            {policy.isDefault ? (
              <DropdownMenuItem onSelect={() => onToggleDefault(policy)} disabled={defaultPending}>
                <StarOff aria-hidden="true" />
                Clear organisation default
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                onSelect={() => onToggleDefault(policy)}
                disabled={defaultPending || !defaultGuard.ok}
                title={defaultGuard.ok ? undefined : defaultGuard.reason}
              >
                <Star aria-hidden="true" />
                <span className="flex min-w-0 flex-col">
                  <span>Set as organisation default</span>
                  {defaultGuard.ok ? null : (
                    <span className="text-muted-foreground text-xs">{defaultGuard.reason}</span>
                  )}
                </span>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => onDelete(policy)}>
              <Trash2 aria-hidden="true" />
              Delete
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface DeleteBreakPolicyDialogProps {
  policy: BreakPolicy | null;
  onClose: () => void;
  onDeleted?: (policy: BreakPolicy) => void;
}

/**
 * Delete guard: Break Rules that are the default or still assigned can't be deleted (`POLICY_ASSIGNED`), so
 * the dialog explains why and lists the assignments to remove; otherwise it is a plain confirmation.
 */
export function DeleteBreakPolicyDialog({
  policy,
  onClose,
  onDeleted,
}: DeleteBreakPolicyDialogProps) {
  const remove = useDeleteBreakPolicy();
  const removeAssignment = useRemoveBreakPolicyAssignment();
  const toastError = useApiErrorToast();
  // `policy` is the snapshot the menu was opened with; once the assignments are loaded the guard follows them
  // live, so removing the last one here turns this straight into the delete confirmation.
  const snapshotGuard = policy ? breakPolicyDeleteGuard(policy) : { blocked: false as const };
  const assignments = useBreakPolicyAssignments(policy?.id ?? null, {
    enabled: policy !== null && snapshotGuard.blocked,
  });
  const now = useNow();
  const [removingId, setRemovingId] = useState<string | null>(null);

  if (!policy) return null;

  const openCount =
    assignments.data && now !== null
      ? openAssignments(assignments.data, now).length
      : policy.assignmentCount;
  const guard = breakPolicyDeleteGuard({ isDefault: policy.isDefault, assignmentCount: openCount });

  if (!guard.blocked) {
    return (
      <ConfirmDialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title={`Delete ${policy.name}?`}
        description="Removes these Break Rules from your organisation; this can't be undone. Nothing is assigned to them, so no employee's breaks change."
        confirmLabel="Delete Break Rules"
        destructive
        onConfirm={async () => {
          try {
            await remove.mutateAsync(policy.id);
            toast.success(`${policy.name} deleted`);
            onClose();
            onDeleted?.(policy);
          } catch (err) {
            toastError(err, { title: "Couldn't delete the Break Rules" });
            throw err;
          }
        }}
      />
    );
  }

  const pendingKeys = new Set<string>();
  const removing = removingId ? assignments.data?.find((a) => a.id === removingId) : undefined;
  if (removing) pendingKeys.add(`${removing.scopeType}:${removing.scopeId}`);

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Reassign before deleting</DialogTitle>
          <DialogDescription>
            Deleting <span className="font-medium">{policy.name}</span> would silently move the
            people below to the next Break Rules in the hierarchy. Point them at other Break Rules
            first.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {guard.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          {openCount > 0 ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">Current assignments</p>
              {assignments.isError ? (
                <InlineAlert variant="danger">{getErrorMessage(assignments.error)}</InlineAlert>
              ) : (
                <AssignmentList
                  assignments={assignments.isPending ? undefined : assignments.data}
                  canRemove
                  pendingKeys={pendingKeys}
                  onRemove={(assignment) => {
                    setRemovingId(assignment.id);
                    removeAssignment.mutate(
                      { assignmentId: assignment.id, breakPolicyId: policy.id },
                      {
                        onSuccess: () => toast.success("Assignment removed"),
                        onError: (err) =>
                          toastError(err, { title: "Couldn't remove the assignment" }),
                        onSettled: () => setRemovingId(null),
                      },
                    );
                  }}
                />
              )}
            </div>
          ) : null}
          <InlineAlert variant="info">
            {policy.isDefault
              ? "Choose other Break Rules as the organisation default from their menu, then come back to delete these."
              : "Remove the assignments above, or assign other Break Rules to those scopes. Once nothing points at these Break Rules you can delete them right here."}
          </InlineAlert>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
