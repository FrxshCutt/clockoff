"use client";

import type { EmployeeDetail } from "@clockoff/validation/employees";
import type { EmployeeInvite, InviteInstructions } from "@clockoff/validation/invites";
import { Ban, ClipboardList, Send } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton } from "@/components/copy-button";
import { EmptyState } from "@/components/empty-state";
import { InlineAlert } from "@/components/inline-alert";
import { CreateInviteDialog } from "@/components/invites/create-invite-dialog";
import {
  INVITE_CHANNEL_META,
  canInviteEmployee,
  canResendInvite,
  canRevokeInvite,
  canShowInstructions,
  inviteActionLabel,
  inviteEffectiveStatus,
} from "@/components/invites/invite-helpers";
import { InviteInstructionsModal } from "@/components/invites/invite-instructions-modal";
import { SectionCard } from "@/components/section";
import { StatusBadge } from "@/components/status/status-badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { usePermission } from "@/hooks/use-current-user";
import { useApiErrorToast } from "@/hooks/use-api-error-toast";
import { useCurrentOrganisation } from "@/hooks/use-organisation";
import { formatDateTime } from "@/lib/format";
import { useResendInvite, useRevokeInvite } from "./employee-api";
import { EMPLOYEE_EMPTY_STATES } from "./employee-copy";
import { employeeFullName } from "./employee-view-model";
import { useNow } from "./use-now";

export interface EmployeeInvitesTabProps {
  employee: EmployeeDetail;
}

/**
 * The employee's invite (`EmployeeDetail.latestInvite`) with its code, channel, status and lifecycle actions.
 * The API exposes the most recent invite only: creating or re-sending issues a new code and cancels the old one.
 */
