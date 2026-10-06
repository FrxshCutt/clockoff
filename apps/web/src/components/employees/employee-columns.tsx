"use client";

import type { DateFormat } from "@workmode/shared/enums";
import type { Employee } from "@workmode/validation/employees";
import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { createSelectColumn, DataTableColumnHeader } from "@/components/data-table";
import { RelativeTime } from "@/components/relative-time";
import { StatusBadge } from "@/components/status/status-badge";
import { routeFor } from "@/config/navigation";
import { EmployeeRowActionsMenu } from "./employee-row-actions";
import type { EmployeeDialogAction } from "./employee-action-dialogs";
import { DeviceStatusBadge } from "./employee-status-badges";
import { describeNextShift, describeResolvedFrom, employeeFullName } from "./employee-view-model";

export interface EmployeeColumnOptions {
  /** Organisation zone for absolute times in tooltips. */
  timeZone: string | undefined;
  dateFormat: DateFormat | undefined;
  /** Epoch ms used to describe the next shift ("Today", "In progress"); null before hydration. */
  now: number | null;
  canWrite: boolean;
  onAction: (action: EmployeeDialogAction, employee: Employee) => void;
}

/** Column ids referenced by the URL ⇄ sort mapping in `employee-filters.ts` (`SORTABLE_COLUMNS`). */
export const EMPLOYEE_COLUMN_IDS = {
  select: "select",
  name: "name",
  location: "location",
  inviteStatus: "inviteStatus",
  deviceStatus: "deviceStatus",
  policy: "policy",
  nextShift: "nextShift",
  lastSyncAt: "lastSyncAt",
  actions: "actions",
} as const;

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground text-sm">{children}</span>;
}

/** Column definitions for the employees DataTable (server-side sorting: only `enableSorting` columns map to the API). */
export function buildEmployeeColumns(options: EmployeeColumnOptions): ColumnDef<Employee>[] {
  const { timeZone, dateFormat, now, canWrite, onAction } = options;
  const columns: ColumnDef<Employee>[] = [];

  if (canWrite) columns.push(createSelectColumn<Employee>({ getRowLabel: employeeFullName }));

  columns.push(
    {
      id: EMPLOYEE_COLUMN_IDS.name,
      accessorFn: employeeFullName,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
      enableSorting: true,
      cell: ({ row }) => {
        const employee = row.original;
        return (
          <div className="min-w-0 space-y-0.5">
            <Link
              href={routeFor.employee(employee.id)}
              className="text-foreground focus-visible:ring-ring/50 block truncate rounded-sm font-medium outline-none hover:underline focus-visible:ring-[3px]"
            >
              {employeeFullName(employee)}
            </Link>
            <p className="text-muted-foreground truncate text-xs">
              {[
                employee.jobTitle,
                employee.externalEmployeeId ? `ID ${employee.externalEmployeeId}` : null,
              ]
                .filter(Boolean)
                .join(" · ") || "No job title"}
            </p>
          </div>
        );
      },
    },
    {
      id: EMPLOYEE_COLUMN_IDS.location,
      accessorFn: (e) => e.primaryLocation?.name ?? "",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Location" />,
      enableSorting: false,
      cell: ({ row }) => {
        const { primaryLocation, locations } = row.original;
        const extra = locations.filter((l) => l.id !== primaryLocation?.id).length;
        if (!primaryLocation && extra === 0) return <Muted>—</Muted>;
        return (
          <div className="min-w-0 space-y-0.5">
            <p className="truncate text-sm">{primaryLocation?.name ?? "No primary location"}</p>
            {extra > 0 ? (
              <p className="text-muted-foreground text-xs">
                +{extra} more {extra === 1 ? "location" : "locations"}
              </p>
            ) : null}
          </div>
        );
      },
    },
    {
      id: EMPLOYEE_COLUMN_IDS.inviteStatus,
      accessorKey: "inviteStatus",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Invite" />,
      enableSorting: true,
      cell: ({ row }) => (
        <StatusBadge kind="inviteStatus" value={row.original.inviteStatus} size="sm" />
      ),
    },
    {
      id: EMPLOYEE_COLUMN_IDS.deviceStatus,
      accessorFn: (e) => e.deviceStatus?.badge ?? "",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Device" />,
      enableSorting: false,
      cell: ({ row }) => (
        <DeviceStatusBadge status={row.original.deviceStatus} size="sm" timeZone={timeZone} />
      ),
    },
    {
      id: EMPLOYEE_COLUMN_IDS.policy,
      accessorFn: (e) => e.resolvedPolicy?.name ?? "",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Policy" />,
      enableSorting: false,
      cell: ({ row }) => {
        const employee = row.original;
        const resolved = employee.resolvedPolicy;
        if (!resolved) return <Muted>No policy</Muted>;
        const from = describeResolvedFrom(resolved, employee);
        return (
          <div className="min-w-0 space-y-0.5">
            <Link
              href={routeFor.policy(resolved.id)}
              className="focus-visible:ring-ring/50 block truncate rounded-sm text-sm outline-none hover:underline focus-visible:ring-[3px]"
            >
              {resolved.name}
            </Link>
            {from ? (
              <p className="text-muted-foreground truncate text-xs">{from.subtitle}</p>
            ) : null}
          </div>
        );
      },
    },
    {
      id: EMPLOYEE_COLUMN_IDS.nextShift,
      accessorFn: (e) => e.nextShift?.startsAt ?? "",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Next shift" />,
      enableSorting: false,
      cell: ({ row }) => {
        const shift = row.original.nextShift;
        const description = now === null ? null : describeNextShift(shift, now, { dateFormat });
        if (!shift) return <Muted>None scheduled</Muted>;
        if (!description) return <Muted>…</Muted>;
        return (
          <div className="space-y-0.5">
            <p className="text-sm">{description.primary}</p>
            <p className="text-muted-foreground text-xs tabular-nums">
              {description.range}
              {shift.location ? ` · ${shift.location.name}` : ""}
            </p>
          </div>
        );
      },
    },
    {
      id: EMPLOYEE_COLUMN_IDS.lastSyncAt,
      accessorKey: "lastSyncAt",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Last sync" />,
      enableSorting: true,
      cell: ({ row }) =>
        row.original.lastSyncAt ? (
          <RelativeTime value={row.original.lastSyncAt} timeZone={timeZone} className="text-sm" />
        ) : (
          <Muted>Never</Muted>
        ),
    },
    {
      id: EMPLOYEE_COLUMN_IDS.actions,
      size: 56,
      enableSorting: false,
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => (
        <div className="flex justify-end">
          <EmployeeRowActionsMenu employee={row.original} canWrite={canWrite} onAction={onAction} />
        </div>
      ),
    },
  );

  return columns;
}
