"use client";

import type { ActivityEvent } from "@workmode/validation/activity";
import {
  Activity,
  CalendarClock,
  CircleCheck,
  CirclePause,
  CircleX,
  Coffee,
  FileUp,
  Hourglass,
  KeyRound,
  Pencil,
  Plug,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Smartphone,
  TriangleAlert,
  UserCheck,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { RelativeTime } from "@/components/relative-time";
import { TONE_CLASSES } from "@/components/status/statusMeta";
import { Skeleton } from "@/components/ui/skeleton";
import { routeFor } from "@/config/navigation";
import { cn } from "@/lib/utils";
import { activityEventMeta, activityText, type ActivityIcon } from "./activity-meta";

/** Lucide component for each icon key in `activity-meta.ts` (exhaustive by type). */
export const ACTIVITY_ICON_COMPONENTS: Record<ActivityIcon, LucideIcon> = {
  "user-check": UserCheck,
  "circle-check": CircleCheck,
  "shield-check": ShieldCheck,
  "shield-alert": ShieldAlert,
  smartphone: Smartphone,
  "shield-off": ShieldOff,
  coffee: Coffee,
  "circle-pause": CirclePause,
  hourglass: Hourglass,
  calendar: CalendarClock,
  refresh: RefreshCw,
  "wifi-off": WifiOff,
  pencil: Pencil,
  "circle-x": CircleX,
  key: KeyRound,
  plug: Plug,
  "file-up": FileUp,
  "triangle-alert": TriangleAlert,
  activity: Activity,
};

export interface ActivityItemProps {
  event: ActivityEvent;
  /** Zone for the absolute time tooltip; defaults to the viewer's. */
  timeZone?: string;
  /** Hide the employee link (e.g. on that employee's own page). */
  hideEmployee?: boolean;
  className?: string;
}

/**
 * One feed entry: a toned icon for the event type, the plain-English sentence, and a meta line with the
 * type label, the employee (linked), the acting manager and a live relative time.
 */
export function ActivityItem({
  event,
  timeZone,
  hideEmployee = false,
  className,
}: ActivityItemProps) {
  const meta = activityEventMeta(event.type);
  const Icon = ACTIVITY_ICON_COMPONENTS[meta.icon];
  const employeeName = event.employee
    ? `${event.employee.firstName} ${event.employee.lastName}`.trim()
    : null;
  const actor = event.actorType === "MANAGER" && event.actor ? event.actor.name : null;

  return (
    <li className={cn("flex gap-3 py-3", className)} data-event-type={event.type}>
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border",
          TONE_CLASSES[meta.tone],
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-foreground text-sm leading-5 text-pretty">{activityText(event)}</p>
        <p className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 text-xs">
          <span className="font-medium">{meta.label}</span>
          {employeeName && event.employee && !hideEmployee ? (
            <>
              <span aria-hidden="true">·</span>
              <Link
                href={routeFor.employee(event.employee.id)}
                className="hover:text-foreground focus-visible:ring-ring/50 rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2"
              >
                {employeeName}
              </Link>
            </>
          ) : null}
          {actor ? (
            <>
              <span aria-hidden="true">·</span>
              <span>by {actor}</span>
            </>
          ) : null}
          <span aria-hidden="true">·</span>
          <RelativeTime value={event.occurredAt} timeZone={timeZone} />
        </p>
      </div>
    </li>
  );
}

export interface ActivityListProps {
  events: readonly ActivityEvent[];
  timeZone?: string;
  hideEmployee?: boolean;
  /** Accessible name for the list. */
  label?: string;
  className?: string;
}

export function ActivityList({
  events,
  timeZone,
  hideEmployee,
  label = "Activity",
  className,
}: ActivityListProps) {
  return (
    <ul aria-label={label} className={cn("divide-border divide-y", className)}>
      {events.map((event) => (
        <ActivityItem
          key={event.id}
          event={event}
          timeZone={timeZone}
          hideEmployee={hideEmployee}
        />
      ))}
    </ul>
  );
}

export function ActivityListSkeleton({
  rows = 5,
  className,
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div className={cn("divide-border divide-y", className)} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex gap-3 py-3">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className={cn("h-4", i % 2 === 0 ? "w-3/4" : "w-1/2")} />
            <Skeleton className="h-3 w-40" />
          </div>
        </div>
      ))}
    </div>
  );
}
