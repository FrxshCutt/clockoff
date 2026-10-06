"use client";

import type { Employee } from "@workmode/validation/employees";
import { LoaderCircle, X } from "lucide-react";
import { useEmployee, useLocations } from "@/components/employees/employee-api";
import { EmployeePicker } from "@/components/employees/employee-picker";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EMPTY_STATES } from "@/config/emptyStates";
import { isResourceId } from "@/config/navigation";
import { useCurrentOrganisation } from "@/hooks/use-organisation";
import { useActivityFeed } from "./activity-api";
import {
  DEFAULT_FEED_PARAMS,
  hasActiveFeedFilters,
  type ActivityFeedParams,
} from "./activity-filters";
import { ActivityList, ActivityListSkeleton } from "./activity-item";
import { ACTIVITY_GROUP_LABELS, ACTIVITY_TYPE_OPTIONS } from "./activity-meta";
import { DateRangeFilter } from "./date-range-filter";
import { MultiSelectFilter } from "./multi-select-filter";

const ALL_LOCATIONS = "__all__";

export interface ActivityFeedProps {
  feed: ActivityFeedParams;
  onChange: (next: ActivityFeedParams) => void;
}

/**
 * The organisation feed (`GET /api/activity`) behind filters for employee, event type, period and location,
 * loaded page by page ("Load more"). Realtime events invalidate the first page so new entries appear on top.
 */
export function ActivityFeed({ feed, onChange }: ActivityFeedProps) {
  const organisation = useCurrentOrganisation();
  const timeZone = organisation.data?.organisation.timezone ?? "UTC";
  const query = useActivityFeed(feed, timeZone, { enabled: !organisation.isPending });
  const locations = useLocations();
  // The URL only carries the employee id; the picker needs a name to show the selection.
  const selectedEmployee = useEmployee(feed.employeeId ?? "", {
    enabled: isResourceId(feed.employeeId),
  });

  const events = query.data?.pages.flatMap((page) => page.items) ?? [];
  const filtersActive = hasActiveFeedFilters(feed);
  const emptyCopy = EMPTY_STATES.activity;
  const searchCopy = EMPTY_STATES.search;

  const pickerValue = feed.employeeId
    ? selectedEmployee.data
      ? {
          id: selectedEmployee.data.id,
          firstName: selectedEmployee.data.firstName,
          lastName: selectedEmployee.data.lastName,
          jobTitle: selectedEmployee.data.jobTitle,
        }
      : { id: feed.employeeId, firstName: "Loading", lastName: "…", jobTitle: null }
    : null;

  return (
    <div className="space-y-4">
      <div role="group" aria-label="Activity filters" className="flex flex-wrap items-center gap-2">
        <EmployeePicker
          value={pickerValue}
          onChange={(employee: Employee | null) =>
            onChange({ ...feed, employeeId: employee?.id ?? null })
          }
          placeholder="All employees"
          aria-label="Filter by employee"
          className="h-9 w-56"
        />
        <MultiSelectFilter
          title="Type"
          options={ACTIVITY_TYPE_OPTIONS}
          groupLabels={ACTIVITY_GROUP_LABELS}
          value={feed.types}
          onChange={(types) => onChange({ ...feed, types })}
        />
        <DateRangeFilter
          value={{ range: feed.range, from: feed.from, to: feed.to }}
          onChange={(next) =>
            onChange({ ...feed, range: next.range, from: next.from, to: next.to })
          }
        />
        <Select
          value={feed.locationId ?? ALL_LOCATIONS}
          onValueChange={(next) =>
            onChange({ ...feed, locationId: next === ALL_LOCATIONS ? null : next })
          }
        >
          <SelectTrigger size="sm" className="h-9 w-44" aria-label="Filter by location">
            <SelectValue placeholder="All locations" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_LOCATIONS}>All locations</SelectItem>
            {(locations.data ?? []).map((location) => (
              <SelectItem key={location.id} value={location.id}>
                {location.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filtersActive ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-9"
            onClick={() => onChange(DEFAULT_FEED_PARAMS)}
          >
            Reset
            <X aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      <div className="bg-card rounded-xl border px-5 shadow-xs sm:px-6">
        {query.isPending ? (
          <ActivityListSkeleton rows={8} />
        ) : query.isError ? (
          <ErrorState
            title="Couldn't load activity"
            error={query.error}
            onRetry={() => void query.refetch()}
            isRetrying={query.isRefetching}
            className="my-4 border-0"
          />
        ) : events.length === 0 ? (
          filtersActive ? (
            <EmptyState
              icon={searchCopy.icon}
              title={searchCopy.title}
              description={searchCopy.description}
              size="sm"
              bordered={false}
              action={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onChange(DEFAULT_FEED_PARAMS)}
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={emptyCopy.icon}
              title={emptyCopy.title}
              description={emptyCopy.description}
              size="sm"
              bordered={false}
            />
          )
        ) : (
          <>
            <ActivityList
              events={events}
              timeZone={organisation.data?.organisation.timezone}
              label="Activity feed"
            />
            <div className="flex items-center justify-between gap-3 border-t py-3">
              <p className="text-muted-foreground text-xs">
                Showing {events.length} event{events.length === 1 ? "" : "s"}
                {query.isFetching && !query.isFetchingNextPage ? " · refreshing…" : ""}
              </p>
              {query.hasNextPage ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={query.isFetchingNextPage}
                  onClick={() => void query.fetchNextPage()}
                >
                  {query.isFetchingNextPage ? (
                    <LoaderCircle className="animate-spin" aria-hidden="true" />
                  ) : null}
                  Load more
                </Button>
              ) : (
                <p className="text-muted-foreground text-xs">You&apos;re up to date.</p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
