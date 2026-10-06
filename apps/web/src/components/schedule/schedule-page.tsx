"use client";

import type { Shift } from "@workmode/validation/shifts";
import type { LocalDateString } from "@workmode/shared/time/time";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { PageHeader } from "@/components/page-header";
import { TableSkeleton } from "@/components/loading-skeletons";
import { Button } from "@/components/ui/button";
import { EMPTY_STATES } from "@/config/emptyStates";
import { useApiErrorToast } from "@/hooks/use-api-error-toast";
import { useCurrentMembership, usePermission } from "@/hooks/use-current-user";
import { useCurrentOrganisation } from "@/hooks/use-organisation";
import { DayView, DayViewSkeleton } from "./day-view";
import { EmployeePicker, type EmployeeRef } from "./employee-picker";
import { EmployeeView } from "./employee-view";
import {
  computeRange,
  employeeName,
  navigateDate,
  parseScheduleParams,
  planShiftMove,
  scheduleParamsToSearch,
  todayIn,
  visibleShifts,
  type RawSearchParams,
  type ScheduleParams,
} from "./schedule-model";
import { useEmployee, useShifts, useUpdateShift } from "./schedule-queries";
import { ScheduleToolbar } from "./schedule-toolbar";
import { ShiftDrawer, type ShiftDrawerState } from "./shift-drawer";
import { WeekView, WeekViewSkeleton } from "./week-view";

export interface SchedulePageProps {
  /** The page's raw `searchParams`, parsed on the client once the organisation timezone is known. */
  initialSearch: RawSearchParams;
}

/**
 * /schedule. State (view, date, filters) lives in component state and is mirrored to the URL with
 * `history.replaceState` so links and reloads land on the same week. Times are shown in the organisation's
 * timezone (from the current membership).
 */
