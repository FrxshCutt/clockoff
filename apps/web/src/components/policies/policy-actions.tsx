"use client";

import type { Policy } from "@workmode/validation/policies";
import { Archive, Copy, MoreHorizontal, Pencil, Star, StarOff, Trash2 } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { InlineAlert } from "@/components/inline-alert";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { routeFor } from "@/config/navigation";
import { useApiErrorToast } from "@/hooks/use-api-error-toast";
import { getErrorMessage } from "@/lib/errorMessages";
import { AssignmentList } from "./assignments-panel";
import { archiveGuard, canDelete, setDefaultGuard } from "./policy-view-model";
import {
  useArchivePolicy,
  useDeletePolicy,
  useDuplicatePolicy,
  usePolicyAssignments,
  useRemovePolicyAssignment,
  useSetDefaultPolicy,
} from "./use-policies";

export type PolicyActionKind = "duplicate" | "archive" | "delete";

export interface PolicyActionRequest {
  kind: PolicyActionKind;
  policy: Policy;
}

/** Holds which dialog is open for which policy; shared by the list and the detail page. */
export function usePolicyActionState() {
  const [request, setRequest] = useState<PolicyActionRequest | null>(null);
  return {
    request,
    open: (kind: PolicyActionKind, policy: Policy) => setRequest({ kind, policy }),
    close: () => setRequest(null),
  };
}

/** Set / clear the organisation default with toasts. */
export function useToggleDefaultPolicy() {
  const setDefault = useSetDefaultPolicy();
  const toastError = useApiErrorToast();
  return {
    isPending: setDefault.isPending,
    toggle: async (policy: Policy) => {
      try {
        if (policy.isDefault) {
          await setDefault.mutateAsync({ policyId: null });
          toast.success(`${policy.name} is no longer the organisation default`);
        } else {
          await setDefault.mutateAsync({ policyId: policy.id });
          toast.success(`${policy.name} is now the organisation default`);
        }
      } catch (err) {
        toastError(err, { title: "Couldn't change the default policy" });
      }
    },
  };
}

export interface PolicyMenuProps {
  policy: Policy;
  canEdit: boolean;
  onAction: (kind: PolicyActionKind, policy: Policy) => void;
  onToggleDefault: (policy: Policy) => void;
  /** Hide the "Edit" entry (on the detail page the whole page is the editor). */
  hideEdit?: boolean;
  defaultPending?: boolean;
  align?: "start" | "end";
}

