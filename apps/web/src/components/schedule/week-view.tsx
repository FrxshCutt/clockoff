"use client";

import type { Shift } from "@workmode/validation/shifts";
import type { LocalDateString } from "@workmode/shared/time/time";
import { Plus } from "lucide-react";
import { useMemo, useState, type DragEvent } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  employeeRows,
  findConflicts,
  formatLocalDay,
  placeShiftsOnDays,
  type EmployeeRow,
  type ShiftChipModel,
} from "./schedule-model";
import { ShiftChip } from "./shift-chip";

export interface WeekViewProps {
  days: readonly LocalDateString[];
  shifts: readonly Shift[];
  timezone: string;
  today: LocalDateString;
  canEdit: boolean;
  onOpenShift: (shift: Shift) => void;
  onAddShift: (input: { employeeId: string; date: LocalDateString }) => void;
  /** Called when a chip is dropped on another day. */
  onMoveShift: (shift: Shift, fromDay: LocalDateString, toDay: LocalDateString) => void;
  /** Ids of shifts whose move is in flight. */
  pendingShiftIds?: ReadonlySet<string>;
  /** Pin a single employee row even when they have no shifts in range (the employee filter). */
  pinnedEmployee?: EmployeeRow | null;
  className?: string;
}

const DRAG_MIME = "application/x-workmode-shift";

interface DragPayload {
  shiftId: string;
  fromDay: LocalDateString;
}

