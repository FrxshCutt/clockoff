"use client";

import type { ComplianceEmployeeRow } from "@clockoff/validation/compliance";
import type { ColumnDef } from "@tanstack/react-table";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { DataTableColumnHeader } from "@/components/data-table";
import { TonedBadge } from "@/components/devices/toned-badge";
import { PERMISSION_STATE_GUIDANCE } from "@/components/employees/employee-view-model";
import { RelativeTime } from "@/components/relative-time";
import { StatusBadge } from "@/components/status/status-badge";
import { routeFor } from "@/config/navigation";
import { describeAttention, stateAgreement } from "./compliance-model";

/**
 * Column definitions for the Compliance tab; server-sorted/paginated, so no column sorting. `timeZone` (the
 * organisation's) is used for the absolute time in the last-sync tooltip.
 */
export function complianceColumns(timeZone?: string): ColumnDef<ComplianceEmployeeRow>[] {
  return [
    {
      id: "employee",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Employee" />,
      enableSorting: false,
      cell: ({ row }) => {
        const employee = row.original.employee;
        const name = `${employee.firstName} ${employee.lastName}`.trim();
        return (
          <div className="min-w-0">
            <Link
              href={routeFor.employee(employee.id)}
              className="focus-visible:ring-ring/50 block truncate rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2"
            >
              {name}
            </Link>
            <p className="text-muted-foreground truncate text-xs">
              {[employee.jobTitle, employee.primaryLocation?.name].filter(Boolean).join(" · ") ||
                "—"}
            </p>
          </div>
        );
      },
    },
    {
      id: "status",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
      enableSorting: false,
      cell: ({ row }) =>
        row.original.deviceStatus ? (
          <StatusBadge kind="deviceStatus" value={row.original.deviceStatus.badge} size="sm" />
        ) : (
          <StatusBadge kind="inviteStatus" value={row.original.employee.inviteStatus} size="sm" />
        ),
    },
    {
      id: "states",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Expected → reported" />,
      enableSorting: false,
      cell: ({ row }) => {
        const { expectedState, reportedState } = row.original;
        const agreement = stateAgreement(row.original);
        return (
          <div className="flex flex-wrap items-center gap-1.5" data-agreement={agreement}>
            {expectedState ? (
              <StatusBadge kind="workModeState" value={expectedState} size="sm" />
            ) : (
              <span className="text-muted-foreground text-xs">No shift</span>
            )}
            <ArrowRight className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
            <span className="sr-only">then</span>
            {reportedState ? (
              <StatusBadge
                kind="workModeState"
                value={reportedState}
                size="sm"
                className={agreement === "diverged" ? "ring-2 ring-amber-400/60" : undefined}
              />
            ) : (
              <span className="text-muted-foreground text-xs">Not reported</span>
            )}
          </div>
        );
      },
    },
    {
      id: "lastSync",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Last sync" />,
      enableSorting: false,
      cell: ({ row }) => (
        <RelativeTime
          value={row.original.lastSyncAt}
          fallback="Never"
          timeZone={timeZone}
          className="text-sm"
        />
      ),
    },
    {
      id: "permission",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Permission" />,
      enableSorting: false,
      cell: ({ row }) => {
        const state = row.original.permissionState;
        if (!state) return <span className="text-muted-foreground text-xs">No device</span>;
        const meta = PERMISSION_STATE_GUIDANCE[state];
        return (
          <TonedBadge tone={meta.tone} size="sm" description={meta.guidance}>
            {meta.label}
          </TonedBadge>
        );
      },
    },
    {
      id: "attention",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Needs attention" />,
      enableSorting: false,
      cell: ({ row }) => {
        const reason = describeAttention(row.original);
        return reason ? (
          <p className="max-w-xs text-sm text-pretty text-amber-800 dark:text-amber-300">
            {reason}
          </p>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        );
      },
    },
  ];
}
