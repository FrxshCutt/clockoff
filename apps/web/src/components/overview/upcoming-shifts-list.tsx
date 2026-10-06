"use client";

import type { DateFormat } from "@workmode/shared/enums";
import type { UpcomingShift } from "@workmode/validation/compliance";
import { ArrowUpRight, CalendarClock, MapPin } from "lucide-react";
import Link from "next/link";
import { TonedBadge } from "@/components/devices/toned-badge";
import { useNow } from "@/components/employees/use-now";
import { describeNextShift } from "@/components/employees/employee-view-model";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { SectionCard } from "@/components/section";
import { StatusBadge } from "@/components/status/status-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ROUTES, routeFor } from "@/config/navigation";
import { UPCOMING_SHIFT_WINDOW_HOURS, upcomingShiftsWithin } from "./overview-model";

export interface UpcomingShiftsListProps {
  /** `upcomingShifts` from the compliance summary (undefined while loading). */
  shifts: readonly UpcomingShift[] | undefined;
  isLoading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  isRetrying?: boolean;
  dateFormat?: DateFormat;
  className?: string;
}

function ShiftRowsSkeleton() {
  return (
    <ul aria-busy="true" aria-label="Loading upcoming shifts" className="divide-border divide-y">
      {Array.from({ length: 3 }, (_, i) => (
        <li key={i} className="flex items-center gap-4 py-3">
          <div className="w-28 space-y-1.5">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-3 w-24" />
          </div>
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-28" />
          </div>
          <Skeleton className="h-5 w-20 rounded-full" />
        </li>
      ))}
    </ul>
  );
}

/**
 * Shifts starting in the next 12 hours. Times are shown in each shift's own zone (a London café and a
 * Manchester site read correctly side by side), with whether the employee's phone is ready to enforce Work Mode.
 */
export function UpcomingShiftsList({ shifts, isLoading = false, error, onRetry, isRetrying, dateFormat, className }: UpcomingShiftsListProps) {
  const now = useNow();
  const upcoming = shifts && now !== null ? upcomingShiftsWithin(shifts, now) : null;

  return (
    <SectionCard
      title="Upcoming shifts"
      description={`Starting in the next ${UPCOMING_SHIFT_WINDOW_HOURS} hours, shown in each shift's local time.`}
      className={className}
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link href={ROUTES.schedule}>
            Open schedule
            <ArrowUpRight aria-hidden="true" />
          </Link>
        </Button>
      }
      contentClassName="px-5 py-2 sm:px-6"
    >
      {error ? (
        <ErrorState size="sm" title="Couldn't load upcoming shifts" error={error} onRetry={onRetry} isRetrying={isRetrying} />
      ) : isLoading || upcoming === null || now === null ? (
        <ShiftRowsSkeleton />
      ) : upcoming.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          size="sm"
          bordered={false}
          headingLevel={3}
          title={`No shifts in the next ${UPCOMING_SHIFT_WINDOW_HOURS} hours`}
          description="Shifts you add or import will appear here shortly before they start."
          action={
            <Button asChild variant="outline" size="sm">
              <Link href={ROUTES.schedule}>Go to schedule</Link>
            </Button>
          }
        />
      ) : (
        <ul className="divide-border divide-y" aria-label="Upcoming shifts">
          {upcoming.map((entry) => {
            const when = describeNextShift(entry.shift, now, { dateFormat });
            const name = `${entry.employee.firstName} ${entry.employee.lastName}`.trim();
            return (
              <li key={entry.shift.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4">
                <div className="w-full shrink-0 sm:w-32">
                  <p className="text-sm font-medium">{when?.primary ?? "—"}</p>
                  <p className="text-muted-foreground text-xs tabular-nums">{when?.range ?? "—"}</p>
                </div>
                <div className="min-w-0 flex-1">
                  <Link
                    href={routeFor.employee(entry.employee.id)}
                    className="focus-visible:ring-ring/50 truncate rounded-sm text-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2"
                  >
                    {name}
                  </Link>
                  <p className="text-muted-foreground flex items-center gap-1 text-xs">
                    {entry.shift.location ? (
                      <>
                        <MapPin className="size-3" aria-hidden="true" />
                        {entry.shift.location.name}
                      </>
                    ) : (
                      (entry.employee.jobTitle ?? "No location")
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {entry.ready ? (
                    entry.deviceStatus ? (
                      <StatusBadge kind="deviceStatus" value={entry.deviceStatus.badge} size="sm" />
                    ) : (
                      <TonedBadge tone="success" size="sm" description="The phone is connected and can enforce Work Mode.">
                        Ready
                      </TonedBadge>
                    )
                  ) : (
                    <TonedBadge
                      tone="warning"
                      size="sm"
                      description="The phone isn't connected or lacks Screen Time permission, so Work Mode can't switch on for this shift."
                    >
                      Not ready
                    </TonedBadge>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}
