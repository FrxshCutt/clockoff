"use client";

import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  DATE_RANGE_PRESETS,
  DATE_RANGE_PRESET_LABELS,
  isDateRangePreset,
  isLocalDate,
  type DateRangePreset,
} from "./activity-filters";

export interface DateRangeValue {
  readonly range: DateRangePreset;
  readonly from: string | null;
  readonly to: string | null;
}

export interface DateRangeFilterProps {
  value: DateRangeValue;
  onChange: (next: DateRangeValue) => void;
  /** Visible label for the preset select; also used for the accessible names. */
  label?: string;
  className?: string;
}

/**
 * Preset window ("Last 7 days") or a custom range of whole local days. Custom bounds are native date inputs
 * so the picker is keyboard- and screen-reader-friendly on every platform.
 */
export function DateRangeFilter({
  value,
  onChange,
  label = "Period",
  className,
}: DateRangeFilterProps) {
  const fromId = useId();
  const toId = useId();
  const tooEarly =
    value.from &&
    value.to &&
    isLocalDate(value.from) &&
    isLocalDate(value.to) &&
    value.to < value.from;

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <Select
        value={value.range}
        onValueChange={(next) => isDateRangePreset(next) && onChange({ ...value, range: next })}
      >
        <SelectTrigger size="sm" className="h-9 w-44" aria-label={label}>
          <SelectValue placeholder={label} />
        </SelectTrigger>
        <SelectContent>
          {DATE_RANGE_PRESETS.map((preset) => (
            <SelectItem key={preset} value={preset}>
              {DATE_RANGE_PRESET_LABELS[preset]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {value.range === "custom" ? (
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Label htmlFor={fromId} className="text-muted-foreground text-xs">
              From
            </Label>
            <Input
              id={fromId}
              type="date"
              value={value.from ?? ""}
              max={value.to ?? undefined}
              onChange={(event) => onChange({ ...value, from: event.target.value || null })}
              className="h-9 w-40"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <Label htmlFor={toId} className="text-muted-foreground text-xs">
              To
            </Label>
            <Input
              id={toId}
              type="date"
              value={value.to ?? ""}
              min={value.from ?? undefined}
              aria-invalid={tooEarly ? true : undefined}
              onChange={(event) => onChange({ ...value, to: event.target.value || null })}
              className="h-9 w-40"
            />
          </div>
          {tooEarly ? (
            <p role="alert" className="text-destructive text-xs">
              The end date must be on or after the start date.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
