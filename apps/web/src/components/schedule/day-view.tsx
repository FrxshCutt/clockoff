"use client";

import type { Shift } from "@workmode/validation/shifts";
import type { LocalDateString } from "@workmode/shared/time/time";
import { Plus } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  MINUTES_PER_DAY,
  assignLanes,
  employeeRows,
  findConflicts,
  formatLocalDay,
  hourTicks,
  placeShiftsOnDays,
  type EmployeeRow,
} from "./schedule-model";
import { ShiftChip } from "./shift-chip";

export interface DayViewProps {
  day: LocalDateString;
  shifts: readonly Shift[];
  timezone: string;
  canEdit: boolean;
  onOpenShift: (shift: Shift) => void;
  onAddShift: (input: { employeeId: string; date: LocalDateString }) => void;
  pendingShiftIds?: ReadonlySet<string>;
  pinnedEmployee?: EmployeeRow | null;
  className?: string;
}

const LANE_HEIGHT_REM = 2.75;
const LANE_GAP_REM = 0.25;

/**
 * Day view: a 00–24 time axis with one row per employee; overlapping shifts stack into lanes. Chips are
 * positioned by their minutes within the day in the display timezone, clipped to the day (an overnight
 * shift shows its evening portion today and its morning portion as a continuation tomorrow).
 */
export function DayView({
  day,
  shifts,
  timezone,
  canEdit,
  onOpenShift,
  onAddShift,
  pendingShiftIds,
  pinnedEmployee,
  className,
}: DayViewProps) {
  const rows = useMemo(() => {
    const fromShifts = employeeRows(
      shifts.filter((s) => placeShiftsOnDays([s], [day], timezone).get(day)?.length),
    );
    if (pinnedEmployee && !fromShifts.some((r) => r.id === pinnedEmployee.id))
      return [pinnedEmployee, ...fromShifts];
    return fromShifts;
  }, [shifts, day, timezone, pinnedEmployee]);
  const chips = useMemo(
    () => placeShiftsOnDays(shifts, [day], timezone).get(day) ?? [],
    [shifts, day, timezone],
  );
  const conflicts = useMemo(() => findConflicts(shifts), [shifts]);
  const ticks = hourTicks(3);
  const gridTemplate = { gridTemplateColumns: "minmax(9rem, 13rem) minmax(32rem, 1fr)" };

  return (
    <div className={cn("bg-card overflow-x-auto rounded-xl border shadow-xs", className)}>
      <div
        role="table"
        aria-label={`Schedule for ${formatLocalDay(day, "long")}`}
        aria-rowcount={rows.length + 1}
        className="min-w-[44rem]"
      >
        <div
          role="row"
          className="bg-muted/60 sticky top-0 z-10 grid border-b backdrop-blur"
          style={gridTemplate}
        >
          <div
            role="columnheader"
            className="text-muted-foreground px-4 py-3 text-xs font-medium tracking-wide uppercase"
          >
            Employee
          </div>
          <div role="columnheader" aria-label="Time of day" className="relative h-10 border-l">
            {ticks.map((tick) => (
              <span
                key={tick.hour}
                className="text-muted-foreground absolute top-3 text-xs tabular-nums"
                style={{
                  left: `${tick.percent}%`,
                  transform:
                    tick.hour === 24
                      ? "translateX(-100%)"
                      : tick.hour === 0
                        ? undefined
                        : "translateX(-50%)",
                }}
                aria-hidden="true"
              >
                {tick.label}
              </span>
            ))}
          </div>
        </div>

        {rows.map((row, rowIndex) => {
          const rowChips = chips.filter((chip) => chip.shift.employee.id === row.id);
          const { lanes, laneCount } = assignLanes(rowChips);
          const height = laneCount * LANE_HEIGHT_REM + (laneCount - 1) * LANE_GAP_REM + 0.75;
          return (
            <div
              key={row.id}
              role="row"
              aria-rowindex={rowIndex + 2}
              className="grid border-b last:border-b-0"
              style={gridTemplate}
            >
              <div
                role="rowheader"
                className="flex min-w-0 items-center justify-between gap-2 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{row.name}</p>
                  {row.jobTitle ? (
                    <p className="text-muted-foreground truncate text-xs">{row.jobTitle}</p>
                  ) : null}
                </div>
                {canEdit ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Add shift for ${row.name} on ${formatLocalDay(day, "long")}`}
                    onClick={() => onAddShift({ employeeId: row.id, date: day })}
                  >
                    <Plus aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
              <div role="cell" className="relative border-l" style={{ height: `${height}rem` }}>
                {ticks.map((tick) =>
                  tick.hour > 0 && tick.hour < 24 ? (
                    <span
                      key={tick.hour}
                      className="bg-border/70 absolute inset-y-0 w-px"
                      style={{ left: `${tick.percent}%` }}
                      aria-hidden="true"
                    />
                  ) : null,
                )}
                {lanes.map(({ item: chip, lane }) => {
                  const left = (chip.startMinutes / MINUTES_PER_DAY) * 100;
                  const width = Math.max(
                    ((chip.endMinutes - chip.startMinutes) / MINUTES_PER_DAY) * 100,
                    1.5,
                  );
                  return (
                    <ShiftChip
                      key={chip.key}
                      chip={chip}
                      conflicts={conflicts.get(chip.shift.id) ?? []}
                      timezone={timezone}
                      onOpen={onOpenShift}
                      pending={pendingShiftIds?.has(chip.shift.id) ?? false}
                      className="absolute justify-center overflow-hidden"
                      style={{
                        left: `calc(${left}% + 2px)`,
                        width: `calc(${width}% - 4px)`,
                        top: `${0.375 + lane * (LANE_HEIGHT_REM + LANE_GAP_REM)}rem`,
                        height: `${LANE_HEIGHT_REM}rem`,
                      }}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function DayViewSkeleton({ rows = 5 }: { rows?: number }) {
  const gridTemplate = { gridTemplateColumns: "minmax(9rem, 13rem) minmax(32rem, 1fr)" };
  return (
    <div className="bg-card overflow-x-auto rounded-xl border shadow-xs" aria-hidden="true">
      <div className="min-w-[44rem]">
        <div className="bg-muted/60 grid border-b" style={gridTemplate}>
          <div className="px-4 py-3">
            <Skeleton className="h-3 w-20" />
          </div>
          <div className="flex h-10 items-center justify-between border-l px-3">
            {Array.from({ length: 9 }, (_, i) => (
              <Skeleton key={i} className="h-3 w-5" />
            ))}
          </div>
        </div>
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} className="grid border-b last:border-b-0" style={gridTemplate}>
            <div className="space-y-2 px-4 py-4">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-16" />
            </div>
            <div className="relative h-14 border-l">
              <Skeleton
                className="absolute top-2 h-10"
                style={{ left: `${10 + r * 7}%`, width: "32%" }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
