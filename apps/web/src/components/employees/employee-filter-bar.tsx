"use client";

import { Search, X } from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useDepartments, useLocations, usePolicies, useTeams } from "./employee-api";
import {
  EMPLOYEE_QUICK_FILTERS,
  QUICK_FILTER_META,
  hasActiveEmployeeFilters,
  isQuickFilter,
  type EmployeeListParams,
} from "./employee-filters";
import { ReferenceSelect } from "./reference-select";

export interface EmployeeFilterBarProps {
  params: EmployeeListParams;
  /** Live search text (the API query behind `params.search` is debounced by the page). */
  searchInput: string;
  onSearchInputChange: (value: string) => void;
  onChange: (patch: Partial<EmployeeListParams>) => void;
  onClear: () => void;
}

/**
 * Quick-filter chips (Connected, Awaiting setup, …) plus Location / Department / Team / Policy selects and
 * the search box. Everything is reflected in the URL by the page so filtered views can be linked to.
 */
export function EmployeeFilterBar({
  params,
  searchInput,
  onSearchInputChange,
  onChange,
  onClear,
}: EmployeeFilterBarProps) {
  const ids = useId();
  const locations = useLocations();
  const departments = useDepartments();
  const teams = useTeams();
  const policies = usePolicies();
  const active = hasActiveEmployeeFilters(params) || searchInput.trim() !== "";

  const selectClass = "h-9 w-full sm:w-44";

  return (
    <div className="space-y-3" role="search" aria-label="Filter employees">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={params.filter ?? ""}
          onValueChange={(value) =>
            onChange({ filter: isQuickFilter(value) ? value : null, page: 1 })
          }
          aria-label="Quick filters"
          className="flex-wrap justify-start gap-1.5 shadow-none"
          spacing={1}
        >
          {EMPLOYEE_QUICK_FILTERS.map((filter) => {
            const meta = QUICK_FILTER_META[filter];
            return (
              <ToggleGroupItem
                key={filter}
                value={filter}
                title={meta.description}
                className="data-[state=on]:border-primary/40 data-[state=on]:bg-primary/10 data-[state=on]:text-primary rounded-full px-3"
              >
                {meta.label}
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
        <div className="relative w-full lg:w-72">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={searchInput}
            onChange={(event) => onSearchInputChange(event.target.value)}
            placeholder="Search name, email, job title or ID…"
            aria-label="Search employees"
            className="h-9 pl-9"
            maxLength={100}
          />
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
        <div className="space-y-1">
          <Label htmlFor={`${ids}-location`} className="text-muted-foreground text-xs">
            Location
          </Label>
          <ReferenceSelect
            id={`${ids}-location`}
            value={params.locationId ?? ""}
            onChange={(id) => onChange({ locationId: id || null, page: 1 })}
            options={locations.data?.map((l) => ({ id: l.id, name: l.name }))}
            isLoading={locations.isPending}
            noneLabel="All locations"
            className={selectClass}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${ids}-department`} className="text-muted-foreground text-xs">
            Department
          </Label>
          <ReferenceSelect
            id={`${ids}-department`}
            value={params.departmentId ?? ""}
            onChange={(id) => onChange({ departmentId: id || null, page: 1 })}
            options={departments.data?.map((d) => ({ id: d.id, name: d.name }))}
            isLoading={departments.isPending}
            noneLabel="All departments"
            className={selectClass}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${ids}-team`} className="text-muted-foreground text-xs">
            Team
          </Label>
          <ReferenceSelect
            id={`${ids}-team`}
            value={params.teamId ?? ""}
            onChange={(id) => onChange({ teamId: id || null, page: 1 })}
            options={teams.data?.map((t) => ({ id: t.id, name: t.name, hint: t.location?.name }))}
            isLoading={teams.isPending}
            noneLabel="All teams"
            className={selectClass}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${ids}-policy`} className="text-muted-foreground text-xs">
            Policy
          </Label>
          <ReferenceSelect
            id={`${ids}-policy`}
            value={params.policyId ?? ""}
            onChange={(id) => onChange({ policyId: id || null, page: 1 })}
            options={policies.data
              ?.filter((p) => p.status !== "ARCHIVED")
              .map((p) => ({
                id: p.id,
                name: p.name,
                hint: p.isDefault ? "Organisation default" : undefined,
              }))}
            isLoading={policies.isPending}
            noneLabel="All policies"
            className={selectClass}
          />
        </div>
        {active ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-9 self-end"
            onClick={onClear}
          >
            Clear filters
            <X aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
