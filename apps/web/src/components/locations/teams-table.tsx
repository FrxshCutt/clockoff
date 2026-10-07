"use client";

import type { ColumnDef } from "@tanstack/react-table";
import type { Team } from "@clockoff/validation/locationsTeams";
import { MoreHorizontal, Pencil, Plus, Trash2, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataTable, DataTableColumnHeader } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useApiErrorToast } from "@/hooks/use-api-error-toast";
import { usePermission } from "@/hooks/use-current-user";
import { formatNumber } from "@/lib/format";
import { AssignScopePolicyPopover } from "./assign-scope-policy-popover";
import { LOCATIONS_EMPTY_STATES } from "./locations-copy";
import { compareByName, teamDeleteWarnings } from "./locations-view-model";
import { TeamFormSheet } from "./team-form-sheet";
import { TeamMembersDialog } from "./team-members-dialog";
import { useDeleteTeam, useTeamsList } from "./use-locations-teams";
import { usePolicyOptions } from "./use-scope-assignments";

/**
 * Teams tab: table of teams with location, member count (opens the members dialog) and the Work Policy /
 * Break Rules assigned at TEAM scope, plus the add / edit sheet and delete confirmation.
 */
export function TeamsSection() {
  // Teams and their membership are organisation structure, which the API lets every role with
  // Organisation structure is edited by owners and admins only (`org:manage`); policy assignment needs `policies:write`.
  const canManage = usePermission("org:manage");
  const canAssign = usePermission("policies:write");
  const teams = useTeamsList();
  const { workPolicies, breakPolicies } = usePolicyOptions({ enabled: canAssign });
  const remove = useDeleteTeam();
  const toastError = useApiErrorToast();
  const [sheet, setSheet] = useState<{ open: boolean; team: Team | null }>({
    open: false,
    team: null,
  });
  const [members, setMembers] = useState<{ open: boolean; team: Team | null }>({
    open: false,
    team: null,
  });
  const [deleting, setDeleting] = useState<Team | null>(null);

  const columns = useMemo<ColumnDef<Team>[]>(
    () => [
      {
        accessorKey: "name",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
        cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      },
      {
        id: "location",
        accessorFn: (row) => row.location?.name ?? "",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Location" />,
        cell: ({ row }) =>
          row.original.location ? (
            <span className="text-sm">{row.original.location.name}</span>
          ) : (
            <span className="text-muted-foreground text-sm">No location</span>
          ),
      },
      {
        accessorKey: "memberCount",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Members" />,
        cell: ({ row }) => (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2.5 h-8 gap-1.5 px-2.5 font-normal tabular-nums"
            aria-label={`${formatNumber(row.original.memberCount)} members of ${row.original.name}. ${canManage ? "Manage members" : "View members"}`}
            onClick={() => setMembers({ open: true, team: row.original })}
          >
            <Users className="text-muted-foreground size-3.5" aria-hidden="true" />
            {formatNumber(row.original.memberCount)}
          </Button>
        ),
      },
      {
        id: "workPolicy",
        enableSorting: false,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Work Policy" />,
        cell: ({ row }) => (
          <AssignScopePolicyPopover
            kind="policy"
            scopeType="TEAM"
            scope={row.original}
            assignment={row.original.policyAssignment}
            choices={workPolicies}
            canEdit={canAssign}
          />
        ),
      },
      {
        id: "breakPolicy",
        enableSorting: false,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Break Rules" />,
        cell: ({ row }) => (
          <AssignScopePolicyPopover
            kind="breakPolicy"
            scopeType="TEAM"
            scope={row.original}
            assignment={row.original.breakPolicyAssignment}
            choices={breakPolicies}
            canEdit={canAssign}
          />
        ),
      },
      {
        id: "actions",
        enableSorting: false,
        size: 56,
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) =>
          canManage ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Actions for ${row.original.name}`}
                >
                  <MoreHorizontal aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onSelect={() => setMembers({ open: true, team: row.original })}>
                  <Users aria-hidden="true" />
                  Manage members
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setSheet({ open: true, team: row.original })}>
                  <Pencil aria-hidden="true" />
                  Edit team
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(row.original)}>
                  <Trash2 aria-hidden="true" />
                  Delete team
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null,
      },
    ],
    [canManage, canAssign, workPolicies, breakPolicies],
  );

  if (teams.isError) {
    return (
      <ErrorState
        title="Couldn't load teams"
        error={teams.error}
        onRetry={() => void teams.refetch()}
        isRetrying={teams.isRefetching}
      />
    );
  }

  const rows = teams.data ? [...teams.data].sort(compareByName) : undefined;
  const copy = LOCATIONS_EMPTY_STATES.teams;
  const addButton = canManage ? (
    <Button type="button" onClick={() => setSheet({ open: true, team: null })}>
      <Plus aria-hidden="true" />
      {copy.action.label}
    </Button>
  ) : undefined;
  const warnings = deleting ? teamDeleteWarnings(deleting) : [];

  return (
    <div className="space-y-4">
      <DataTable
        label="Teams"
        columns={columns}
        data={rows}
        isLoading={teams.isPending}
        loadingRows={3}
        getRowId={(row) => row.id}
        searchable={(rows?.length ?? 0) > 8}
        searchPlaceholder="Search teams…"
        toolbarActions={addButton}
        paginate={(rows?.length ?? 0) > 25}
        initialSorting={[{ id: "name", desc: false }]}
        emptyState={
          <EmptyState
            icon={copy.icon}
            title={copy.title}
            description={
              canManage
                ? copy.description
                : "You don't have permission to add teams. Ask an owner or admin."
            }
            headingLevel={3}
            action={addButton}
          />
        }
      />

      <TeamFormSheet
        open={sheet.open}
        onOpenChange={(open) => setSheet((prev) => ({ ...prev, open }))}
        team={sheet.team}
        onSaved={(team, mode) => {
          if (mode === "create") setMembers({ open: true, team });
        }}
      />
      <TeamMembersDialog
        team={members.team}
        open={members.open}
        onOpenChange={(open) => setMembers((prev) => ({ ...prev, open }))}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={deleting ? `Delete ${deleting.name}?` : "Delete team?"}
        description={
          warnings.length > 0
            ? `${warnings.join(" ")} This can't be undone.`
            : "This team has no members. This can't be undone."
        }
        confirmLabel="Delete team"
        destructive
        confirmationText={warnings.length > 0 && deleting ? deleting.name : undefined}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await remove.mutateAsync(deleting.id);
            toast.success(`${deleting.name} deleted`);
          } catch (error) {
            toastError(error, { title: "Couldn't delete the team" });
            throw error;
          }
        }}
      />
    </div>
  );
}
