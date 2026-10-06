"use client";

import type { Shift } from "@workmode/validation/shifts";
import type { ColumnDef } from "@tanstack/react-table";
import type { DateFormat } from "@workmode/shared/enums";
import { CalendarClock, TriangleAlert } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { DataTable, DataTableColumnHeader } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status/status-badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EMPTY_STATES } from "@/config/emptyStates";
import { formatDate, formatDurationMinutes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { describeRecurrenceRule } from "./rrule-builder";
import { findConflicts, formatLocalDay, shiftLocalTimes, shiftTimeLabel } from "./schedule-model";

export interface EmployeeViewProps {
  /** Null until the manager picks an employee. */
  employeeId: string | null;
  shifts: readonly Shift[];
  isLoading: boolean;
  timezone: string;
  dateFormat: DateFormat;
  onOpenShift: (shift: Shift) => void;
  /** Rendered inside the empty state when no employee is chosen (the picker). */
  picker?: ReactNode;
  emptyAction?: ReactNode;
}

/** One employee's shifts for the visible range as a sortable table. */
export function EmployeeView({ employeeId, shifts, isLoading, timezone, dateFormat, onOpenShift, picker, emptyAction }: EmployeeViewProps) {
  const conflicts = useMemo(() => findConflicts(shifts), [shifts]);
  const rows = useMemo(() => [...shifts].sort((a, b) => a.startsAt.localeCompare(b.startsAt)), [shifts]);

  const columns = useMemo<ColumnDef<Shift>[]>(
    () => [
      {
        accessorKey: "startsAt",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Date" />,
        cell: ({ row }) => {
          const times = shiftLocalTimes(row.original, timezone);
          return (
            <div className="min-w-0">
              <p className="font-medium">{formatLocalDay(times.startDate, "medium")}</p>
              <p className="text-muted-foreground text-xs">{formatDate(row.original.startsAt, { timeZone: timezone, dateFormat })}</p>
            </div>
          );
        },
      },
      {
        id: "time",
        enableSorting: false,
        header: () => <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Time</span>,
        cell: ({ row }) => {
          const shift = row.original;
          const times = shiftLocalTimes(shift, timezone);
          const overlapping = conflicts.get(shift.id) ?? [];
          return (
            <span className={cn("flex items-center gap-1.5 tabular-nums", shift.status === "CANCELLED" && "text-muted-foreground line-through")}>
              {shiftTimeLabel(times)}
              {overlapping.length > 0 ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex" aria-label={`Overlaps ${overlapping.length} other ${overlapping.length === 1 ? "shift" : "shifts"}`}>
                      <TriangleAlert className="size-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    Overlaps {overlapping.map((o) => shiftTimeLabel(shiftLocalTimes(o, timezone))).join(", ")}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </span>
          );
        },
      },
      {
        id: "location",
        accessorFn: (row) => row.location?.name ?? "",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Location" />,
        cell: ({ row }) => row.original.location?.name ?? <span className="text-muted-foreground">—</span>,
      },
      {
        accessorKey: "durationMinutes",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Length" />,
        cell: ({ row }) => <span className="tabular-nums">{formatDurationMinutes(row.original.durationMinutes)}</span>,
      },
      {
        id: "breaks",
        enableSorting: false,
        header: () => <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Breaks</span>,
        cell: ({ row }) => {
          const count = row.original.scheduledBreaks.length;
          return count === 0 ? <span className="text-muted-foreground">—</span> : `${count} scheduled`;
        },
      },
      {
        id: "repeat",
        enableSorting: false,
        header: () => <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">Repeats</span>,
        cell: ({ row }) => {
          const shift = row.original;
          const text = describeRecurrenceRule(shift.recurrenceRule);
          if (text) return <span className="text-sm">{text}</span>;
          if (shift.parentRecurrenceId) return <span className="text-muted-foreground text-sm">Part of a series</span>;
          return <span className="text-muted-foreground">—</span>;
        },
      },
      {
        accessorKey: "status",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
        cell: ({ row }) => <StatusBadge kind="shiftStatus" value={row.original.status} size="sm" />,
      },
    ],
    [timezone, dateFormat, conflicts],
  );

  if (!employeeId) {
    return (
      <EmptyState
        icon={CalendarClock}
        title="Choose an employee"
        description="Pick an employee to see their shifts for this range, or switch to the week view to see everyone."
      >
        {picker ? <div className="w-full max-w-sm">{picker}</div> : null}
      </EmptyState>
    );
  }

  return (
    <DataTable
      label="Employee shifts"
      columns={columns}
      data={isLoading ? undefined : rows}
      isLoading={isLoading}
      getRowId={(row) => row.id}
      initialSorting={[{ id: "startsAt", desc: false }]}
      paginate={rows.length > 25}
      stickyHeader={false}
      onRowClick={onOpenShift}
      getRowLabel={(shift) => `Open shift ${shiftTimeLabel(shiftLocalTimes(shift, timezone))}`}
      emptyState={
        <EmptyState
          icon={EMPTY_STATES.schedule.icon}
          title="No shifts in this range"
          description="This employee has no shifts between these dates. Add one or move to another week."
          size="sm"
          bordered={false}
          headingLevel={3}
          action={emptyAction}
        />
      }
    />
  );
}