export function SchedulePage({ initialSearch }: SchedulePageProps) {
  const membership = useCurrentMembership();
  const timezone = membership?.timezone ?? "UTC";
  const organisation = useCurrentOrganisation();
  const canEdit = usePermission("schedule:write");
  const canImport = usePermission("imports:write");
  const toastError = useApiErrorToast();

  const today = useMemo(() => todayIn(timezone), [timezone]);
  const [params, setParams] = useState<ScheduleParams>(() => parseScheduleParams(initialSearch, today));

  // Mirror state → URL (skipping the first render, whose URL is what we parsed).
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const search = scheduleParamsToSearch(params, today);
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}${window.location.hash}`);
  }, [params, today]);

  const update = useCallback((patch: Partial<ScheduleParams>) => setParams((current) => ({ ...current, ...patch })), []);

  const weekStartsOn = organisation.data?.organisation.settings.weekStartsOn;
  const dateFormat = organisation.data?.organisation.dateFormat ?? "DMY";
  const range = useMemo(() => computeRange(params.view, params.date, timezone, weekStartsOn), [params.view, params.date, timezone, weekStartsOn]);

  const shiftsQuery = useShifts(
    organisation.isPending
      ? null
      : { from: range.from.toISOString(), to: range.to.toISOString(), employeeId: params.employeeId, locationId: params.locationId },
  );
  const allShifts = useMemo(() => shiftsQuery.data ?? [], [shiftsQuery.data]);
  const shifts = useMemo(() => visibleShifts(allShifts, { showCancelled: params.showCancelled }), [allShifts, params.showCancelled]);

  const filteredEmployee = useEmployee(params.employeeId);
  const pinnedEmployee = filteredEmployee.data
    ? { id: filteredEmployee.data.id, firstName: filteredEmployee.data.firstName, lastName: filteredEmployee.data.lastName, jobTitle: filteredEmployee.data.jobTitle, name: employeeName(filteredEmployee.data) }
    : null;
  const selectedEmployeeRef: EmployeeRef | null = filteredEmployee.data ?? null;

  const [drawer, setDrawer] = useState<ShiftDrawerState>({ mode: "closed" });
  const openCreate = (input?: { employeeId?: string; date?: LocalDateString }) =>
    setDrawer({
      mode: "create",
      date: input?.date ?? (params.view === "day" ? params.date : today >= range.startDate && today <= range.endDate ? today : range.startDate),
      employeeId: input?.employeeId ?? params.employeeId,
      employee: input?.employeeId ? null : selectedEmployeeRef,
      locationId: params.locationId,
    });
  const openEdit = (shift: Shift) => setDrawer({ mode: "edit", shift });

  const updateShift = useUpdateShift();
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const onMoveShift = (shift: Shift, fromDay: LocalDateString, toDay: LocalDateString) => {
    const plan = planShiftMove(shift, fromDay, toDay);
    if (!plan) return;
    setPendingIds((current) => new Set([...current, shift.id]));
    updateShift.mutate(
      { id: shift.id, input: plan.patch, optimistic: plan.optimistic },
      {
        onSuccess: () => toast.success(`Moved ${employeeName(shift.employee)}'s shift ${plan.deltaDays > 0 ? "forward" : "back"} ${Math.abs(plan.deltaDays)} ${Math.abs(plan.deltaDays) === 1 ? "day" : "days"}`),
        onError: (error) => toastError(error, { title: "Couldn't move the shift" }),
        onSettled: () =>
          setPendingIds((current) => {
            const next = new Set(current);
            next.delete(shift.id);
            return next;
          }),
      },
    );
  };

  const isLoading = organisation.isPending || (shiftsQuery.isPending && !shiftsQuery.data);
  const isEmpty = !isLoading && !shiftsQuery.isError && shifts.length === 0 && !pinnedEmployee;

  const addShiftButton = canEdit ? (
    <Button type="button" variant="outline" onClick={() => openCreate()}>
      <Plus aria-hidden="true" />
      Add Shift
    </Button>
  ) : undefined;

  let body: ReactNode;
  if (shiftsQuery.isError) {
    body = <ErrorState title="Couldn't load the schedule" error={shiftsQuery.error} onRetry={() => void shiftsQuery.refetch()} isRetrying={shiftsQuery.isRefetching} />;
  } else if (isLoading) {
    body = params.view === "week" ? <WeekViewSkeleton /> : params.view === "day" ? <DayViewSkeleton /> : <TableSkeleton rows={6} columns={6} />;
  } else if (params.view === "employee") {
    body = (
      <EmployeeView
        employeeId={params.employeeId}
        shifts={shifts}
        isLoading={false}
        timezone={timezone}
        dateFormat={dateFormat}
        onOpenShift={openEdit}
        emptyAction={addShiftButton}
        picker={<EmployeePicker value={params.employeeId} selected={selectedEmployeeRef} onChange={(employee) => update({ employeeId: employee?.id ?? null })} placeholder="Choose an employee" />}
      />
    );
  } else if (isEmpty) {
    body = (
      <EmptyState
        icon={EMPTY_STATES.schedule.icon}
        title={EMPTY_STATES.schedule.title}
        description={EMPTY_STATES.schedule.description}
        action={
          canImport && EMPTY_STATES.schedule.action.href ? (
            <Button asChild>
              <Link href={EMPTY_STATES.schedule.action.href}>{EMPTY_STATES.schedule.action.label}</Link>
            </Button>
          ) : undefined
        }
        secondaryAction={addShiftButton}
      >
        <p className="text-muted-foreground text-xs">Nothing scheduled between these dates. Use the arrows to look at another week.</p>
      </EmptyState>
    );
  } else if (params.view === "week") {
    body = (
      <WeekView
        days={range.days}
        shifts={shifts}
        timezone={timezone}
        today={today}
        canEdit={canEdit}
        onOpenShift={openEdit}
        onAddShift={({ employeeId, date }) => openCreate({ employeeId, date })}
        onMoveShift={onMoveShift}
        pendingShiftIds={pendingIds}
        pinnedEmployee={pinnedEmployee}
      />
    );
  } else {
    body = (
      <DayView
        day={params.date}
        shifts={shifts}
        timezone={timezone}
        canEdit={canEdit}
        onOpenShift={openEdit}
        onAddShift={({ employeeId, date }) => openCreate({ employeeId, date })}
        pendingShiftIds={pendingIds}
        pinnedEmployee={pinnedEmployee}
      />
    );
  }

  return (
    <>
      <PageHeader title="Schedule" description="Shifts switch Work Mode on and off automatically on each employee's phone." />
      <div className="space-y-6">
        <ScheduleToolbar
          params={params}
          range={range}
          today={today}
          timezone={timezone}
          weekStartsOn={weekStartsOn}
          canEdit={canEdit}
          canImport={canImport}
          selectedEmployee={selectedEmployeeRef}
          onChange={update}
          onNavigate={(direction) => update({ date: navigateDate(params.view, params.date, direction) })}
          onAddShift={() => openCreate()}
        />
        <div aria-busy={shiftsQuery.isFetching || undefined}>{body}</div>
      </div>
      <ShiftDrawer state={drawer} onClose={() => setDrawer({ mode: "closed" })} organisationTimezone={timezone} canEdit={canEdit} knownShifts={allShifts} />
    </>
  );
}
