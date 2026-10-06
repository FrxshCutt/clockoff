"use client";

import type { ColumnDef } from "@tanstack/react-table";
import type { Location } from "@workmode/validation/locationsTeams";
import { MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
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
import { EMPTY_STATES } from "@/config/emptyStates";
import { useApiErrorToast } from "@/hooks/use-api-error-toast";
import { usePermission } from "@/hooks/use-current-user";
import { useCurrentOrganisation } from "@/hooks/use-organisation";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AssignScopePolicyPopover } from "./assign-scope-policy-popover";
import { LocationFormSheet } from "./location-form-sheet";
import { LOCATIONS_EMPTY_STATES } from "./locations-copy";
import { compareByName, describeLocationTimezone, locationDeleteWarnings } from "./locations-view-model";
import { useDeleteLocation, useLocationsList } from "./use-locations-teams";
import { usePolicyOptions } from "./use-scope-assignments";

/**
 * Locations tab: table of sites with their time zone, counts and the Work Policy / Break Rules assigned at
 * LOCATION scope (inline "Assign…" controls), plus the add / edit sheet and delete confirmation.
 */
export function LocationsSection() {
  const organisation = useCurrentOrganisation();
  const organisationTimezone = organisation.data?.organisation.timezone;
  const canManage = usePermission("org:manage");
  const canAssign = usePermission("policies:write");
  const locations = useLocationsList();
  const { workPolicies, breakPolicies } = usePolicyOptions({ enabled: canAssign });
  const remove = useDeleteLocation();
  const toastError = useApiErrorToast();
  const [sheet, setSheet] = useState<{ open: boolean; location: Location | null }>({ open: false, location: null });
  const [deleting, setDeleting] = useState<Location | null>(null);

  const columns = useMemo<ColumnDef<Location>[]>(
    () => [
      {
        accessorKey: "name",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
        cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      },
      {
        id: "timezone",
        accessorFn: (row) => row.timezone ?? "",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Time zone" />,
        cell: ({ row }) => {
          const zone = describeLocationTimezone(row.original, organisationTimezone);
          return <span className={cn("text-sm whitespace-nowrap", zone.inherited && "text-muted-foreground")}>{zone.label}</span>;
        },
      },
      {
        accessorKey: "address",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Address" />,
        cell: ({ row }) =>
          row.original.address ? (
            <span className="block max-w-72 truncate text-sm" title={row.original.address}>
              {row.original.address}
            </span>
          ) : (
            <span className="text-muted-foreground text-sm">—</span>
          ),
      },
      {
        accessorKey: "employeeCount",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Employees" />,
        cell: ({ row }) => <span className="text-sm tabular-nums">{formatNumber(row.original.employeeCount)}</span>,
      },
      {
        accessorKey: "teamCount",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Teams" />,
        cell: ({ row }) => <span className="text-sm tabular-nums">{formatNumber(row.original.teamCount)}</span>,
      },
      {
        id: "workPolicy",
        enableSorting: false,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Work Policy" />,
        cell: ({ row }) => (
          <AssignScopePolicyPopover
            kind="policy"
            scopeType="LOCATION"
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
            scopeType="LOCATION"
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
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`Actions for ${row.original.name}`}>
                  <MoreHorizontal aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onSelect={() => setSheet({ open: true, location: row.original })}>
                  <Pencil aria-hidden="true" />
                  Edit location
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(row.original)}>
                  <Trash2 aria-hidden="true" />
                  Delete location
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null,
      },
    ],
    [organisationTimezone, canManage, canAssign, workPolicies, breakPolicies],
  );

  if (locations.isError) {
    return (
      <ErrorState
        title="Couldn't load locations"
        error={locations.error}
        onRetry={() => void locations.refetch()}
        isRetrying={locations.isRefetching}
      />
    );
  }

  const rows = locations.data ? [...locations.data].sort(compareByName) : undefined;
  const addButton = canManage ? (
    <Button type="button" onClick={() => setSheet({ open: true, location: null })}>
      <Plus aria-hidden="true" />
      Add location
    </Button>
  ) : undefined;
  const emptyCopy = canManage ? EMPTY_STATES.locations : LOCATIONS_EMPTY_STATES.locationsReadOnly;
  const deleteWarnings = deleting ? locationDeleteWarnings(deleting) : [];

  return (
    <div className="space-y-4">
      <DataTable
        label="Locations"
        columns={columns}
        data={rows}
        isLoading={locations.isPending}
        loadingRows={3}
        getRowId={(row) => row.id}
        searchable={(rows?.length ?? 0) > 8}
        searchPlaceholder="Search locations…"
        toolbarActions={addButton}
        paginate={(rows?.length ?? 0) > 25}
        initialSorting={[{ id: "name", desc: false }]}
        emptyState={
          <EmptyState
            icon={emptyCopy.icon}
            title={emptyCopy.title}
            description={emptyCopy.description}
            headingLevel={3}
            action={
              canManage ? (
                <Button type="button" onClick={() => setSheet({ open: true, location: null })}>
                  <Plus aria-hidden="true" />
                  {EMPTY_STATES.locations.action.label}
                </Button>
              ) : undefined
            }
          />
        }
      />

      <LocationFormSheet
        open={sheet.open}
        onOpenChange={(open) => setSheet((prev) => ({ ...prev, open }))}
        location={sheet.location}
        organisationTimezone={organisationTimezone ?? "UTC"}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={deleting ? `Delete ${deleting.name}?` : "Delete location?"}
        description={
          <span className="block space-y-2">
            {deleteWarnings.map((warning) => (
              <span key={warning} className="block">
                {warning}
              </span>
            ))}
            <span className="block">Shifts already scheduled here keep their times. This can&apos;t be undone.</span>
          </span>
        }
        confirmLabel="Delete location"
        destructive
        confirmationText={deleteWarnings.length > 0 && deleting ? deleting.name : undefined}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await remove.mutateAsync(deleting.id);
            toast.success(`${deleting.name} deleted`);
          } catch (error) {
            toastError(error, { title: "Couldn't delete the location" });
            throw error;
          }
        }}
      />
    </div>
  );
}
