"use client";

import type { ActivityEventType } from "@workmode/shared/enums";
import type { ActivityEvent } from "@workmode/validation/activity";
import { useId, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { RelativeTime } from "@/components/relative-time";
import { SectionCard } from "@/components/section";
import { TONE_DOT_CLASSES } from "@/components/status/statusMeta";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentOrganisation } from "@/hooks/use-organisation";
import { formatDate, formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  ACTIVITY_TYPE_OPTIONS,
  activityTypeLabel,
  describeActor,
  groupActivityByDay,
  isActivityEventType,
} from "./activity-feed-model";
import { useEmployeeActivity } from "./employee-api";
import { EMPLOYEE_EMPTY_STATES } from "./employee-copy";
import { activityTone } from "./employee-view-model";
import { ReferenceSelect } from "./reference-select";

export interface EmployeeActivityTabProps {
  employeeId: string;
}

/** Operational events for one employee (`GET /api/employees/:id/activity`), newest first, grouped by day. */
export function EmployeeActivityTab({ employeeId }: EmployeeActivityTabProps) {
  const ids = useId();
  const [type, setType] = useState<ActivityEventType | null>(null);
  const organisation = useCurrentOrganisation();
  const timeZone = organisation.data?.organisation.timezone;
  const dateFormat = organisation.data?.organisation.dateFormat;
  const query = useEmployeeActivity(employeeId, type ? { type: [type] } : {});

  const events = query.data?.pages.flatMap((page) => page.items) ?? [];
  const groups = groupActivityByDay(events, timeZone);

  return (
    <SectionCard
      title="Activity"
      description="Operational events only: joining, setup, Work Mode starting and ending, breaks and syncs. Never what the employee does on their phone."
      actions={
        <div className="flex items-center gap-2">
          <Label htmlFor={`${ids}-type`} className="sr-only">
            Filter by event type
          </Label>
          <ReferenceSelect
            id={`${ids}-type`}
            value={type ?? ""}
            onChange={(next) => setType(isActivityEventType(next) ? next : null)}
            options={ACTIVITY_TYPE_OPTIONS}
            noneLabel="All event types"
            className="h-9 w-56"
          />
        </div>
      }
    >
      {query.isError ? (
        <ErrorState
          size="sm"
          title="Couldn't load activity"
          error={query.error}
          onRetry={() => void query.refetch()}
          isRetrying={query.isRefetching}
        />
      ) : query.isPending ? (
        <ol className="space-y-4" aria-busy="true" aria-label="Loading activity">
          {Array.from({ length: 5 }, (_, i) => (
            <li key={i} className="flex gap-3">
              <Skeleton className="mt-1 size-2.5 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            </li>
          ))}
        </ol>
      ) : events.length === 0 ? (
        <EmptyState
          icon={EMPLOYEE_EMPTY_STATES.activity.icon}
          title={type ? "No events of this type" : EMPLOYEE_EMPTY_STATES.activity.title}
          description={
            type
              ? `Nothing recorded as “${activityTypeLabel(type)}” yet.`
              : EMPLOYEE_EMPTY_STATES.activity.description
          }
          size="sm"
          bordered={false}
          headingLevel={3}
          action={
            type ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setType(null)}>
                Show all events
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section
              key={group.day}
              aria-label={formatDate(group.at, { timeZone, dateFormat })}
              className="space-y-3"
            >
              <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                {formatDate(group.at, { timeZone, dateFormat })}
              </h3>
              <ol className="relative space-y-4 border-l pl-5">
                {group.events.map((event) => (
                  <ActivityRow key={event.id} event={event} timeZone={timeZone} />
                ))}
              </ol>
            </section>
          ))}
          {query.hasNextPage ? (
            <div className="flex justify-center">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
              >
                {query.isFetchingNextPage ? "Loading…" : "Load older events"}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}

function ActivityRow({ event, timeZone }: { event: ActivityEvent; timeZone: string | undefined }) {
  const tone = activityTone(event.type);
  return (
    <li className="relative">
      <span
        className={cn(
          "ring-background absolute top-1.5 -left-[1.6rem] size-2.5 rounded-full ring-4",
          TONE_DOT_CLASSES[tone],
        )}
        aria-hidden="true"
      />
      <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
        <p className="text-sm">{event.summary}</p>
        <p className="text-muted-foreground shrink-0 text-xs tabular-nums">
          <time dateTime={event.occurredAt}>{formatTime(event.occurredAt, { timeZone })}</time>
          {" · "}
          <RelativeTime value={event.occurredAt} timeZone={timeZone} />
        </p>
      </div>
      <p className="text-muted-foreground text-xs">
        {activityTypeLabel(event.type)} · {describeActor(event)}
      </p>
    </li>
  );
}
