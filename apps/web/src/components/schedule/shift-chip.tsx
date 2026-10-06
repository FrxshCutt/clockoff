"use client";

import type { Shift } from "@workmode/validation/shifts";
import { Coffee, MapPin, MoonStar, Repeat, TriangleAlert } from "lucide-react";
import type { CSSProperties, DragEvent, KeyboardEvent } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  employeeName,
  shiftLocalTimes,
  shiftTimeLabel,
  type ShiftChipModel,
} from "./schedule-model";

export interface ShiftChipProps {
  chip: ShiftChipModel;
  /** Other shifts this one overlaps (empty when there is no conflict). */
  conflicts?: readonly Shift[];
  /** Display timezone for the conflict tooltip. */
  timezone: string;
  onOpen: (shift: Shift) => void;
  /** Enables HTML5 dragging (start chips of scheduled shifts only). */
  draggable?: boolean;
  onDragStart?: (event: DragEvent<HTMLElement>, chip: ShiftChipModel) => void;
  onDragEnd?: () => void;
  /** Show the employee name (day/continuation contexts where the row does not say it). */
  showEmployee?: boolean;
  /** Absolute positioning for the day view. */
  style?: CSSProperties;
  className?: string;
  /** Visually quieter while a drag/patch is in flight. */
  pending?: boolean;
}

export const STATUS_CHIP_CLASSES: Record<Shift["status"], string> = {
  SCHEDULED:
    "border-sky-200 bg-sky-50 text-sky-950 hover:border-sky-300 dark:border-sky-500/30 dark:bg-sky-500/15 dark:text-sky-100",
  COMPLETED:
    "border-emerald-200 bg-emerald-50 text-emerald-950 hover:border-emerald-300 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-100",
  CANCELLED:
    "border-zinc-200 bg-zinc-50 text-zinc-500 line-through hover:border-zinc-300 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-400",
};

/**
 * One shift on the grid. A button (click / Enter / Space opens the drawer) that can also be dragged to
 * another day. Colour is never the only signal: cancelled shifts are struck through, conflicts carry a
 * warning icon and text, overnight shifts a moon icon and the `→ 06:00 (+1)` suffix.
 */
export function ShiftChip({
  chip,
  conflicts = [],
  timezone,
  onOpen,
  draggable = false,
  onDragStart,
  onDragEnd,
  showEmployee = false,
  style,
  className,
  pending = false,
}: ShiftChipProps) {
  const { shift } = chip;
  const hasConflict = conflicts.length > 0;
  const cancelled = shift.status === "CANCELLED";
  // Only scheduled shifts move: the API rejects moving cancelled/completed ones and they are in the past anyway.
  const movable = draggable && shift.status === "SCHEDULED";
  const name = employeeName(shift.employee);
  const locationName = shift.location?.name ?? null;
  const breaks = shift.scheduledBreaks.length;
  const ariaLabel = [
    showEmployee ? name : null,
    chip.kind === "continuation" ? `continues until ${chip.endLabel}` : chip.label,
    locationName,
    cancelled ? "cancelled" : shift.status === "COMPLETED" ? "completed" : null,
    hasConflict ? "overlaps another shift" : null,
    chip.overnight ? "overnight shift" : null,
    shift.recurrenceRule || shift.parentRecurrenceId ? "repeating" : null,
  ]
    .filter(Boolean)
    .join(", ");

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(shift);
    }
  };

  const body = (
    <div
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      draggable={movable}
      onClick={() => onOpen(shift)}
      onKeyDown={onKeyDown}
      onDragStart={movable && onDragStart ? (event) => onDragStart(event, chip) : undefined}
      onDragEnd={onDragEnd}
      data-shift-id={shift.id}
      data-kind={chip.kind}
      style={style}
      className={cn(
        "group/chip focus-visible:ring-ring/50 flex min-w-0 cursor-pointer flex-col gap-0.5 rounded-md border px-2 py-1 text-left text-xs leading-4 shadow-xs transition-[color,box-shadow,opacity] outline-none select-none focus-visible:ring-[3px]",
        STATUS_CHIP_CLASSES[shift.status],
        chip.kind === "continuation" && "border-dashed",
        movable && "cursor-grab active:cursor-grabbing",
        hasConflict && "ring-2 ring-amber-400/70 dark:ring-amber-400/50",
        pending && "opacity-60",
        className,
      )}
    >
      <span className="flex min-w-0 items-center gap-1 font-medium tabular-nums">
        {hasConflict ? (
          <TriangleAlert
            className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
            aria-hidden="true"
          />
        ) : null}
        {chip.overnight ? (
          <MoonStar className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
        ) : null}
        <span className="truncate">{chip.label}</span>
        {shift.recurrenceRule || shift.parentRecurrenceId ? (
          <Repeat className="ml-auto size-3 shrink-0 opacity-60" aria-hidden="true" />
        ) : null}
      </span>
      {showEmployee ? <span className="truncate font-medium">{name}</span> : null}
      {locationName || breaks > 0 ? (
        <span className="flex min-w-0 items-center gap-2 opacity-80">
          {locationName ? (
            <span className="flex min-w-0 items-center gap-1">
              <MapPin className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{locationName}</span>
            </span>
          ) : null}
          {breaks > 0 ? (
            <span
              className="flex shrink-0 items-center gap-1"
              aria-label={`${breaks} scheduled ${breaks === 1 ? "break" : "breaks"}`}
            >
              <Coffee className="size-3" aria-hidden="true" />
              {breaks}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );

  if (!hasConflict) return body;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{body}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <p className="font-medium">
          Overlaps {conflicts.length === 1 ? "another shift" : `${conflicts.length} other shifts`}
        </p>
        <ul className="mt-1 space-y-0.5">
          {conflicts.slice(0, 4).map((other) => {
            const times = shiftLocalTimes(other, timezone);
            return (
              <li key={other.id} className="tabular-nums">
                {times.startDate} · {shiftTimeLabel(times)}
                {other.location ? ` · ${other.location.name}` : ""}
              </li>
            );
          })}
          {conflicts.length > 4 ? <li>…and {conflicts.length - 4} more</li> : null}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}