export function EmployeeInvitesTab({ employee }: EmployeeInvitesTabProps) {
  const canWrite = usePermission("employees:write");
  const now = useNow();
  const organisation = useCurrentOrganisation();
  const timeZone = organisation.data?.organisation.timezone;
  const dateFormat = organisation.data?.organisation.dateFormat;
  const resend = useResendInvite();
  const revoke = useRevokeInvite();
  const toastError = useApiErrorToast();

  const [createOpen, setCreateOpen] = useState(false);
  const [instructions, setInstructions] = useState<InviteInstructions | null>(null);
  const [instructionsFor, setInstructionsFor] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    kind: "resend" | "revoke";
    invite: EmployeeInvite;
  } | null>(null);

  const invite = employee.latestInvite;
  const name = employeeFullName(employee);
  const inviteLabel = inviteActionLabel(employee.inviteStatus);
  const canCreate = canWrite && canInviteEmployee(employee);
  const joined =
    employee.inviteStatus === "JOINED" ||
    employee.inviteStatus === "SETUP_INCOMPLETE" ||
    employee.inviteStatus === "CONNECTED";
  const reference = now ?? undefined;

  const createButton = canCreate ? (
    <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
      <Send aria-hidden="true" />
      {inviteLabel === "Resend invite" ? "New invite" : "Create invite"}
    </Button>
  ) : null;

  const fmt = (value: string | null) =>
    value ? formatDateTime(value, { timeZone, dateFormat }) : "—";

  return (
    <>
      <SectionCard
        title="Invites"
        description="The employee enters your company code and their personal code in the ClockOff app. A new invite replaces the previous code."
        actions={createButton}
        flush
      >
        <div className="space-y-4 px-5 py-5 sm:px-6">
          {joined ? (
            <InlineAlert variant="success" title="This employee has joined">
              Their phone is linked to this record, so no further invite is needed. Deactivating and
              reactivating them starts the join flow again.
            </InlineAlert>
          ) : null}
          {employee.employmentStatus === "INACTIVE" ? (
            <InlineAlert variant="warning" title="Inactive employee">
              Reactivate the employee before inviting them.
            </InlineAlert>
          ) : null}

          {!invite ? (
            <EmptyState
              icon={EMPLOYEE_EMPTY_STATES.invites.icon}
              title={EMPLOYEE_EMPTY_STATES.invites.title}
              description={EMPLOYEE_EMPTY_STATES.invites.description}
              size="sm"
              headingLevel={3}
              action={createButton ?? undefined}
            />
          ) : (
            <div className="overflow-hidden rounded-xl border">
              <Table>
                <TableCaption className="sr-only">Invites for {name}</TableCaption>
                <TableHeader className="bg-muted/60">
                  <TableRow className="hover:bg-transparent">
                    <TableHead scope="col" className="px-4">
                      Code
                    </TableHead>
                    <TableHead scope="col" className="px-4">
                      Channel
                    </TableHead>
                    <TableHead scope="col" className="px-4">
                      Status
                    </TableHead>
                    <TableHead scope="col" className="px-4">
                      Sent
                    </TableHead>
                    <TableHead scope="col" className="px-4">
                      Accepted
                    </TableHead>
                    <TableHead scope="col" className="px-4">
                      Expires
                    </TableHead>
                    <TableHead scope="col" className="px-4 text-right">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell className="px-4">
                      <span className="inline-flex items-center gap-2">
                        <code className="font-mono text-sm font-semibold tracking-[0.15em]">
                          {invite.code}
                        </code>
                        <CopyButton
                          value={invite.code}
                          label="Copy employee code"
                          successMessage="Employee code copied"
                          size="icon-xs"
                          variant="ghost"
                        />
                      </span>
                    </TableCell>
                    <TableCell className="px-4 text-sm">
                      {INVITE_CHANNEL_META[invite.channel]?.label ?? invite.channel}
                    </TableCell>
                    <TableCell className="px-4">
                      <StatusBadge
                        kind="employeeInviteStatus"
                        value={inviteEffectiveStatus(invite, reference)}
                        size="sm"
                      />
                    </TableCell>
                    <TableCell className="px-4 text-sm">{fmt(invite.sentAt)}</TableCell>
                    <TableCell className="px-4 text-sm">{fmt(invite.acceptedAt)}</TableCell>
                    <TableCell className="px-4 text-sm">{fmt(invite.expiresAt)}</TableCell>
                    <TableCell className="px-4">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {canShowInstructions(invite, reference) ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setInstructionsFor(invite.id)}
                          >
                            <ClipboardList aria-hidden="true" />
                            Copy instructions
                          </Button>
                        ) : null}
                        {canWrite &&
                        employee.employmentStatus === "ACTIVE" &&
                        !joined &&
                        canResendInvite(invite, reference) ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setConfirm({ kind: "resend", invite })}
                          >
                            <Send aria-hidden="true" />
                            Resend
                          </Button>
                        ) : null}
                        {canWrite && canRevokeInvite(invite, reference) ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setConfirm({ kind: "revoke", invite })}
                          >
                            <Ban aria-hidden="true" />
                            Revoke
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          )}
          <p className="text-muted-foreground text-xs">
            ClockOff keeps the most recent invite for each employee. Re-sending issues a fresh code
            and cancels the previous one.
          </p>
        </div>
      </SectionCard>

      <CreateInviteDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        employee={employee}
        onCreated={(result) => setInstructions(result.instructions)}
      />
      <InviteInstructionsModal
        open={instructions !== null || instructionsFor !== null}
        onOpenChange={(open) => {
          if (!open) {
            setInstructions(null);
            setInstructionsFor(null);
          }
        }}
        instructions={instructions}
        inviteId={instructionsFor}
      />

      <ConfirmDialog
        open={confirm?.kind === "resend"}
        onOpenChange={(open) => (open ? undefined : setConfirm(null))}
        title={`Resend the invite to ${name}?`}
        description={
          confirm?.invite.channel === "EMAIL"
            ? `A new code is issued and emailed to ${employee.email ?? "the employee"}. The previous code stops working.`
            : "A new code is issued and the previous one stops working. Copy the updated instructions afterwards."
        }
        confirmLabel="Resend invite"
        onConfirm={async () => {
          if (!confirm) return;
          try {
            await resend.mutateAsync({ inviteId: confirm.invite.id });
            toast.success(`Invite re-sent to ${name}`);
            setConfirm(null);
          } catch (error) {
            toastError(error, { title: "Couldn't resend the invite" });
            throw error;
          }
        }}
      />
      <ConfirmDialog
        open={confirm?.kind === "revoke"}
        onOpenChange={(open) => (open ? undefined : setConfirm(null))}
        title="Revoke this invite?"
        description="The employee code stops working immediately. You can create a new invite at any time."
        confirmLabel="Revoke invite"
        destructive
        onConfirm={async () => {
          if (!confirm) return;
          try {
            await revoke.mutateAsync({ inviteId: confirm.invite.id });
            toast.success("Invite revoked");
            setConfirm(null);
          } catch (error) {
            toastError(error, { title: "Couldn't revoke the invite" });
            throw error;
          }
        }}
      />
    </>
  );
}
