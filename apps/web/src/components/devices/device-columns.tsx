"use client";

import type { DeviceWithEmployee } from "@workmode/validation/devices";
import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { DataTableColumnHeader } from "@/components/data-table";
import { PERMISSION_STATE_GUIDANCE, SELECTION_STATE_GUIDANCE } from "@/components/employees/employee-view-model";
import { RelativeTime } from "@/components/relative-time";
import { StatusBadge } from "@/components/status/status-badge";
import { routeFor } from "@/config/navigation";
import { describeAppVersion, describeOs, describeSelectionCounts } from "./device-model";
import { TonedBadge } from "./toned-badge";

/** Column definitions for `/devices` (§12 operational fields only). Server-paginated, so no column sorting. */
export function deviceColumns(): ColumnDef<DeviceWithEmployee>[] {
  return [
    {
      id: "employee",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Employee" />,
      enableSorting: false,
      cell: ({ row }) => {
        const employee = row.original.employee;
        return (
          <div className="min-w-0">
            <Link
              href={routeFor.employee(employee.id)}
              className="focus-visible:ring-ring/50 block truncate rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2"
            >
              {`${employee.firstName} ${employee.lastName}`.trim()}
            </Link>
            <p className="text-muted-foreground truncate text-xs">
              {[employee.jobTitle, employee.primaryLocation?.name].filter(Boolean).join(" · ") || "—"}
            </p>
          </div>
        );
      },
    },
    {
      id: "model",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Model" />,
      enableSorting: false,
      cell: ({ row }) => <span className="text-sm">{row.original.device.deviceModel ?? "—"}</span>,
    },
    {
      id: "versions",
      header: ({ column }) => <DataTableColumnHeader column={column} title="App / OS" />,
      enableSorting: false,
      cell: ({ row }) => (
        <span className="text-sm tabular-nums">
          {describeAppVersion(row.original.device)} · {describeOs(row.original.device)}
        </span>
      ),
    },
    {
      id: "permission",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Permission" />,
      enableSorting: false,
      cell: ({ row }) => {
        const meta = PERMISSION_STATE_GUIDANCE[row.original.device.permissionState];
        return (
          <TonedBadge tone={meta.tone} size="sm" description={meta.guidance}>
            {meta.label}
          </TonedBadge>
        );
      },
    },
    {
      id: "selection",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Selection" />,
      enableSorting: false,
      cell: ({ row }) => {
        const device = row.original.device;
        const meta = SELECTION_STATE_GUIDANCE[device.selectionState];
        return (
          <div className="space-y-1">
            <TonedBadge tone={meta.tone} size="sm" description={meta.guidance}>
              {meta.label}
            </TonedBadge>
            <p className="text-muted-foreground text-xs">{describeSelectionCounts(device.selectionCounts)}</p>
          </div>
        );
      },
    },
    {
      id: "engine",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Engine state" />,
      enableSorting: false,
      cell: ({ row }) => <StatusBadge kind="workModeState" value={row.original.device.restrictionEngineState} size="sm" />,
    },
    {
      id: "lastSync",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Last sync" />,
      enableSorting: false,
      cell: ({ row }) => <RelativeTime value={row.original.device.lastDeviceSyncAt} fallback="Never" className="text-sm" />,
    },
    {
      id: "active",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Active" />,
      enableSorting: false,
      size: 120,
      cell: ({ row }) =>
        row.original.device.isActive ? (
          <TonedBadge tone="success" size="sm" description="The phone syncs and enforces Work Mode.">
            Active
          </TonedBadge>
        ) : (
          <TonedBadge tone="neutral" size="sm" description="Deactivated: the phone no longer syncs and must join again.">
            Deactivated
          </TonedBadge>
        ),
    },
  ];
}
