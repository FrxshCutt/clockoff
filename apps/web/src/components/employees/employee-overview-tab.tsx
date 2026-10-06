"use client";

import { DEVICE_STATUS_THRESHOLDS } from "@workmode/shared/status/deriveDeviceStatus";
import type { EmployeeDetail, EmployeeStateResponse } from "@workmode/validation/employees";
import {
  CalendarClock,
  Circle,
  CircleCheck,
  Coffee,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { ErrorState } from "@/components/error-state";
import { InlineAlert } from "@/components/inline-alert";
import { RelativeTime } from "@/components/relative-time";
import { SectionCard } from "@/components/section";
import { StatusBadge } from "@/components/status/status-badge";
import { TONE_CLASSES, TONE_DOT_CLASSES } from "@/components/status/statusMeta";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { routeFor } from "@/config/navigation";
import { useCurrentOrganisation } from "@/hooks/use-organisation";
import {
  formatDateTime,
  formatDurationMinutes,
  formatNumber,
  formatTime,
  humanizeEnum,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { useEmployeeState } from "./employee-api";
import { DeviceStatusBadge } from "./employee-status-badges";
import {
  buildSetupChecklist,
  buildTodayTimeline,
  describeExpectedVsReported,
  describeNextShift,
  permissionGuidance,
  type TimelineEntry,
} from "./employee-view-model";
import { useNow } from "./use-now";

export interface EmployeeOverviewTabProps {
  employee: EmployeeDetail;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

/** Connection, Permissions, Setup, Sync and Today cards for the employee detail page. */
export function EmployeeOverviewTab({ employee }: EmployeeOverviewTabProps) {
  const organisation = useCurrentOrganisation();
  const timeZone = organisation.data?.organisation.timezone;
  const dateFormat = organisation.data?.organisation.dateFormat;
  const device = employee.device && employee.device.isActive ? employee.device : null;
  const guidance = permissionGuidance(device);
  const checklist = buildSetupChecklist(employee);
  const state = useEmployeeState(employee.id, null);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <SectionCard
        title={
          <span className="flex items-center gap-2">
            <Smartphone className="text-muted-foreground size-4" aria-hidden="true" />
            Connection
          </span>
        }
        description="Whether the employee has joined and their phone is connected."
      >
        <dl className="space-y-4">
          <Fact label="Status">
            <span className="flex flex-wrap items-center gap-1.5">
              <StatusBadge kind="inviteStatus" value={employee.inviteStatus} size="sm" />
              <DeviceStatusBadge
                status={employee.deviceStatus}
                size="sm"
                timeZone={timeZone}
                fallback={null}
              />
            </span>
          </Fact>
          {device ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Fact label="Device">{device.deviceModel ?? "iPhone"}</Fact>
                <Fact label="Platform">
                  {device.platform === "IOS"
                    ? `iOS ${device.osVersion ?? ""}`.trim()
                    : humanizeEnum(device.platform)}
                </Fact>
                <Fact label="App version">{device.appVersion ?? <Muted>Unknown</Muted>}</Fact>
                <Fact label="Last seen">
                  {device.lastSeenAt ? (
                    <RelativeTime value={device.lastSeenAt} timeZone={timeZone} />
                  ) : (
                    <Muted>Never</Muted>
                  )}
                </Fact>
              </div>
              <Fact label="Push">
                {device.hasPushToken ? (
                  "Silent sync pushes enabled"
                ) : (
                  <Muted>No push token registered — the app syncs when opened</Muted>
                )}
              </Fact>
            </>
          ) : employee.device && !employee.device.isActive ? (
            <InlineAlert variant="info" title="Previous device deactivated">
              Deactivated {formatDateTime(employee.device.deactivatedAt, { timeZone, dateFormat })}.
              The employee must join again from the app.
            </InlineAlert>
          ) : (
            <p className="text-muted-foreground text-sm">
              No device yet. Device details appear once the employee joins from the Work Mode app on
              their iPhone.
            </p>
          )}
        </dl>
      </SectionCard>

      <SectionCard
        title={
          <span className="flex items-center gap-2">
            <ShieldCheck className="text-muted-foreground size-4" aria-hidden="true" />
            Permissions
          </span>
        }
        description="Screen Time authorisation and whether apps have been selected. Which apps is never shared."
      >
        {!guidance || !device ? (
          <p className="text-muted-foreground text-sm">
            Permission details appear once a device is connected.
          </p>
        ) : (
          <dl className="space-y-5">
            <div className="space-y-1.5">
              <Fact label="Screen Time authorisation">
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      "size-2 rounded-full",
                      TONE_DOT_CLASSES[guidance.permission.tone],
                    )}
                    aria-hidden="true"
                  />
                  {guidance.permission.label}
                </span>
              </Fact>
              <p className="text-muted-foreground text-xs text-pretty">
                {guidance.permission.guidance}
              </p>
            </div>
            <div className="space-y-1.5">
              <Fact label="App selection">
                <span className="flex items-center gap-2">
                  <span
                    className={cn("size-2 rounded-full", TONE_DOT_CLASSES[guidance.selection.tone])}
                    aria-hidden="true"
                  />
                  {guidance.selection.label}
                  {device.selectionState === "CONFIGURED" ? (
                    <span className="text-muted-foreground text-xs">
                      {formatNumber(device.selectionCounts.categories)} categories ·{" "}
                      {formatNumber(device.selectionCounts.applications)} apps ·{" "}
                      {formatNumber(device.selectionCounts.webDomains)} websites
                    </span>
                  ) : null}
                </span>
              </Fact>
              <p className="text-muted-foreground text-xs text-pretty">
                {guidance.selection.guidance}
              </p>
            </div>
          </dl>
        )}
      </SectionCard>

      <SectionCard
        title={
          <span className="flex items-center gap-2">
            <CircleCheck className="text-muted-foreground size-4" aria-hidden="true" />
            Setup
          </span>
        }
        description="Where the employee is on the way to a connected phone."
      >
        <ol className="space-y-3">
          {checklist.map((step) => (
            <li key={step.key} className="flex gap-3">
              {step.done ? (
                <CircleCheck
                  className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                  aria-hidden="true"
                />
              ) : (
                <Circle
                  className="text-muted-foreground/60 mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
              )}
              <div className="min-w-0 space-y-0.5">
                <p className={cn("text-sm font-medium", step.done ? "" : "text-muted-foreground")}>
                  {step.label}
                  <span className="sr-only">{step.done ? " (done)" : " (not done)"}</span>
                </p>
                <p className="text-muted-foreground text-xs text-pretty">{step.hint}</p>
              </div>
            </li>
          ))}
        </ol>
      </SectionCard>

      <SectionCard
        title={
          <span className="flex items-center gap-2">
            <RefreshCw className="text-muted-foreground size-4" aria-hidden="true" />
            Sync
          </span>
        }
        description="When the phone last checked in and picked up its policy and schedule."
      >
        {!device ? (
          <p className="text-muted-foreground text-sm">
            Sync times appear once a device is connected.
          </p>
        ) : (
          <dl className="grid gap-4 sm:grid-cols-2">
            <Fact label="Device sync">
              {device.lastDeviceSyncAt ? (
                <RelativeTime value={device.lastDeviceSyncAt} timeZone={timeZone} />
              ) : (
                <Muted>Never</Muted>
              )}
            </Fact>
            <Fact label="Policy sync">
              {device.lastPolicySyncAt ? (
                <RelativeTime value={device.lastPolicySyncAt} timeZone={timeZone} />
              ) : (
                <Muted>Never</Muted>
              )}
              {device.policyVersionNumber !== null ? (
                <span className="text-muted-foreground text-xs">
                  {" "}
                  · version {device.policyVersionNumber}
                </span>
              ) : null}
            </Fact>
            <Fact label="Schedule sync">
              {device.lastScheduleSyncAt ? (
                <RelativeTime value={device.lastScheduleSyncAt} timeZone={timeZone} />
              ) : (
                <Muted>Never</Muted>
              )}
              <span className="text-muted-foreground text-xs">
                {" "}
                · schedule v{device.scheduleVersion}
              </span>
            </Fact>
            <Fact label="Device clock">
              {device.lastClockSkewSeconds === null ? (
                <Muted>Not reported</Muted>
              ) : Math.abs(device.lastClockSkewSeconds) >
                DEVICE_STATUS_THRESHOLDS.clockSkewSeconds ? (
                <span className="text-amber-700 dark:text-amber-400">
                  {Math.abs(device.lastClockSkewSeconds)} s{" "}
                  {device.lastClockSkewSeconds > 0 ? "ahead" : "behind"} — ask the employee to
                  enable automatic date &amp; time
                </span>
              ) : (
                "In sync"
              )}
              {device.timezone ? (
                <span className="text-muted-foreground text-xs"> · {device.timezone}</span>
              ) : null}
            </Fact>
          </dl>
        )}
      </SectionCard>

      <div className="lg:col-span-2">
        <TodayCard employee={employee} state={state} timeZone={timeZone} />
      </div>
    </div>
  );
}

