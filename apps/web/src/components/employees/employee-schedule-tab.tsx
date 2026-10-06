"use client";

import type { EmployeeDetail } from "@workmode/validation/employees";
import type { Shift } from "@workmode/validation/shifts";
import type { ColumnDef } from "@tanstack/react-table";
import { CalendarClock, CalendarPlus, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { DataTable, DataTableColumnHeader } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { SectionCard } from "@/components/section";
import { StatusBadge } from "@/components/status/status-badge";
import { Button } from "@/components/ui/button";
import { ROUTES } from "@/config/navigation";
import { usePermission } from "@/hooks/use-current-user";
import { useCurrentOrganisation } from "@/hooks/use-organisation";
import { formatDate, formatDurationMinutes } from "@/lib/format";
import { useEmployeeShifts } from "./employee-api";
import { EMPLOYEE_EMPTY_STATES } from "./employee-copy";
import { employeeScheduleWindow } from "./employee-view-model";
import { ShiftQuickFormDialog } from "./shift-quick-form";
import { useNow } from "./use-now";

export interface EmployeeScheduleTabProps {
  employee: EmployeeDetail;
}

/** Upcoming shifts (`GET /api/employees/:id/shifts`, yesterday → +14 days) with the quick "Add shift" dialog. */
export function EmployeeScheduleTab({ employee }: EmployeeScheduleTabProps) {
  const canWrite = usePermission("schedule:write") && employee.employmentStatus === "ACTIVE";
  const organisation = useCurrentOrganisation();
  const dateFormat = organisation.data?.organisation.dateFormat;
  // Explicit window (the API's default is the last 7 days → +93 days); null until hydration gives us a clock.
  const now = useNow();
  const range = now === null ? null : employeeScheduleWindow(now);
  const query = useEmployeeShifts(
    employee.id,
    { ...(range ?? {}), limit: 100 },
    { enabled: range !== null },
  );
  const [addOpen, setAddOpen] = useState(false);

  const scheduleHref = `${ROUTES.schedule}?view=employee&employee=${encodeURIComponent(employee.id)}`;

  const columns = useMemo<ColumnDef<Shift>[]>(
    () => [
      {
        id: "date",
        accessorKey: "startsAt",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Date" />,
        enableSorting: false,
        cell: ({ row }) => {
          const shift = row.original;
          return (
            <div className="space-y-0.5">
              <p className="text-sm font-medium">
                {formatDate(shift.startsAt, { timeZone: shift.timezone, dateFormat })}
              </p>
              <p className="text-muted-foreground text-xs tabular-nums">
                {shift.localStartTime}–{shift.localEndTime}
                {shift.isOvernight ? " (+1)" : ""}
              </p>
            </div>
          );
        },
      },
      {
        id: "duration",
        accessorKey: "durationMinutes",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Length" />,
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-sm tabular-nums">
            {formatDurationMinutes(row.original.durationMinutes)}
          </span>
        ),
      },
      {
        id: "location",
        accessorFn: (s) => s.location?.name ?? "",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Location" />,
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-sm">
            {row.original.location?.name ?? <span className="text-muted-foreground">—</span>}
          </span>
        ),
      },
      {
        id: "breaks",
        accessorFn: (s) => s.scheduledBreaks.length,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Scheduled breaks" />,
        enableSorting: false,
        cell: ({ row }) => {
          const breaks = row.original.scheduledBreaks;
          if (breaks.length === 0)
            return <span className="text-muted-foreground text-sm">None</span>;
          return (
            <span className="text-sm">
              {breaks.length} ·{" "}
              {formatDurationMinutes(breaks.reduce((sum, b) => sum + b.durationMinutes, 0))}
            </span>
          );
        },
      },
      {
        id: "status",
        accessorKey: "status",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
        enableSorting: false,
        cell: ({ row }) => <StatusBadge kind="shiftStatus" value={row.original.status} size="sm" />,
      },
      {
        id: "notes",
        accessorKey: "notes",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Notes" />,
        enableSorting: false,
        cell: ({ row }) =>
          row.original.notes ? (
            <p
              className="text-muted-foreground max-w-xs truncate text-sm"
              title={row.original.notes}
            >
              {row.original.notes}
            </p>
          ) : null,
      },
    ],
    [dateFormat],
  );

  const addButton = canWrite ? (
    <Button type="button" size="sm" onClick={() => setAddOpen(true)}>
      <CalendarPlus aria-hidden="true" />
      Add shift
    </Button>
  ) : null;

  return (
    <SectionCard
      title="Upcoming shifts"
      description="From yesterday to the next two weeks. Open the Schedule page for the full rota, repeats and scheduled breaks."
      actions={
        <>
          {addButton}
          <Button asChild variant="outline" size="sm">
            <Link href={scheduleHref}>
              <ExternalLink aria-hidden="true" />
              Open in Schedule
            </Link>
          </Button>
        </>
      }
      flush
    >
      <div className="px-5 py-5 sm:px-6">
        {query.isError ? (
          <ErrorState
            size="sm"
            title="Couldn't load shifts"
            error={query.error}
            onRetry={() => void query.refetch()}
            isRetrying={query.isRefetching}
          />
        ) : (
          <DataTable<Shift>
            label="Upcoming shifts"
            columns={columns}
            data={query.data}
            isLoading={query.isPending}
            getRowId={(row) => row.id}
            paginate={false}
            stickyHeader={false}
            emptyState={
              <EmptyState
                icon={CalendarClock}
                title={EMPLOYEE_EMPTY_STATES.shifts.title}
                description={EMPLOYEE_EMPTY_STATES.shifts.description}
                headingLevel={3}
                action={addButton ?? undefined}
              />
            }
          />
        )}
      </div>
      <ShiftQuickFormDialog open={addOpen} onOpenChange={setAddOpen} employee={employee} />
    </SectionCard>
  );
}
