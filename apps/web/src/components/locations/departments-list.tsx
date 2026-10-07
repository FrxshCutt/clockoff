"use client";

import type { ColumnDef } from "@tanstack/react-table";
import type { Department } from "@clockoff/validation/locationsTeams";
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
import { useApiErrorToast } from "@/hooks/use-api-error-toast";
import { usePermission } from "@/hooks/use-current-user";
import { formatNumber } from "@/lib/format";
import { DepartmentDialog } from "./department-dialog";
import { LOCATIONS_EMPTY_STATES } from "./locations-copy";
import { compareByName, departmentDeleteWarnings } from "./locations-view-model";
import { useDeleteDepartment, useDepartmentsList } from "./use-locations-teams";

/** Departments tab: a simple CRUD list (`/api/departments`). */
export function DepartmentsSection() {
  // Organisation structure is edited by owners and admins only (`org:manage`), as the API enforces.
  const canManage = usePermission("org:manage");
  const departments = useDepartmentsList();
  const remove = useDeleteDepartment();
  const toastError = useApiErrorToast();
  const [dialog, setDialog] = useState<{ open: boolean; department: Department | null }>({
    open: false,
    department: null,
  });
  const [deleting, setDeleting] = useState<Department | null>(null);

  const columns = useMemo<ColumnDef<Department>[]>(
    () => [
      {
        accessorKey: "name",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
        cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      },
      {
        accessorKey: "employeeCount",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Employees" />,
        cell: ({ row }) => (
          <span className="text-sm tabular-nums">{formatNumber(row.original.employeeCount)}</span>
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
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem
                  onSelect={() => setDialog({ open: true, department: row.original })}
                >
                  <Pencil aria-hidden="true" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(row.original)}>
                  <Trash2 aria-hidden="true" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null,
      },
    ],
    [canManage],
  );

  if (departments.isError) {
    return (
      <ErrorState
        title="Couldn't load departments"
        error={departments.error}
        onRetry={() => void departments.refetch()}
        isRetrying={departments.isRefetching}
      />
    );
  }

  const rows = departments.data ? [...departments.data].sort(compareByName) : undefined;
  const copy = LOCATIONS_EMPTY_STATES.departments;
  const addButton = canManage ? (
    <Button type="button" onClick={() => setDialog({ open: true, department: null })}>
      <Plus aria-hidden="true" />
      {copy.action.label}
    </Button>
  ) : undefined;
  const warnings = deleting ? departmentDeleteWarnings(deleting) : [];

  return (
    <div className="space-y-4">
      <DataTable
        label="Departments"
        columns={columns}
        data={rows}
        isLoading={departments.isPending}
        loadingRows={3}
        getRowId={(row) => row.id}
        searchable={(rows?.length ?? 0) > 8}
        searchPlaceholder="Search departments…"
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
                : "You don't have permission to add departments. Ask an owner or admin."
            }
            headingLevel={3}
            action={addButton}
          />
        }
      />

      <DepartmentDialog
        open={dialog.open}
        onOpenChange={(open) => setDialog((prev) => ({ ...prev, open }))}
        department={dialog.department}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={deleting ? `Delete ${deleting.name}?` : "Delete department?"}
        description={
          warnings.length > 0
            ? warnings.join(" ")
            : "This department has no employees. This can't be undone."
        }
        confirmLabel="Delete department"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await remove.mutateAsync(deleting.id);
            toast.success(`${deleting.name} deleted`);
          } catch (error) {
            toastError(error, { title: "Couldn't delete the department" });
            throw error;
          }
        }}
      />
    </div>
  );
}