function TodayCard({
  employee,
  state,
  timeZone,
}: {
  employee: EmployeeDetail;
  state: ReturnType<typeof useEmployeeState>;
  timeZone: string | undefined;
}) {
  const now = useNow();
  const data: EmployeeStateResponse | undefined = state.data;

  return (
    <SectionCard
      title={
        <span className="flex items-center gap-2">
          <CalendarClock className="text-muted-foreground size-4" aria-hidden="true" />
          Today
        </span>
      }
      description="The current shift, what Work Mode should be doing right now versus what the phone reports, and the day's events."
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link href={`${routeFor.employee(employee.id)}?tab=schedule`}>Schedule</Link>
        </Button>
      }
    >
      {state.isError ? (
        <ErrorState
          size="sm"
          title="Couldn't load today's status"
          error={state.error}
          onRetry={() => void state.refetch()}
          isRetrying={state.isRefetching}
        />
      ) : !data || now === null ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]" aria-busy="true">
          <div className="space-y-3">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
          <div className="space-y-3">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        </div>
      ) : (
        <TodayBody data={data} now={now} timeZone={timeZone} />
      )}
    </SectionCard>
  );
}

function TodayBody({
  data,
  now,
  timeZone,
}: {
  data: EmployeeStateResponse;
  now: number;
  timeZone: string | undefined;
}) {
  const shiftRef = data.expected.activeShift ?? data.expected.upcomingShift;
  const shiftTz = data.activeShift?.timezone ?? data.expected.timezone ?? timeZone;
  const shift = shiftRef
    ? describeNextShift(
        { startsAt: shiftRef.startsAt, endsAt: shiftRef.endsAt, timezone: shiftTz ?? "UTC" },
        now,
      )
    : null;
  const comparison = describeExpectedVsReported(data);
  const timeline = buildTodayTimeline(data, now);
  const activeBreak = data.activeBreak;
  const allowance = data.breakAllowance;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <dl className="space-y-5">
        <Fact label={shift?.isActive ? "Current shift" : "Next shift"}>
          {shift && shiftRef ? (
            <span>
              {shift.primary}, <span className="tabular-nums">{shift.range}</span>
              {data.activeShift?.location ? (
                <span className="text-muted-foreground"> · {data.activeShift.location.name}</span>
              ) : null}
            </span>
          ) : (
            <Muted>No shift scheduled soon</Muted>
          )}
        </Fact>
        <Fact label="Expected right now">
          <span className="flex flex-wrap items-center gap-1.5">
            <StatusBadge kind="workModeState" value={data.expected.state} size="sm" />
            <span className="text-muted-foreground text-xs">
              {data.expected.effectiveRestriction === "WORK"
                ? "Restrictions on"
                : data.expected.effectiveRestriction === "BREAK_RELAXED"
                  ? "Restrictions relaxed"
                  : "No restrictions"}
            </span>
          </span>
        </Fact>
        <Fact label="Phone reports">
          <span className="flex flex-wrap items-center gap-1.5">
            {comparison.reported ? (
              <StatusBadge kind="workModeState" value={comparison.reported} size="sm" />
            ) : (
              <Muted>Nothing yet</Muted>
            )}
            {comparison.reportedAt ? (
              <span className="text-muted-foreground text-xs">
                <RelativeTime value={comparison.reportedAt} timeZone={timeZone} />
              </span>
            ) : null}
          </span>
          <p
            className={cn(
              "mt-1 text-xs text-pretty",
              comparison.diverged ? "text-red-700 dark:text-red-400" : "text-muted-foreground",
            )}
          >
            {comparison.summary}
          </p>
        </Fact>
        {activeBreak ? (
          <Fact label="Break in progress">
            <span className="flex items-center gap-1.5">
              <Coffee className="text-muted-foreground size-4" aria-hidden="true" />
              Started {formatTime(activeBreak.startedAt, { timeZone: shiftTz })}, ends{" "}
              {formatTime(activeBreak.plannedEndsAt, { timeZone: shiftTz })}
            </span>
          </Fact>
        ) : null}
        {allowance ? (
          <Fact label="Break allowance this shift">
            {allowance.breaksTaken} taken · {allowance.breaksRemaining} left ·{" "}
            {formatDurationMinutes(allowance.minutesRemaining)} remaining
            {allowance.nextEligibleAt && !allowance.canStartNow ? (
              <span className="text-muted-foreground text-xs">
                {" "}
                · next from {formatTime(allowance.nextEligibleAt, { timeZone: shiftTz })}
              </span>
            ) : null}
          </Fact>
        ) : null}
        {data.activeOverrides.length > 0 ? (
          <Fact label="Active overrides">
            <ul className="space-y-1">
              {data.activeOverrides.map((override) => (
                <li key={override.id} className="flex items-center gap-1.5 text-sm">
                  <KeyRound className="text-muted-foreground size-3.5" aria-hidden="true" />
                  {humanizeEnum(override.type)}
                  <span className="text-muted-foreground text-xs">
                    until {formatTime(override.expiresAt, { timeZone })}
                  </span>
                </li>
              ))}
            </ul>
          </Fact>
        ) : null}
      </dl>

      <section aria-label="Today's timeline" className="space-y-3">
        <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Timeline
        </h3>
        {timeline.length <= 1 ? (
          <p className="text-muted-foreground text-sm">
            Nothing has happened in the last 24 hours.
          </p>
        ) : (
          <ol className="relative space-y-3 border-l pl-5">
            {timeline.map((entry) => (
              <TimelineRow key={entry.id} entry={entry} timeZone={timeZone} />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function TimelineRow({ entry, timeZone }: { entry: TimelineEntry; timeZone: string | undefined }) {
  const isNow = entry.kind === "now";
  return (
    <li className={cn("relative", entry.isFuture && "opacity-70")}>
      <span
        className={cn(
          "ring-background absolute top-1.5 -left-[1.6rem] size-2.5 rounded-full ring-4",
          isNow ? "bg-primary ring-primary/20 animate-pulse" : TONE_DOT_CLASSES[entry.tone],
          entry.isFuture && !isNow && "bg-transparent ring-1 ring-current",
        )}
        aria-hidden="true"
      />
      <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
        <p className={cn("text-sm", isNow && "font-semibold")}>
          {entry.title}
          {entry.kind !== "event" && !isNow ? (
            <Badge variant="outline" className={cn("ml-2 font-normal", TONE_CLASSES[entry.tone])}>
              {entry.kind === "nextTransition"
                ? "expected"
                : entry.isFuture
                  ? "scheduled"
                  : "shift"}
            </Badge>
          ) : null}
        </p>
        <time dateTime={entry.at} className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {formatTime(entry.at, { timeZone })}
        </time>
      </div>
      {entry.detail ? (
        <p className="text-muted-foreground text-xs text-pretty">{entry.detail}</p>
      ) : null}
    </li>
  );
}
