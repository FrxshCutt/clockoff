"use client";

import { Bell } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { EMPTY_STATES } from "@/config/emptyStates";
import { useNotifications } from "@/hooks/use-notifications";
import { getErrorMessage } from "@/lib/errorMessages";
import { cn } from "@/lib/utils";

/** Bell with unread badge and a popover of recent in-app notifications (`GET /api/notifications`). */
export function NotificationsBell() {
  const { data, isPending, isError, error } = useNotifications();
  const unread = data?.unreadCount ?? 0;
  const badge = unread > 9 ? "9+" : String(unread);
  const label = unread > 0 ? `Notifications, ${unread} unread` : "Notifications";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={label}>
          <Bell aria-hidden="true" />
          {unread > 0 ? (
            <span
              className="bg-primary text-primary-foreground ring-background absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-semibold tabular-nums ring-2"
              aria-hidden="true"
            >
              {badge}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))] p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Notifications</h2>
          {unread > 0 ? <span className="text-muted-foreground text-xs">{unread} unread</span> : null}
        </div>
        {isPending ? (
          <div className="space-y-3 p-4" aria-busy="true">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : isError ? (
          <p className="text-muted-foreground p-4 text-sm" role="alert">
            {getErrorMessage(error)}
          </p>
        ) : data && data.items.length > 0 ? (
          <div className="max-h-96 overflow-y-auto">
            <ul className="divide-y">
              {data.items.map((item) => (
                <li key={item.id} className={cn("px-4 py-3", item.readAt === null && "bg-primary/5")}>
                  <div className="flex items-start gap-2">
                    {item.readAt === null ? (
                      <span className="bg-primary mt-1.5 size-2 shrink-0 rounded-full" aria-label="Unread" role="img" />
                    ) : null}
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="text-sm font-medium">{item.title}</p>
                      <p className="text-muted-foreground text-sm">{item.body}</p>
                      <RelativeTime value={item.createdAt} className="text-muted-foreground text-xs" />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <EmptyState
            icon={EMPTY_STATES.notifications.icon}
            title={EMPTY_STATES.notifications.title}
            description={EMPTY_STATES.notifications.description}
            size="sm"
            bordered={false}
            headingLevel={3}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
