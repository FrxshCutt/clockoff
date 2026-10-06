"use client";

import { MapPin } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useLocations } from "./schedule-queries";

/** Sentinel for "all / none" because Radix Select cannot represent an empty-string value. */
export const LOCATION_ALL = "__all__";

export interface LocationSelectProps {
  /** Location id or null for the "all / none" option. */
  value: string | null;
  onChange: (locationId: string | null) => void;
  /** Label of the null option: "All locations" (filter) or "No location" (form). */
  nullLabel?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  size?: "default" | "sm";
  "aria-label"?: string;
  onBlur?: () => void;
}

/** Location dropdown fed by `GET /api/locations`. */
export function LocationSelect({ value, onChange, nullLabel = "All locations", disabled, id, className, size = "default", onBlur, ...aria }: LocationSelectProps) {
  const { data, isPending, isError } = useLocations();
  const locations = data ?? [];
  const known = value !== null && locations.some((l) => l.id === value);
  return (
    <Select
      value={value && (known || isPending) ? value : LOCATION_ALL}
      onValueChange={(next) => onChange(next === LOCATION_ALL ? null : next)}
      disabled={disabled || isPending || isError}
    >
      <SelectTrigger id={id} size={size} className={cn("min-w-40", className)} onBlur={onBlur} aria-label={aria["aria-label"]}>
        <MapPin className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
        <SelectValue placeholder={isPending ? "Loading locations…" : isError ? "Locations unavailable" : nullLabel} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={LOCATION_ALL}>{nullLabel}</SelectItem>
        {locations.map((location) => (
          <SelectItem key={location.id} value={location.id}>
            {location.name}
          </SelectItem>
        ))}
        {value && !known && !isPending ? <SelectItem value={value}>Unknown location</SelectItem> : null}
      </SelectContent>
    </Select>
  );
}
