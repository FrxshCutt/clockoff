"use client";

import type { Employee } from "@workmode/validation/employees";
import type { DeviceStatus } from "@workmode/validation/refs";
import { StatusBadge } from "@/components/status/status-badge";
import { getStatusMeta } from "@/components/status/statusMeta";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDateTimeLong } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface DeviceStatusBadgeProps {
  status: DeviceStatus | null;
  size?: "sm" | "md";
  /** Zone for the "since" tooltip time. */
  timeZone?: string;
  /** Rendered when there is no device badge (e.g. before the employee has a device). Default "—". */
  fallback?: React.ReactNode;
  className?: string;
}

/**
 * The derived device/work badge (§9) with its reason in a tooltip (hover and keyboard focus) and for screen
 * readers. Falls back to the enum description when the API gives no reason.
 */
export function DeviceStatusBadge({
  status,
  size = "md",
  timeZone,
  fallback = "—",
  className,
}: DeviceStatusBadgeProps) {
  if (!status)
    return <span className={cn("text-muted-foreground text-sm", className)}>{fallback}</span>;
  const meta = getStatusMeta("deviceStatus", status.badge);
  const reason = status.reason?.trim() || meta.description;
  const since = status.since ? `Since ${formatDateTimeLong(status.since, { timeZone })}.` : null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={cn(
            "focus-visible:ring-ring/50 inline-flex rounded-full outline-none focus-visible:ring-[3px]",
            className,
          )}
        >
          <StatusBadge kind="deviceStatus" value={status.badge} size={size} describe={false} />
          <span className="sr-only">
            : {reason}
            {since ? ` ${since}` : ""}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <p>{reason}</p>
        {since ? <p className="mt-1 opacity-80">{since}</p> : null}
      </TooltipContent>
    </Tooltip>
  );
}

export interface EmployeeStatusBadgesProps {
  employee: Pick<Employee, "inviteStatus" | "deviceStatus" | "employmentStatus">;
  size?: "sm" | "md";
  timeZone?: string;
  /** Show the "Inactive" employment badge when it adds information (default true). */
  showEmployment?: boolean;
  className?: string;
}

/**
 * Lifecycle badge + device/work badge (with reason tooltip) + employment badge when the employee is
 * inactive but the lifecycle badge does not already say so. Shared by the list, detail header and pickers.
 */
export function EmployeeStatusBadges({
  employee,
  size = "md",
  timeZone,
  showEmployment = true,
  className,
}: EmployeeStatusBadgesProps) {
  const showInactive =
    showEmployment &&
    employee.employmentStatus === "INACTIVE" &&
    employee.inviteStatus !== "DEACTIVATED";
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <StatusBadge kind="inviteStatus" value={employee.inviteStatus} size={size} />
      {employee.deviceStatus ? (
        <DeviceStatusBadge status={employee.deviceStatus} size={size} timeZone={timeZone} />
      ) : null}
      {showInactive ? (
        <Badge
          variant="outline"
          className={cn("font-medium", size === "sm" ? "h-5 text-[11px]" : "h-6 text-xs")}
          title="Employment is inactive"
        >
          Inactive
        </Badge>
      ) : null}
    </div>
  );
}
