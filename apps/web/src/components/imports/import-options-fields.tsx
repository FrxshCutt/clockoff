"use client";

import { DATE_FORMATS } from "@workmode/shared/enums";
import { useId } from "react";
import { TimezoneCombobox } from "@/components/forms/timezone-select";
import { LocationSelect } from "@/components/schedule/location-select";
import { useLocations } from "@/components/schedule/schedule-queries";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DATE_FORMAT_LABELS, formatTimeZoneLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { effectiveImportTimezone, type ImportOptionsInput } from "./import-wizard-model";

export interface ImportOptionsFieldsProps {
  value: ImportOptionsInput;
  onChange: (next: ImportOptionsInput) => void;
  organisationTimezone: string;
  disabled?: boolean;
  className?: string;
}

/**
 * The three import options shared by the upload and mapping steps: how ambiguous dates are read, which
 * zone the CSV times are in, and the location applied to rows without one. The timezone defaults to the
 * chosen location's zone (else the organisation's) until the manager picks one explicitly.
 */
export function ImportOptionsFields({
  value,
  onChange,
  organisationTimezone,
  disabled,
  className,
}: ImportOptionsFieldsProps) {
  const id = useId();
  const locations = useLocations();
  const effectiveTimezone = effectiveImportTimezone(
    value,
    locations.data ?? [],
    organisationTimezone,
  );

  return (
    <div className={cn("grid gap-4 sm:grid-cols-3", className)}>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-date-format`}>Date format</Label>
        <Select
          value={value.dateFormat}
          onValueChange={(next) =>
            onChange({ ...value, dateFormat: next as ImportOptionsInput["dateFormat"] })
          }
          disabled={disabled}
        >
          <SelectTrigger id={`${id}-date-format`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DATE_FORMATS.map((format) => (
              <SelectItem key={format} value={format}>
                <span className="flex flex-col">
                  <span>{DATE_FORMAT_LABELS[format].label}</span>
                  <span className="text-muted-foreground text-xs">
                    e.g. {DATE_FORMAT_LABELS[format].example}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">
          How dates like 03/04/2026 are read. Year-first dates always work.
        </p>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={`${id}-timezone`}>Time zone</Label>
          {value.timezone ? (
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto p-0"
              onClick={() => onChange({ ...value, timezone: null })}
              disabled={disabled}
            >
              Use default
            </Button>
          ) : null}
        </div>
        <TimezoneCombobox
          id={`${id}-timezone`}
          value={effectiveTimezone}
          onChange={(timezone) => onChange({ ...value, timezone })}
          disabled={disabled}
        />
        <p className="text-muted-foreground text-xs">
          {value.timezone
            ? "Times in the file are read in this zone."
            : `Default: ${formatTimeZoneLabel(effectiveTimezone)} (the location's zone, else the organisation's).`}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${id}-location`}>Default location</Label>
        <LocationSelect
          id={`${id}-location`}
          value={value.locationId}
          onChange={(locationId) => onChange({ ...value, locationId })}
          nullLabel="No default location"
          disabled={disabled}
          className="w-full"
        />
        <p className="text-muted-foreground text-xs">
          Applied to rows whose location cell is empty.
        </p>
      </div>
    </div>
  );
}
