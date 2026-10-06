"use client";

import type { LocalDateString } from "@workmode/shared/time/time";
import { CalendarDays, ChevronLeft, ChevronRight, EyeOff, FileUp, Globe, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ROUTES } from "@/config/navigation";
import { formatTimeZoneLabel } from "@/lib/format";
import { EmployeePicker, type EmployeeRef } from "./employee-picker";
import { LocationSelect } from "./location-select";
import {
  SCHEDULE_VIEWS,
  SCHEDULE_VIEW_LABELS,
  formatRangeHeading,
  isScheduleView,
  jsDateToLocalDate,
  localDateToJsDate,
  type ScheduleParams,
  type ScheduleRange,
  type WeekStartsOn,
} from "./schedule-model";

export interface ScheduleToolbarProps {
  params: ScheduleParams;
  range: ScheduleRange;
  today: LocalDateString;
  timezone: string;
  weekStartsOn: WeekStartsOn | undefined;
  canEdit: boolean;
  canImport: boolean;
  /** Known details of the filtered employee (so the picker can label it). */
  selectedEmployee: EmployeeRef | null;
  onChange: (patch: Partial<ScheduleParams>) => void;
  onNavigate: (direction: -1 | 1) => void;
  onAddShift: () => void;
}

/**
 * View switcher, date navigation, filters and primary actions. Everything here is keyboard reachable:
 * the view control is a radio-style toggle group, the date picker is a popover calendar.
 */
export function ScheduleToolbar({
  params,
  range,
  today,
  timezone,
  weekStartsOn,
  canEdit,
  canImport,
  selectedEmployee,
  onChange,
  onNavigate,
  onAddShift,
}: ScheduleToolbarProps) {
  const [dateOpen, setDateOpen] = useState(false);
  const isToday =
    params.view === "day"
      ? params.date === today
      : today >= range.startDate && today <= range.endDate;

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            type="single"
            variant="outline"
            value={params.view}
            onValueChange={(value) => {
              if (isScheduleView(value)) onChange({ view: value });
            }}
            aria-label="Schedule view"
          >
            {SCHEDULE_VIEWS.map((view) => (
              <ToggleGroupItem
                key={view}
                value={view}
                aria-label={`${SCHEDULE_VIEW_LABELS[view]} view`}
                className="px-3"
              >
                {SCHEDULE_VIEW_LABELS[view]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          <div className="flex items-center gap-1" role="group" aria-label="Date navigation">
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => onNavigate(-1)}
              aria-label={params.view === "day" ? "Previous day" : "Previous week"}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => onChange({ date: today })}
              disabled={isToday}
              className="px-3"
            >
              Today
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => onNavigate(1)}
              aria-label={params.view === "day" ? "Next day" : "Next week"}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>

          <Popover open={dateOpen} onOpenChange={setDateOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="px-2 text-base font-semibold tracking-tight"
                aria-label={`Choose date, currently ${formatRangeHeading(range)}`}
              >
                <CalendarDays className="text-muted-foreground" aria-hidden="true" />
                {formatRangeHeading(range)}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-auto p-0">
              <Calendar
                mode="single"
                selected={localDateToJsDate(params.date)}
                defaultMonth={localDateToJsDate(params.date)}
                weekStartsOn={weekStartsOn === "SUNDAY" ? 0 : 1}
                onSelect={(date) => {
                  if (date) {
                    onChange({ date: jsDateToLocalDate(date) });
                    setDateOpen(false);
                  }
                }}
              />
            </PopoverContent>
          </Popover>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canImport ? (
            <Button asChild variant="outline">
              <Link href={ROUTES.scheduleImport}>
                <FileUp aria-hidden="true" />
                Import CSV
              </Link>
            </Button>
          ) : null}
          {canEdit ? (
            <Button type="button" onClick={onAddShift}>
              <Plus aria-hidden="true" />
              Add shift
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <LocationSelect
            value={params.locationId}
            onChange={(locationId) => onChange({ locationId })}
            size="sm"
            aria-label="Filter by location"
            className="h-8"
          />
          <EmployeePicker
            value={params.employeeId}
            selected={selectedEmployee}
            onChange={(employee) => onChange({ employeeId: employee?.id ?? null })}
            placeholder="All employees"
            clearable
            size="sm"
            aria-label="Filter by employee"
            className="w-60"
          />
          <Toggle
            pressed={!params.showCancelled}
            onPressedChange={(pressed) => onChange({ showCancelled: !pressed })}
            variant="outline"
            size="sm"
            aria-label="Hide cancelled shifts"
          >
            <EyeOff aria-hidden="true" />
            Hide cancelled
          </Toggle>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <p className="text-muted-foreground flex items-center gap-1.5 text-sm" tabIndex={0}>
              <Globe className="size-4" aria-hidden="true" />
              Times in {timezone}
            </p>
          </TooltipTrigger>
          <TooltipContent>
            All times are shown in your organisation&apos;s zone, {formatTimeZoneLabel(timezone)}.
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