function readDragPayload(event: DragEvent): DragPayload | null {
  try {
    const raw = event.dataTransfer.getData(DRAG_MIME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DragPayload>;
    if (typeof parsed.shiftId !== "string" || typeof parsed.fromDay !== "string") return null;
    return { shiftId: parsed.shiftId, fromDay: parsed.fromDay };
  } catch {
    return null;
  }
}

/**
 * Week grid: one row per employee, one column per day. Chips are draggable between day cells (the drawer's
 * date field is the keyboard alternative). Overnight shifts render on their start day with a `→ 06:00 (+1)`
 * suffix and a dashed continuation chip on the following day.
 */
export function WeekView({ days, shifts, timezone, today, canEdit, onOpenShift, onAddShift, onMoveShift, pendingShiftIds, pinnedEmployee, className }: WeekViewProps) {
  const [dragging, setDragging] = useState<DragPayload | null>(null);
  const [overCell, setOverCell] = useState<string | null>(null);

  const rows = useMemo(() => {
    const fromShifts = employeeRows(shifts);
    if (pinnedEmployee && !fromShifts.some((r) => r.id === pinnedEmployee.id)) return [pinnedEmployee, ...fromShifts];
    return fromShifts;
  }, [shifts, pinnedEmployee]);
  const chipsByDay = useMemo(() => placeShiftsOnDays(shifts, days, timezone), [shifts, days, timezone]);
  const conflicts = useMemo(() => findConflicts(shifts), [shifts]);

  const chipsFor = (employeeId: string, day: LocalDateString): ShiftChipModel[] =>
    (chipsByDay.get(day) ?? []).filter((chip) => chip.shift.employee.id === employeeId);

  const onDragStart = (event: DragEvent<HTMLElement>, chip: ShiftChipModel) => {
    const payload: DragPayload = { shiftId: chip.shift.id, fromDay: chip.day };
    event.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
    event.dataTransfer.effectAllowed = "move";
    setDragging(payload);
  };

  const onDrop = (event: DragEvent<HTMLElement>, day: LocalDateString) => {
    event.preventDefault();
    const payload = readDragPayload(event) ?? dragging;
    setDragging(null);
    setOverCell(null);
    if (!payload) return;
    const shift = shifts.find((s) => s.id === payload.shiftId);
    if (!shift || payload.fromDay === day) return;
    onMoveShift(shift, payload.fromDay, day);
  };

  const gridTemplate = { gridTemplateColumns: `minmax(9rem, 13rem) repeat(${days.length}, minmax(7.5rem, 1fr))` };

  return (
    <div className={cn("bg-card overflow-x-auto rounded-xl border shadow-xs", className)}>
      <div role="grid" aria-label="Weekly schedule" aria-rowcount={rows.length + 1} className="min-w-[56rem]">
        <div role="row" className="bg-muted/60 sticky top-0 z-10 grid border-b backdrop-blur" style={gridTemplate}>
          <div role="columnheader" className="text-muted-foreground px-4 py-3 text-xs font-medium tracking-wide uppercase">
            Employee
          </div>
          {days.map((day) => {
            const isToday = day === today;
            return (
              <div
                key={day}
                role="columnheader"
                aria-current={isToday ? "date" : undefined}
                className={cn("border-l px-3 py-3 text-xs font-medium tracking-wide uppercase", isToday ? "text-primary" : "text-muted-foreground")}
              >
                <span className="flex items-center gap-2">
                  {formatLocalDay(day, "short")}
                  {isToday ? <span className="bg-primary size-1.5 rounded-full" aria-hidden="true" /> : null}
                </span>
              </div>
            );
          })}
        </div>

        {rows.map((row, rowIndex) => (
          <div key={row.id} role="row" aria-rowindex={rowIndex + 2} className="grid border-b last:border-b-0" style={gridTemplate}>
            <div role="rowheader" className="flex min-w-0 flex-col justify-center px-4 py-3">
              <span className="truncate text-sm font-medium">{row.name}</span>
              {row.jobTitle ? <span className="text-muted-foreground truncate text-xs">{row.jobTitle}</span> : null}
            </div>
            {days.map((day) => {
              const cellKey = `${row.id}:${day}`;
              const chips = chipsFor(row.id, day);
              const isDropTarget = dragging !== null && dragging.fromDay !== day;
              return (
                <div
                  key={day}
                  role="gridcell"
                  data-day={day}
                  className={cn(
                    "group/cell relative flex min-h-[4.5rem] flex-col gap-1.5 border-l p-1.5 transition-colors",
                    day === today && "bg-primary/[0.03]",
                    isDropTarget && "bg-accent/40",
                    overCell === cellKey && isDropTarget && "bg-primary/10 ring-primary/40 ring-2 ring-inset",
                  )}
                  onDragOver={
                    canEdit
                      ? (event) => {
                          if (!dragging) return;
                          event.preventDefault();
                          event.dataTransfer.dropEffect = "move";
                          if (overCell !== cellKey) setOverCell(cellKey);
                        }
                      : undefined
                  }
                  onDragLeave={canEdit ? () => setOverCell((current) => (current === cellKey ? null : current)) : undefined}
                  onDrop={canEdit ? (event) => onDrop(event, day) : undefined}
                >
                  {chips.map((chip) => (
                    <ShiftChip
                      key={chip.key}
                      chip={chip}
                      conflicts={conflicts.get(chip.shift.id) ?? []}
                      timezone={timezone}
                      onOpen={onOpenShift}
                      draggable={canEdit && chip.kind === "start"}
                      onDragStart={onDragStart}
                      onDragEnd={() => {
                        setDragging(null);
                        setOverCell(null);
                      }}
                      pending={pendingShiftIds?.has(chip.shift.id) ?? false}
                    />
                  ))}
                  {canEdit ? (
                    <button
                      type="button"
                      onClick={() => onAddShift({ employeeId: row.id, date: day })}
                      aria-label={`Add shift for ${row.name} on ${formatLocalDay(day, "long")}`}
                      className={cn(
                        "text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring/50 mt-auto flex h-7 w-full items-center justify-center rounded-md border border-dashed border-transparent text-xs opacity-0 transition-opacity outline-none focus-visible:opacity-100 focus-visible:ring-[3px] group-hover/cell:border-border group-hover/cell:opacity-100",
                        chips.length === 0 && "flex-1",
                      )}
                    >
                      <Plus className="size-3.5" aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export function WeekViewSkeleton({ days = 7, rows = 5 }: { days?: number; rows?: number }) {
  const gridTemplate = { gridTemplateColumns: `minmax(9rem, 13rem) repeat(${days}, minmax(7.5rem, 1fr))` };
  return (
    <div className="bg-card overflow-x-auto rounded-xl border shadow-xs" aria-hidden="true">
      <div className="min-w-[56rem]">
        <div className="bg-muted/60 grid border-b" style={gridTemplate}>
          <div className="px-4 py-3">
            <Skeleton className="h-3 w-20" />
          </div>
          {Array.from({ length: days }, (_, i) => (
            <div key={i} className="border-l px-3 py-3">
              <Skeleton className="h-3 w-12" />
            </div>
          ))}
        </div>
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} className="grid border-b last:border-b-0" style={gridTemplate}>
            <div className="space-y-2 px-4 py-4">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-16" />
            </div>
            {Array.from({ length: days }, (_, c) => (
              <div key={c} className="min-h-[4.5rem] border-l p-1.5">
                {(r + c) % 3 !== 1 ? <Skeleton className="h-10 w-full" /> : null}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