/** Card / header menu: edit, duplicate, set as default, archive, delete. */
export function PolicyMenu({ policy, canEdit, onAction, onToggleDefault, hideEdit = false, defaultPending = false, align = "end" }: PolicyMenuProps) {
  const defaultGuard = setDefaultGuard(policy);
  const archived = policy.status === "ARCHIVED";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={`Actions for ${policy.name}`}>
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-60">
        {hideEdit ? null : (
          <DropdownMenuItem asChild>
            <Link href={routeFor.policy(policy.id)}>
              <Pencil aria-hidden="true" />
              {canEdit && !archived ? "Edit" : "View"}
            </Link>
          </DropdownMenuItem>
        )}
        {canEdit ? (
          <>
            <DropdownMenuItem onSelect={() => onAction("duplicate", policy)}>
              <Copy aria-hidden="true" />
              Duplicate
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
                  {defaultGuard.ok ? null : <span className="text-muted-foreground text-xs">{defaultGuard.reason}</span>}
                </span>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onAction("archive", policy)} disabled={archived}>
              <Archive aria-hidden="true" />
              {archived ? "Archived" : "Archive"}
            </DropdownMenuItem>
            {canDelete(policy) ? (
              <DropdownMenuItem variant="destructive" onSelect={() => onAction("delete", policy)}>
                <Trash2 aria-hidden="true" />
                Delete
              </DropdownMenuItem>
            ) : null}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface PolicyActionDialogsProps {
  request: PolicyActionRequest | null;
  onClose: () => void;
  /** Called with the new policy after a duplicate succeeds (e.g. to navigate to it). */
  onDuplicated?: (policy: Policy) => void;
  /** Called after an archive or delete succeeds (e.g. to leave the detail page). */
  onRemoved?: (policy: Policy, kind: "archive" | "delete") => void;
}

/** The dialogs behind `PolicyMenu`: duplicate (name prompt), archive (guarded) and delete (confirm). */
export function PolicyActionDialogs({ request, onClose, onDuplicated, onRemoved }: PolicyActionDialogsProps) {
  return (
    <>
      <DuplicatePolicyDialog
        policy={request?.kind === "duplicate" ? request.policy : null}
        onClose={onClose}
        onDuplicated={onDuplicated}
      />
      <ArchivePolicyDialog
        policy={request?.kind === "archive" ? request.policy : null}
        onClose={onClose}
        onArchived={(policy) => onRemoved?.(policy, "archive")}
      />
      <DeletePolicyDialog
        policy={request?.kind === "delete" ? request.policy : null}
        onClose={onClose}
        onDeleted={(policy) => onRemoved?.(policy, "delete")}
      />
    </>
  );
}

function DuplicatePolicyDialog({ policy, onClose, onDuplicated }: { policy: Policy | null; onClose: () => void; onDuplicated?: (policy: Policy) => void }) {
  const duplicate = useDuplicatePolicy();
  const [name, setName] = useState<string | null>(null);
  const inputId = useId();
  const value = name ?? (policy ? `${policy.name} (copy)` : "");

  const close = () => {
    if (duplicate.isPending) return;
    setName(null);
    duplicate.reset();
    onClose();
  };

  const submit = async () => {
    if (!policy) return;
    const trimmed = value.trim();
    try {
      const created = await duplicate.mutateAsync({ id: policy.id, input: trimmed === "" ? {} : { name: trimmed.slice(0, 120) } });
      toast.success(`Created "${created.name}" as a draft`);
      setName(null);
      onClose();
      onDuplicated?.(created);
    } catch {
      // The error is shown inline below.
    }
  };

  return (
    <Dialog open={policy !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Duplicate policy</DialogTitle>
          <DialogDescription>
            Copies the configuration of <span className="font-medium">{policy?.name}</span> into a new draft. Assignments are not copied.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          className="space-y-4"
        >
          {duplicate.error ? (
            <InlineAlert variant="danger" title="Couldn't duplicate">
              {getErrorMessage(duplicate.error)}
            </InlineAlert>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor={inputId}>Name</Label>
            <Input id={inputId} value={value} maxLength={120} onChange={(event) => setName(event.target.value)} autoFocus disabled={duplicate.isPending} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close} disabled={duplicate.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={duplicate.isPending || value.trim() === ""} aria-busy={duplicate.isPending || undefined}>
              <Copy aria-hidden="true" />
              Duplicate
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ArchivePolicyDialog({ policy, onClose, onArchived }: { policy: Policy | null; onClose: () => void; onArchived?: (policy: Policy) => void }) {
  const archive = useArchivePolicy();
  const remove = useRemovePolicyAssignment();
  const toastError = useApiErrorToast();
  const guard = policy ? archiveGuard(policy) : { blocked: false as const };
  const assignments = usePolicyAssignments(policy?.id ?? null, { enabled: policy !== null && guard.blocked });
  const [removingId, setRemovingId] = useState<string | null>(null);

  if (!policy) return null;

  if (!guard.blocked) {
    return (
      <ConfirmDialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title={`Archive ${policy.name}?`}
        description="Archived policies can't be assigned or edited. Nothing is assigned to this one, so no employee's phone changes."
        confirmLabel="Archive"
        onConfirm={async () => {
          try {
            await archive.mutateAsync(policy.id);
            toast.success(`${policy.name} archived`);
            onClose();
            onArchived?.(policy);
          } catch (err) {
            toastError(err, { title: "Couldn't archive the policy" });
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
          <DialogTitle>Reassign before archiving</DialogTitle>
          <DialogDescription>
            Archiving <span className="font-medium">{policy.name}</span> would silently move the people below to the next policy in the
            hierarchy. Point them at another policy first.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {guard.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          {policy.assignmentCount > 0 ? (
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
                    remove.mutate(
                      { assignmentId: assignment.id, policyId: policy.id },
                      {
                        onSuccess: () => toast.success("Assignment removed"),
                        onError: (err) => toastError(err, { title: "Couldn't remove the assignment" }),
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
              ? "Choose another published policy as the organisation default from its menu, then come back to archive this one."
              : "Once nothing points at this policy, Archive becomes available from its menu."}
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

function DeletePolicyDialog({ policy, onClose, onDeleted }: { policy: Policy | null; onClose: () => void; onDeleted?: (policy: Policy) => void }) {
  const remove = useDeletePolicy();
  const toastError = useApiErrorToast();
  if (!policy) return null;
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Delete ${policy.name}?`}
      description="This permanently removes the policy and its version history. Nothing is assigned to it, so no employee's phone changes."
      confirmLabel="Delete policy"
      destructive
      onConfirm={async () => {
        try {
          await remove.mutateAsync(policy.id);
          toast.success(`${policy.name} deleted`);
          onClose();
          onDeleted?.(policy);
        } catch (err) {
          toastError(err, { title: "Couldn't delete the policy" });
          throw err;
        }
      }}
    />
  );
}
