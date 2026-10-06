"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { MailX, MoreHorizontal, Send, UserMinus } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataTable, DataTableColumnHeader } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { RelativeTime } from "@/components/relative-time";
import { SectionCard } from "@/components/section";
import { StatusBadge } from "@/components/status/status-badge";
import { getStatusMeta } from "@/components/status/statusMeta";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EMPTY_STATES } from "@/config/emptyStates";
import type { MemberRow, PendingManagerInvite } from "@/hooks/api-shapes";
import { useApiErrorToast } from "@/hooks/use-api-error-toast";
import { useCurrentRole } from "@/hooks/use-current-user";
import {
  useMembers,
  useRemoveMember,
  useResendManagerInvite,
  useRevokeManagerInvite,
  useUpdateMemberRole,
} from "@/hooks/use-organisation";
import { formatDateTime, getInitials } from "@/lib/format";
import { InviteManagerDialog } from "./invite-manager-dialog";
import { assignableRoles, canManageMember, compareRoles } from "./member-rules";

/** Settings → Managers: members table (change role, remove), pending invites (resend, revoke), invite dialog. */
export function MembersSettings() {
  const { data, isPending, isError, error, refetch, isRefetching } = useMembers();
  const actorRole = useCurrentRole();
  const roles = useMemo(() => assignableRoles(actorRole), [actorRole]);
  const [removing, setRemoving] = useState<MemberRow | null>(null);
  const removeMember = useRemoveMember();
  const { mutate: changeRole, isPending: changingRole } = useUpdateMemberRole();
  const toastError = useApiErrorToast();

  const columns = useMemo<ColumnDef<MemberRow>[]>(
    () => [
      {
        id: "name",
        accessorFn: (row) => `${row.name} ${row.email}`,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
        sortingFn: (a, b) => a.original.name.localeCompare(b.original.name),
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-3">
            <Avatar className="size-8">
              <AvatarFallback className="bg-primary/10 text-primary text-xs font-semibold">
                {getInitials(row.original.name)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="flex items-center gap-2 truncate font-medium">
                <span className="truncate">{row.original.name}</span>
                {row.original.isCurrentUser ? (
                  <Badge variant="secondary" className="font-normal">
                    You
                  </Badge>
                ) : null}
              </p>
              <p className="text-muted-foreground truncate text-xs">{row.original.email}</p>
            </div>
          </div>
        ),
      },
      {
        accessorKey: "role",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Role" />,
        sortingFn: (a, b) => compareRoles(a.original.role, b.original.role),
        cell: ({ row }) => <StatusBadge kind="role" value={row.original.role} size="sm" />,
      },
      {
        accessorKey: "joinedAt",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Joined" />,
        cell: ({ row }) => (
          <RelativeTime value={row.original.joinedAt} className="text-muted-foreground text-sm" />
        ),
      },
      {
        accessorKey: "lastLoginAt",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Last sign-in" />,
        sortUndefined: "last",
        cell: ({ row }) =>
          row.original.lastLoginAt ? (
            <RelativeTime
              value={row.original.lastLoginAt}
              className="text-muted-foreground text-sm"
            />
          ) : (
            <span className="text-muted-foreground text-sm">Never</span>
          ),
      },
      {
        id: "actions",
        enableSorting: false,
        size: 56,
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => {
          const member = row.original;
          if (!canManageMember(actorRole, member)) return null;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Actions for ${member.name}`}
                >
                  <MoreHorizontal aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
                  Role
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={member.role}
                  onValueChange={(value) => {
                    const role = roles.find((candidate) => candidate === value);
                    if (role === undefined || role === member.role) return;
                    changeRole(
                      { membershipId: member.id, role },
                      {
                        onSuccess: () =>
                          toast.success(
                            `${member.name} is now ${getStatusMeta("role", role).label.toLowerCase()}`,
                          ),
                        onError: (err) => toastError(err, { title: "Couldn't change role" }),
                      },
                    );
                  }}
                >
                  {roles.map((role) => (
                    <DropdownMenuRadioItem key={role} value={role} disabled={changingRole}>
                      {getStatusMeta("role", role).label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(member)}>
                  <UserMinus aria-hidden="true" />
                  Remove from organisation
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [actorRole, roles, toastError, changeRole, changingRole],
  );

  if (isError) {
    return (
      <ErrorState
        title="Couldn't load managers"
        error={error}
        onRetry={() => void refetch()}
        isRetrying={isRefetching}
      />
    );
  }

  const members = data
    ? [...data.members].sort((a, b) => compareRoles(a.role, b.role) || a.name.localeCompare(b.name))
    : undefined;
  const onlyMe = members !== undefined && members.length <= 1;

  return (
    <div className="space-y-6">
      <SectionCard
        title="Managers"
        description="People who can sign in to this dashboard. Employees join from the app and are managed in Employees."
        actions={<InviteManagerDialog roles={roles} />}
        flush
        contentClassName="px-4 py-4 sm:px-6"
      >
        <DataTable
          label="Managers"
          columns={columns}
          data={members}
          isLoading={isPending}
          loadingRows={3}
          getRowId={(row) => row.id}
          searchable={(members?.length ?? 0) > 8}
          searchPlaceholder="Search managers…"
          paginate={(members?.length ?? 0) > 25}
          stickyHeader={false}
        />
        {onlyMe && roles.length > 0 ? (
          <EmptyState
            className="mt-4"
            icon={EMPTY_STATES.members.icon}
            title={EMPTY_STATES.members.title}
            description={EMPTY_STATES.members.description}
            size="sm"
            headingLevel={3}
          />
        ) : null}
      </SectionCard>

      <PendingInvites
        invites={data?.pendingInvites ?? []}
        canManage={roles.length > 0}
        isLoading={isPending}
      />

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={removing ? `Remove ${removing.name}?` : "Remove manager?"}
        description="They'll lose access to this organisation's dashboard immediately. You can invite them again later."
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (!removing) return;
          try {
            await removeMember.mutateAsync(removing.id);
            toast.success(`${removing.name} was removed`);
          } catch (err) {
            toastError(err, { title: "Couldn't remove manager" });
            throw err;
          }
        }}
      />
    </div>
  );
}

function PendingInvites({
  invites,
  canManage,
  isLoading,
}: {
  invites: readonly PendingManagerInvite[];
  canManage: boolean;
  isLoading: boolean;
}) {
  const resend = useResendManagerInvite();
  const revoke = useRevokeManagerInvite();
  const toastError = useApiErrorToast();
  const [revoking, setRevoking] = useState<PendingManagerInvite | null>(null);

  if (isLoading || invites.length === 0) return null;

  return (
    <SectionCard
      title="Pending invitations"
      description="Invitations that haven't been accepted yet. Expired ones can be re-sent."
      flush
      contentClassName="p-0"
    >
      <ul className="divide-y">
        {invites.map((invite) => (
          <li
            key={invite.id}
            className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6"
          >
            <div className="min-w-0 space-y-1">
              <p className="truncate text-sm font-medium">{invite.email}</p>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge kind="role" value={invite.role} size="sm" />
                {invite.status === "EXPIRED" ? (
                  <span className="text-xs font-medium text-amber-800 dark:text-amber-300">
                    Expired {formatDateTime(invite.expiresAt)}. Resend to send a new link.
                  </span>
                ) : (
                  <span className="text-muted-foreground text-xs">
                    Expires {formatDateTime(invite.expiresAt)}
                  </span>
                )}
              </div>
            </div>
            {canManage ? (
              <div className="flex shrink-0 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={resend.isPending}
                  onClick={() =>
                    resend.mutate(invite.id, {
                      onSuccess: () => toast.success(`Invitation re-sent to ${invite.email}`),
                      onError: (err) =>
                        toastError(err, { title: "Couldn't resend the invitation" }),
                    })
                  }
                >
                  <Send aria-hidden="true" />
                  Resend<span className="sr-only"> invitation to {invite.email}</span>
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setRevoking(invite)}>
                  <MailX aria-hidden="true" />
                  Revoke<span className="sr-only"> invitation for {invite.email}</span>
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title="Revoke this invitation?"
        description={revoking ? `The link sent to ${revoking.email} will stop working.` : undefined}
        confirmLabel="Revoke invitation"
        destructive
        onConfirm={async () => {
          if (!revoking) return;
          try {
            await revoke.mutateAsync(revoking.id);
            toast.success("Invitation revoked");
          } catch (err) {
            toastError(err, { title: "Couldn't revoke the invitation" });
            throw err;
          }
        }}
      />
    </SectionCard>
  );
}
